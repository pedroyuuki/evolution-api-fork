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
  constructor(private readonly cache: CacheService) {}

  public async save(job: WebhookJob): Promise<void> {
    await this.cache.set(this.key(PENDING, job), job, PENDING_TTL_SECONDS);
  }

  public async remove(job: WebhookJob): Promise<void> {
    await this.cache.delete(this.key(PENDING, job));
  }

  public async list(): Promise<WebhookJob[]> {
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
