-- Disparador de templates (rc15): opções do disparo e erros do status.
-- Sem os índices de expressão do Postgres: no MySQL as buscas usam o Prisma.

-- AlterTable
ALTER TABLE `Message` ADD COLUMN `dispatchEmitWebhook` BOOLEAN NULL,
    ADD COLUMN `dispatchChatwoot` BOOLEAN NULL,
    ADD COLUMN `dispatchSyncedAt` TIMESTAMP NULL;

-- AlterTable
ALTER TABLE `MessageUpdate` ADD COLUMN `errors` JSON NULL;
