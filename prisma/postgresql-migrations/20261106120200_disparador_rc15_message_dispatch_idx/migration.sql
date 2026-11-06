-- Disparos sem Chatwoot ainda não levados ao Chatwoot (resposta do cliente). CONCURRENTLY e
-- sozinho no arquivo, como o anterior.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_dispatch_pending_idx" ON "Message" ("instanceId", ("key"->>'remoteJid'), "messageTimestamp") WHERE "dispatchChatwoot" = false AND "dispatchSyncedAt" IS NULL;
