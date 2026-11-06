/**
 * Opções de disparo em massa do sendTemplate (Cloud API).
 *
 * - `emitWebhook: false`: não emite SEND_MESSAGE nem os MESSAGES_UPDATE dessa mensagem nos
 *   eventos da instância (webhook, RabbitMQ...). O webhookUrl da própria mensagem continua.
 * - `chatwoot: false`: não leva o envio ao Chatwoot; se o cliente responder, a mensagem do
 *   disparo entra antes da resposta (ver dispatch-context).
 *
 * As duas precisam ser lembradas por mensagem, porque os status chegam depois pelo webhook
 * da Meta. Sem opção nenhuma (ou com `true`) nada é gravado e tudo segue como sempre.
 */
export type DispatchOptions = { emitWebhook: boolean; chatwoot: boolean };

export function dispatchOptions(
  data: { emitWebhook?: boolean; chatwoot?: boolean } | undefined,
): DispatchOptions | null {
  const emitWebhook = data?.emitWebhook !== false;
  const chatwoot = data?.chatwoot !== false;
  return emitWebhook && chatwoot ? null : { emitWebhook, chatwoot };
}

export function dispatchColumns(opts: DispatchOptions | null | undefined) {
  return opts ? { dispatchEmitWebhook: opts.emitWebhook, dispatchChatwoot: opts.chatwoot } : {};
}

/** Opções gravadas numa mensagem; linha sem as colunas (anteriores à rc15) vale como padrão. */
export function optionsFromRow(
  row: { dispatchEmitWebhook?: boolean | null; dispatchChatwoot?: boolean | null } | null | undefined,
): DispatchOptions {
  return { emitWebhook: row?.dispatchEmitWebhook !== false, chatwoot: row?.dispatchChatwoot !== false };
}

/**
 * Número do destinatário a gravar. A Meta normaliza o número (DDI, nono dígito) e devolve o
 * resultado em `contacts[0].wa_id`; a resposta do cliente chega com esse número. Sem isso, um
 * disparo para `44997091885` ficava gravado assim e nunca casava com a resposta de
 * `554497091885`. Só nos envios de disparo, para não mudar os demais.
 */
export function resolveRecipientNumber(
  input: string,
  metaResponse: any,
  opts: DispatchOptions | null | undefined,
): string {
  const waId = metaResponse?.contacts?.[0]?.wa_id;
  return opts && typeof waId === 'string' && waId ? waId : input;
}
