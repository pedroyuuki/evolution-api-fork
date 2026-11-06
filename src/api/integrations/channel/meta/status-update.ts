/**
 * Evento de status (MESSAGES_UPDATE e webhookUrl da mensagem) a partir de um item de
 * `statuses` do webhook da Meta.
 *
 * `error` (primeiro erro, achatado) é o formato que já existia e quem consome (n8n) lê;
 * `errors` é o array da Meta como veio. `timestamp` é o horário real do evento na Meta,
 * e `conversation`/`pricing` dizem a categoria cobrada. Campo ausente não aparece.
 */
export function buildStatusUpdate(base: Record<string, any>, item: any): Record<string, any> {
  const status = String(item?.status ?? '').toUpperCase();
  const update: Record<string, any> = { ...base, status };

  const errors = Array.isArray(item?.errors) && item.errors.length ? item.errors : undefined;
  if (status === 'FAILED' && errors) {
    const first = errors[0];
    update.error = {
      code: first.code,
      title: first.title,
      message: first.message,
      details: first.error_data?.details,
      href: first.href,
    };
  }
  if (errors) update.errors = errors;

  const timestamp = Number(item?.timestamp);
  if (item?.timestamp !== undefined && Number.isFinite(timestamp)) update.timestamp = timestamp;
  if (item?.conversation) update.conversation = item.conversation;
  if (item?.pricing) update.pricing = item.pricing;

  return update;
}
