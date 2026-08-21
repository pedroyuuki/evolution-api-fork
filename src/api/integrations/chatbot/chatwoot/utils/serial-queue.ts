type Task = () => Promise<unknown>;

type ErrorHandler = (key: string, error: unknown) => void;

/** Destrava a cadeia quando uma task não responde. Não cancela a task, apenas para de esperá-la. */
const DEFAULT_TASK_TIMEOUT_MS = 120_000;

const DEFAULT_MAX_PENDING_PER_KEY = 100;

/**
 * Fila que executa tasks em série por chave, e em paralelo entre chaves distintas.
 *
 * Usada para processar os webhooks do Chatwoot fora do ciclo da requisição HTTP: o
 * Chatwoot desiste da requisição em 5s e marca a mensagem como falha, mesmo quando o
 * envio deu certo. Respondendo de imediato e enfileirando aqui, o envio deixa de
 * competir com esse timeout, e mensagens de uma mesma conversa continuam saindo na
 * ordem em que o atendente as escreveu.
 *
 * A cadeia de uma chave nunca rejeita: erro de task, erro do próprio relator de erro e
 * task travada são todos contidos, porque uma cadeia rejeitada engoliria em silêncio
 * todas as mensagens seguintes daquela conversa.
 *
 * A fila vive em memória: envios em voo são perdidos se o processo reiniciar.
 */
export class SerialQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly onError: ErrorHandler,
    private readonly maxPendingPerKey = DEFAULT_MAX_PENDING_PER_KEY,
    private readonly taskTimeoutMs = DEFAULT_TASK_TIMEOUT_MS,
  ) {}

  /** Quantidade de chaves com trabalho em andamento. */
  public get size(): number {
    return this.chains.size;
  }

  /** Tasks aguardando ou executando para uma chave. */
  public pendingFor(key: string): number {
    return this.pending.get(key) ?? 0;
  }

  /**
   * Enfileira uma task. Retorna false quando a chave atingiu o teto e a task foi
   * descartada, para que o chamador possa registrar a perda.
   */
  public enqueue(key: string, task: Task): boolean {
    const pending = this.pending.get(key) ?? 0;

    if (pending >= this.maxPendingPerKey) {
      this.report(key, new Error(`Fila cheia (${this.maxPendingPerKey} pendentes), task descartada`));
      return false;
    }

    this.pending.set(key, pending + 1);

    const runner = async () => {
      try {
        await this.run(key, task);
      } finally {
        this.release(key);
      }
    };

    // O mesmo runner nos dois ramos: se por algum motivo a cadeia anterior rejeitar,
    // esta task ainda roda em vez de ser silenciosamente pulada.
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(runner, runner);

    this.chains.set(key, next);

    // Só remove a cadeia se nada tiver sido enfileirado depois dela.
    next.then(() => {
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    });

    return true;
  }

  /** Aguarda o esvaziamento da fila. Existe para os testes. */
  public async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }

  /** Executa a task sem nunca rejeitar e sem deixar a cadeia presa a uma task travada. */
  private run(key: string, task: Task): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      let timer: NodeJS.Timeout | undefined;
      if (this.taskTimeoutMs > 0) {
        timer = setTimeout(() => {
          this.report(key, new Error(`Task passou de ${this.taskTimeoutMs}ms; a fila desta chave foi liberada`));
          finish();
        }, this.taskTimeoutMs);
        timer.unref?.();
      }

      let running: Promise<unknown>;
      try {
        running = task();
      } catch (error) {
        // Task que lança antes de devolver a promise.
        running = Promise.reject(error);
      }

      running.then(
        () => {
          clearTimeout(timer);
          finish();
        },
        (error) => {
          // Se o timeout já liberou a cadeia, ainda assim reportamos a falha tardia
          // em vez de deixá-la virar unhandled rejection.
          clearTimeout(timer);
          this.report(key, error);
          finish();
        },
      );
    });
  }

  private release(key: string): void {
    const remaining = (this.pending.get(key) ?? 1) - 1;
    if (remaining > 0) {
      this.pending.set(key, remaining);
    } else {
      this.pending.delete(key);
    }
  }

  private report(key: string, error: unknown): void {
    try {
      this.onError(key, error);
    } catch {
      // Um relator de erro quebrado não pode derrubar a fila nem o processo.
    }
  }
}
