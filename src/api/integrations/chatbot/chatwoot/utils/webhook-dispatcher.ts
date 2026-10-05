import { randomUUID } from 'node:crypto';

import { SerialQueue } from './serial-queue';

/** Um webhook do Chatwoot aceito e ainda não processado. */
export type WebhookJob = {
  /** Identidade do evento: repetições do mesmo evento têm o mesmo id. */
  id: string;
  instanceName: string;
  /** Chave de ordenação: webhooks da mesma conversa rodam em série. */
  queueKey: string;
  body: any;
  receivedAt: number;
};

/** Onde os webhooks aceitos ficam até terminar, para sobreviver a um reinício. */
export interface WebhookJobStore {
  save(job: WebhookJob): Promise<void>;
  remove(job: WebhookJob): Promise<void>;
  /** Todos os pendentes gravados (inclusive de processos anteriores). */
  list(): Promise<WebhookJob[]>;
  markDone(job: WebhookJob): Promise<void>;
  isDone(job: WebhookJob): Promise<boolean>;
  isPending(job: WebhookJob): Promise<boolean>;
}

export type AcceptResult = 'accepted' | 'duplicate' | 'stopping';

type DispatcherOptions = {
  store: WebhookJobStore;
  /** Processa o webhook. Erros vão para onError; o job é concluído de qualquer forma. */
  handle: (job: WebhookJob) => Promise<unknown>;
  /** Job que ficou velho demais para ser enviado (ex.: processo ficou fora do ar). */
  onExpired: (job: WebhookJob) => Promise<unknown>;
  onError: (context: string, error: unknown) => void;
  /** Se a instância já pode enviar; a recuperação espera por isso. */
  isReady: (instanceName: string) => boolean;
  /** Espera antes de processar, para absorver webhooks que chegam fora de ordem. */
  orderWindowMs?: number;
  /** Idade máxima para enviar uma mensagem recuperada; acima disso o atendente é avisado. */
  maxAgeMs?: number;
  recoveryPollMs?: number;
  now?: () => number;
};

const DEFAULT_ORDER_WINDOW_MS = 500;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
const DEFAULT_RECOVERY_POLL_MS = 5_000;

/** Eventos que representam uma mensagem: a identidade e a ordem vêm do id da mensagem. */
const MESSAGE_EVENTS = new Set(['message_created', 'message_updated']);

export function webhookJobId(body: any): string {
  if (MESSAGE_EVENTS.has(body?.event) && body?.id) {
    return `${body.event}-${body.id}`;
  }
  // Mudança de status e afins se repetem legitimamente: cada entrega é um evento novo.
  return `${body?.event ?? 'unknown'}-${randomUUID()}`;
}

export function webhookQueueKey(instanceName: string, body: any): string {
  // message_created traz a conversa em body.conversation.id; conversation_status_changed
  // envia a própria conversa na raiz, e cair num balde global serializaria conversas
  // distintas atrás umas das outras.
  const conversationId = body?.conversation?.id ?? body?.id ?? 'global';
  return `${instanceName}:${conversationId}`;
}

/**
 * Escolhe o próximo job de uma conversa. Mensagens novas saem pela ordem de criação no
 * Chatwoot (id crescente), não pela de chegada: o Sidekiq dispara os webhooks em paralelo
 * e dois envios seguidos podem chegar invertidos. Os demais eventos seguem a chegada.
 */
export function pickNextJob(jobs: WebhookJob[]): WebhookJob | undefined {
  if (!jobs.length) return undefined;

  const first = jobs[0];
  if (first.body?.event !== 'message_created') return first;

  return jobs
    .filter((job) => job.body?.event === 'message_created')
    .reduce((min, job) => (Number(job.body.id) < Number(min.body.id) ? job : min), first);
}

/**
 * Recebe os webhooks do Chatwoot fora do ciclo da requisição HTTP.
 *
 * O Chatwoot marca a mensagem como falha se a requisição passar do timeout (10s por
 * padrão), mesmo quando o envio deu certo; por isso a resposta sai na hora. Em troca, a
 * entrega passa a ser responsabilidade da Evolution, e este despachante garante:
 * - durabilidade: o job é gravado antes da resposta e só sai do store ao terminar, então
 *   um reinício no meio de uma rajada não perde mensagens (são retomadas ao subir);
 * - idempotência: o mesmo evento entregue duas vezes é processado uma vez;
 * - ordem: série por conversa, mensagens pelo id do Chatwoot;
 * - prazo: mensagem recuperada velha demais não é enviada fora de contexto, o atendente
 *   é avisado para reenviar;
 * - desligamento: para de aceitar e espera o que está em andamento.
 */
export class ChatwootWebhookDispatcher {
  private readonly queue: SerialQueue;
  private readonly mailboxes = new Map<string, WebhookJob[]>();
  /** Jobs deste processo ou já recuperados: a recuperação não os pega de novo. */
  private readonly known = new Set<string>();
  private readonly startedAt: number;
  private stopping = false;
  private recoveryTimer: NodeJS.Timeout | undefined;

  private readonly orderWindowMs: number;
  private readonly maxAgeMs: number;
  private readonly recoveryPollMs: number;
  private readonly now: () => number;

  constructor(private readonly options: DispatcherOptions) {
    this.orderWindowMs = options.orderWindowMs ?? DEFAULT_ORDER_WINDOW_MS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.recoveryPollMs = options.recoveryPollMs ?? DEFAULT_RECOVERY_POLL_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.queue = new SerialQueue((key, error) => options.onError(`fila ${key}`, error));
  }

  /** Aceita um webhook: grava e enfileira. Só depois disso a requisição pode responder. */
  public async accept(instanceName: string, body: any): Promise<AcceptResult> {
    if (this.stopping) return 'stopping';

    const job: WebhookJob = {
      id: webhookJobId(body),
      instanceName,
      queueKey: webhookQueueKey(instanceName, body),
      body,
      receivedAt: this.now(),
    };

    const storeKey = this.knownKey(job);
    if (this.known.has(storeKey)) return 'duplicate';
    // Marca antes de qualquer await: duas entregas simultâneas do mesmo evento não passam.
    this.known.add(storeKey);

    try {
      if ((await this.options.store.isDone(job)) || (await this.options.store.isPending(job))) {
        this.known.delete(storeKey);
        return 'duplicate';
      }
      await this.options.store.save(job);
    } catch (error) {
      // Sem o store o job ainda roda em memória: perder durabilidade é melhor que perder a mensagem.
      this.options.onError(`store indisponível para ${job.id}`, error);
    }

    this.schedule(job);
    return 'accepted';
  }

  /**
   * Retoma os jobs que um processo anterior deixou no store. Espera cada instância ficar
   * pronta para enviar; os que passarem do prazo viram aviso ao atendente.
   */
  public async recover(): Promise<number> {
    let orphans: WebhookJob[] = [];
    try {
      orphans = (await this.options.store.list()).filter(
        (job) => job?.id && job.receivedAt < this.startedAt && !this.known.has(this.knownKey(job)),
      );
    } catch (error) {
      this.options.onError('leitura dos pendentes', error);
      return 0;
    }

    // O processo anterior pode ter morrido entre marcar concluído e apagar o pendente:
    // esse job já foi entregue e não pode ser reenviado.
    const pending: WebhookJob[] = [];
    for (const job of orphans) {
      if (await this.options.store.isDone(job).catch(() => false)) {
        await this.options.store.remove(job).catch(() => undefined);
      } else {
        pending.push(job);
      }
    }
    orphans = pending;

    orphans.sort((a, b) => a.receivedAt - b.receivedAt);
    for (const job of orphans) this.known.add(this.knownKey(job));

    const waiting = [...orphans];
    const tick = () => {
      if (this.stopping) return;

      for (const job of [...waiting]) {
        const expired = this.isExpired(job);
        if (expired || this.options.isReady(job.instanceName)) {
          waiting.splice(waiting.indexOf(job), 1);
          this.schedule(job);
        }
      }

      if (waiting.length) {
        this.recoveryTimer = setTimeout(tick, this.recoveryPollMs);
        this.recoveryTimer.unref?.();
      }
    };
    tick();

    return orphans.length;
  }

  /** Para de aceitar e espera os jobs em andamento, até o prazo. O resto fica no store. */
  public async stop(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    clearTimeout(this.recoveryTimer);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = this.queue.drain().then(() => true);

    const result = await Promise.race([drained, timeout]);
    clearTimeout(timer);
    return result;
  }

  public get isStopping(): boolean {
    return this.stopping;
  }

  /** Jobs aguardando ou em execução neste processo. */
  public get inFlight(): number {
    let total = 0;
    for (const jobs of this.mailboxes.values()) total += jobs.length;
    return total;
  }

  private schedule(job: WebhookJob): void {
    const mailbox = this.mailboxes.get(job.queueKey) ?? [];
    mailbox.push(job);
    this.mailboxes.set(job.queueKey, mailbox);

    // Uma task por job; cada task processa o próximo da conversa na hora em que roda.
    const enqueued = this.queue.enqueue(job.queueKey, () => this.runNext(job.queueKey));
    if (!enqueued) {
      // Fila lotada: o job sai da caixa e do store, e o descarte já foi reportado pela fila.
      mailbox.splice(mailbox.indexOf(job), 1);
      void this.finish(job, false);
    }
  }

  private async runNext(queueKey: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.orderWindowMs));

    const mailbox = this.mailboxes.get(queueKey) ?? [];
    const job = pickNextJob(mailbox);
    if (!job) return;

    mailbox.splice(mailbox.indexOf(job), 1);
    if (!mailbox.length) this.mailboxes.delete(queueKey);

    try {
      if (this.isExpired(job)) {
        await this.options.onExpired(job);
      } else {
        await this.options.handle(job);
      }
    } catch (error) {
      this.options.onError(`processamento de ${job.id}`, error);
    } finally {
      await this.finish(job, true);
    }
  }

  private async finish(job: WebhookJob, done: boolean): Promise<void> {
    try {
      // Marca concluído antes de remover: nunca existe janela em que o job não está em
      // nenhum dos dois e uma repetição passaria como nova.
      if (done) await this.options.store.markDone(job);
      await this.options.store.remove(job);
    } catch (error) {
      this.options.onError(`finalização de ${job.id}`, error);
    } finally {
      // A partir daqui repetições são barradas pela marca de concluído no store (com TTL);
      // manter em memória faria o conjunto crescer para sempre.
      this.known.delete(this.knownKey(job));
    }
  }

  private isExpired(job: WebhookJob): boolean {
    return this.now() - job.receivedAt > this.maxAgeMs;
  }

  private knownKey(job: Pick<WebhookJob, 'instanceName' | 'id'>): string {
    return `${job.instanceName}:${job.id}`;
  }
}
