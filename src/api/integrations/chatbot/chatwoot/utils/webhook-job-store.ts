import { CacheService } from '@api/services/cache.service';

import { WebhookJob, WebhookJobStore } from './webhook-dispatcher';

const PENDING = 'webhook:pending';
const DONE = 'webhook:done';

/** Pendente sobrevive a uma queda longa; acima do prazo de envio ele só gera o aviso. */
const PENDING_TTL_SECONDS = 24 * 60 * 60;
/** Janela em que uma repetição do mesmo evento é reconhecida e ignorada. */
const DONE_TTL_SECONDS = 24 * 60 * 60;

/**
 * Guarda os webhooks do Chatwoot no cache do projeto (Redis). Com o cache local, a fila
 * funciona igual, só não sobrevive a um reinício.
 */
export class CacheWebhookJobStore implements WebhookJobStore {
  /**
   * @param migrateLegacyPending move para o módulo atual as pendências gravadas por uma
   *   versão anterior sob outro nome de módulo (o antigo nome de classe minificado).
   */
  constructor(
    private readonly cache: CacheService,
    private readonly migrateLegacyPending?: () => Promise<void>,
  ) {}

  public async save(job: WebhookJob): Promise<void> {
    await this.cache.set(this.key(PENDING, job), job, PENDING_TTL_SECONDS);
  }

  public async remove(job: WebhookJob): Promise<void> {
    await this.cache.delete(this.key(PENDING, job));
  }

  public async list(): Promise<WebhookJob[]> {
    await this.migrateLegacyPending?.().catch(() => undefined);
    const fullKeys: string[] = (await this.cache.keys(PENDING)) ?? [];
    const jobs = await Promise.all(
      fullKeys.map((fullKey) => {
        // keys() devolve a chave com o prefixo do cache; get() espera a chave relativa.
        const relative = fullKey.slice(fullKey.indexOf(`${PENDING}:`));
        return this.cache.get(relative);
      }),
    );
    return jobs.filter((job): job is WebhookJob => Boolean(job?.id && job?.instanceName));
  }

  public async markDone(job: WebhookJob): Promise<void> {
    await this.cache.set(this.key(DONE, job), true, DONE_TTL_SECONDS);
  }

  public async isDone(job: WebhookJob): Promise<boolean> {
    return Boolean(await this.cache.has(this.key(DONE, job)));
  }

  public async isPending(job: WebhookJob): Promise<boolean> {
    return Boolean(await this.cache.has(this.key(PENDING, job)));
  }

  private key(kind: string, job: Pick<WebhookJob, 'instanceName' | 'id'>): string {
    return `${kind}:${job.instanceName}:${job.id}`;
  }
}

/**
 * Pendências de webhook gravadas por versões que usavam o nome de classe minificado como
 * módulo do cache (`<prefixo>:<qualquer>:webhook:pending:*`) são copiadas para o módulo
 * atual e apagadas da chave antiga, para que o primeiro deploy com o nome fixo também
 * retome o que ficou em andamento. Só se aplica ao Redis.
 */
export function legacyPendingMigrator(
  client: {
    scanIterator: (o: any) => AsyncIterable<any>;
    get: (k: string) => Promise<any>;
    del: (k: string) => Promise<any>;
  },
  prefix: string,
  currentModule: string,
  save: (job: WebhookJob) => Promise<void>,
): () => Promise<void> {
  return async () => {
    for await (const entry of client.scanIterator({ MATCH: `${prefix}:*:${PENDING}:*`, COUNT: 100 })) {
      const keys: string[] = Array.isArray(entry) ? entry : [entry];
      for (const key of keys) {
        if (key.startsWith(`${prefix}:${currentModule}:`)) continue;
        const raw = await client.get(key);
        const job = raw ? (JSON.parse(raw) as WebhookJob) : null;
        if (job?.id && job?.instanceName) await save(job);
        await client.del(key);
      }
    }
  };
}
