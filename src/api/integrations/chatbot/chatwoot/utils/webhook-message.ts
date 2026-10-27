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
