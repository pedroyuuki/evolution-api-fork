/**
 * Chave do agrupamento de mensagens (debounce) dos chatbots. Era só o remoteJid: num grupo
 * com dois números nossos (ou um cliente falando com os dois), as mensagens das duas
 * instâncias se juntavam e só uma respondia, com o texto das duas.
 */
export function debounceKey(instanceId: string, remoteJid: string): string {
  return `${instanceId}:${remoteJid}`;
}
