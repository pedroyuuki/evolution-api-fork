-- Disparador de templates (rc15): opções do disparo, erros do status e índices.

-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "dispatchEmitWebhook" BOOLEAN,
ADD COLUMN IF NOT EXISTS "dispatchChatwoot" BOOLEAN,
ADD COLUMN IF NOT EXISTS "dispatchSyncedAt" TIMESTAMP;

-- AlterTable
ALTER TABLE "MessageUpdate" ADD COLUMN IF NOT EXISTS "errors" JSONB;

-- Busca da mensagem pelo id do WhatsApp (cada status da Cloud). Em tabela grande, crie
-- antes da troca de imagem com CREATE INDEX CONCURRENTLY (ver release da rc15): aqui
-- o IF NOT EXISTS vira no-op.
CREATE INDEX IF NOT EXISTS "Message_instanceId_keyId_idx" ON "Message" ("instanceId", ("key"->>'id'));

-- Disparos sem Chatwoot ainda não levados ao Chatwoot (resposta do cliente).
CREATE INDEX IF NOT EXISTS "Message_dispatch_pending_idx" ON "Message" ("instanceId", ("key"->>'remoteJid'), "messageTimestamp")
WHERE "dispatchChatwoot" = false AND "dispatchSyncedAt" IS NULL;
