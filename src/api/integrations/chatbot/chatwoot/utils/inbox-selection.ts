/**
 * Qual caixa do Chatwoot é desta instância. Era só pelo nome (`nameInbox`): duas instâncias
 * com o mesmo nome de caixa resolviam para a mesma caixa, e uma caixa renomeada sumia.
 * A URL do webhook da caixa (`.../chatwoot/webhook/<instância>`) diz para quem o Chatwoot
 * manda os eventos dela, então serve para desempatar e para achar a caixa renomeada.
 */

type InboxLike = { id: number; name: string; webhook_url?: string | null };

export function webhookPointsTo(webhookUrl: string | null | undefined, instanceName: string): boolean {
  if (!webhookUrl) return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(webhookUrl).pathname);
  } catch {
    return false;
  }
  return path.replace(/\/+$/, '').endsWith(`/chatwoot/webhook/${instanceName}`);
}

/**
 * Nome primeiro, como sempre foi (onde o nome funcionava, a caixa não muda); com nome
 * repetido, a que aponta para esta instância; sem nenhuma pelo nome, a que aponta para ela.
 * `ambiguous`: mais de uma caixa casou pelo critério usado (configuração a corrigir).
 */
export function pickOwnInbox<T extends InboxLike>(
  inboxes: T[],
  instanceName: string,
  nameInbox: string | undefined,
): { inbox: T | null; ambiguous: boolean } {
  const byName = inboxes.filter((inbox) => nameInbox && inbox.name === nameInbox);
  if (byName.length) {
    const pointing = byName.find((inbox) => webhookPointsTo(inbox.webhook_url, instanceName));
    return { inbox: pointing ?? byName[0], ambiguous: byName.length > 1 };
  }

  const byUrl = inboxes.filter((inbox) => webhookPointsTo(inbox.webhook_url, instanceName));
  return { inbox: byUrl[0] ?? null, ambiguous: byUrl.length > 1 };
}

/** A caixa em cache ainda é desta instância (pelo nome configurado ou pela URL do webhook). */
export function isOwnInbox(inbox: InboxLike | null | undefined, instanceName: string, nameInbox: string | undefined) {
  if (!inbox) return false;
  return (!!nameInbox && inbox.name === nameInbox) || webhookPointsTo(inbox.webhook_url, instanceName);
}

/**
 * Sem saber a caixa desta instância não dá para conferir de quem é o evento: nada sai pelo
 * WhatsApp. Essa instância já não recebia mensagens no Chatwoot (a caixa não existe mais).
 */
export function mustBlockSend(ownInboxId: number | null | undefined): boolean {
  return ownInboxId === null || ownInboxId === undefined;
}
