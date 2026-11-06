-- Disparador de templates (rc15): opções do disparo e erros do status.
-- Colunas anuláveis e sem padrão: só metadado, a trava da tabela dura milissegundos.
-- Os índices ficam em migrations próprias (CONCURRENTLY não roda junto de outros comandos).

-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "dispatchEmitWebhook" BOOLEAN,
ADD COLUMN IF NOT EXISTS "dispatchChatwoot" BOOLEAN,
ADD COLUMN IF NOT EXISTS "dispatchSyncedAt" TIMESTAMP;

-- AlterTable
ALTER TABLE "MessageUpdate" ADD COLUMN IF NOT EXISTS "errors" JSONB;
