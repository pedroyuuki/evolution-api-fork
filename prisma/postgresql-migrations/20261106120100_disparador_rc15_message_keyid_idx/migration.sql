-- Busca da mensagem pelo id do WhatsApp (cada status da Cloud). CONCURRENTLY: não trava as
-- gravações enquanto o índice é construído. Precisa ser o único comando do arquivo.
-- Em tabela grande, prefira criar antes da troca de imagem (release da rc15).
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_instanceId_keyId_idx" ON "Message" ("instanceId", ("key"->>'id'));
