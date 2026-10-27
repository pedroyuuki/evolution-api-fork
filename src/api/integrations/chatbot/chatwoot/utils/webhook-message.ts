/**
 * No webhook message_created do Chatwoot, a raiz do payload é a mensagem que disparou o
 * evento (com o próprio source_id e anexos). Já `conversation.messages` traz só a ÚLTIMA
 * mensagem da conversa no momento em que o Chatwoot monta o payload, o que acontece de
 * forma assíncrona: se outra mensagem entra na conversa nesse intervalo (comum numa
 * conversa recém-criada), `messages[0]` é outra mensagem.
 */

const EVOLUTION_SOURCE_PREFIX = 'WAID:';

const isEvolutionSource = (sourceId: unknown) =>
  typeof sourceId === 'string' && sourceId.startsWith(EVOLUTION_SOURCE_PREFIX);

/**
 * A mensagem do evento é uma cópia que a própria Evolution gravou no Chatwoot (o que já
 * saiu pelo WhatsApp, inclusive o rótulo ▶️template◀️ de um template da Cloud API) e não
 * pode ser enviada de novo. Olhar só `conversation.messages[0]` deixava a cópia passar
 * quando ela não era a última mensagem: a instância ligada à caixa reenviava o texto.
 */
export function isEvolutionEcho(body: any): boolean {
  return isEvolutionSource(body?.source_id) || isEvolutionSource(body?.conversation?.messages?.[0]?.source_id);
}

/**
 * Mensagens a enviar ao WhatsApp para este evento: a da raiz do payload. Antes vinha de
 * `conversation.messages`, que podia ser outra mensagem e reenviar anexos antigos.
 */
export function eventMessages(body: any): any[] {
  if (body?.id) {
    return [{ ...body, attachments: body.attachments ?? [] }];
  }
  return body?.conversation?.messages ?? [];
}

/**
 * O evento é de uma conversa de OUTRA caixa do Chatwoot. Uma instância só envia o que é da
 * própria caixa: eventos de outras caixas chegam por webhooks da conta ou de agentes-robô
 * apontados para a instância, e enviá-los fazia um número mandar mensagens de conversas
 * que não são dele (incidente de 26/10: a cópia de templates de duas instâncias Cloud saiu
 * por uma instância Baileys que não envia nada).
 */
export function isFromAnotherInbox(body: any, instanceInboxId: number | string | undefined | null): boolean {
  const eventInboxId = body?.inbox?.id ?? body?.conversation?.inbox_id;
  if (
    eventInboxId === undefined ||
    eventInboxId === null ||
    instanceInboxId === undefined ||
    instanceInboxId === null
  ) {
    return false;
  }
  return String(eventInboxId) !== String(instanceInboxId);
}

/**
 * Nome para assinar a mensagem (signMsg): quem escreveu a mensagem do evento. Vinha de
 * `conversation.messages[0]`, a última da conversa, que pode ser do cliente ou de outro
 * atendente (o mesmo erro da detecção de eco).
 */
export function signatureName(body: any): string | undefined {
  return body?.sender?.available_name ?? body?.sender?.name;
}

/** A conversa (em cache) é da caixa da instância; sem saber uma das duas, não descarta. */
export function belongsToInbox(conversation: any, inboxId: number | string | null | undefined): boolean {
  const conversationInbox = conversation?.inbox_id;
  if (conversationInbox === undefined || conversationInbox === null || inboxId === undefined || inboxId === null) {
    return true;
  }
  return String(conversationInbox) === String(inboxId);
}
