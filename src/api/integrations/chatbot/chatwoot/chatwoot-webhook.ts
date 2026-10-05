import { InstanceDto } from '@api/dto/instance.dto';
import { ChatwootWebhookDispatcher } from '@api/integrations/chatbot/chatwoot/utils/webhook-dispatcher';
import {
  CacheWebhookJobStore,
  legacyPendingMigrator,
} from '@api/integrations/chatbot/chatwoot/utils/webhook-job-store';
import {
  CHATWOOT_CACHE_MODULE,
  chatwootCache,
  chatwootController,
  prismaRepository,
  waMonitor,
} from '@api/server.module';
import { redisClient } from '@cache/rediscache.client';
import { CacheConf, configService } from '@config/env.config';
import { reportBackgroundError } from '@utils/reportError';

// Módulo próprio, sem dependência das rotas: o main.ts o importa para retomar e drenar
// os webhooks, e importar o arquivo de rota por lá criaria um ciclo com o index.router.

/**
 * Webhooks do Chatwoot: gravados no Redis, respondidos na hora e processados em série por
 * conversa (ver ChatwootWebhookDispatcher). Só existe com a integração do Chatwoot ligada.
 */
const redisConf = configService.get<CacheConf>('CACHE')?.REDIS;

function createStore(): CacheWebhookJobStore {
  const store: CacheWebhookJobStore = new CacheWebhookJobStore(
    chatwootCache,
    redisConf?.ENABLED
      ? legacyPendingMigrator(redisClient.getConnection(), redisConf.PREFIX_KEY, CHATWOOT_CACHE_MODULE, (job) =>
          store.save(job),
        )
      : undefined,
  );
  return store;
}

export const chatwootWebhookDispatcher = chatwootCache
  ? new ChatwootWebhookDispatcher({
      store: createStore(),
      handle: (job) => chatwootController.receiveWebhook({ instanceName: job.instanceName } as InstanceDto, job.body),
      onExpired: (job) =>
        chatwootController.notifyUnsentMessage(
          { instanceName: job.instanceName } as InstanceDto,
          job.body,
          'A Evolution ficou indisponível e a mensagem passou do prazo de envio. Reenvie se ainda fizer sentido.',
        ),
      onError: (context, error) => reportBackgroundError(`chatwoot webhook ${context}`, error),
      isReady: (instanceName) => waMonitor.waInstances[instanceName]?.connectionStatus?.state === 'open',
    })
  : null;

export async function instanceExists(instanceName: string): Promise<boolean> {
  if (!instanceName) return false;
  if (waMonitor.waInstances[instanceName]) return true;
  // Logo após o boot a instância pode existir no banco e ainda não estar carregada.
  return (await prismaRepository.instance.count({ where: { name: instanceName } })) > 0;
}
