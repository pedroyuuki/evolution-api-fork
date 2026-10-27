/**
 * Consultas ao banco de importação do Chatwoot (CHATWOOT_IMPORT_DATABASE_CONNECTION_URI).
 * Ele é um só para todas as instâncias, que podem estar em contas diferentes: o id de uma
 * mensagem ou o source_id sozinhos podem ser de outro cliente. Por isso conta e caixa.
 */

type Query = { sql: string; params: unknown[] };

/** null quando não dá para limitar à conta e à caixa da instância: aí não atualiza nada. */
export function sourceIdUpdateQuery(
  messageId: string | number,
  sourceId: string,
  scope: { accountId: number | string | undefined; inboxId: number | undefined },
): Query | null {
  if (
    scope.accountId === undefined ||
    scope.accountId === null ||
    scope.inboxId === undefined ||
    scope.inboxId === null
  ) {
    return null;
  }
  return {
    sql: 'UPDATE messages SET source_id = $1, status = 0, created_at = NOW(), updated_at = NOW() WHERE id = $2 AND account_id = $3 AND inbox_id = $4;',
    params: [`WAID:${sourceId}`, messageId, scope.accountId, scope.inboxId],
  };
}

export function existingSourceIdsQuery(
  formattedSourceIds: string[],
  scope: { conversationId?: number; inboxId?: number },
): Query {
  if (scope.conversationId) {
    return {
      sql: 'SELECT source_id FROM messages WHERE source_id = ANY($1) AND conversation_id = $2',
      params: [formattedSourceIds, scope.conversationId],
    };
  }
  if (scope.inboxId) {
    return {
      sql: 'SELECT source_id FROM messages WHERE source_id = ANY($1) AND inbox_id = $2',
      params: [formattedSourceIds, scope.inboxId],
    };
  }
  return { sql: 'SELECT source_id FROM messages WHERE source_id = ANY($1)', params: [formattedSourceIds] };
}
