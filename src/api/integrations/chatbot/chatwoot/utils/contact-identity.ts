import { isJidGroup, isLidUser, isPnUser, jidNormalizedUser } from 'baileys';

/**
 * Identidade de um contato individual como o Chatwoot deve enxergá-la: o JID pelo número
 * (quando conhecido) e o LID (quando conhecido). O contato do Chatwoot é identificado pelo
 * número sempre que ele existe; o LID sozinho só identifica quem ainda não tem número.
 */
export type ContactIdentity = {
  pnJid?: string;
  lidJid?: string;
  /** Chave do contato: o número, ou o LID quando o número é desconhecido. */
  primaryJid: string;
};

type KeyLike = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
};

export type ChatwootContactRef = {
  id: number;
  identifier?: string | null;
  phone_number?: string | null;
};

export type ContactUpdate = { identifier?: string; phone_number?: string };

export type ContactLinkPlan =
  | { action: 'create'; identifier: string; phoneNumber?: string }
  | { action: 'use'; contactId: number; update?: ContactUpdate }
  | { action: 'merge'; baseId: number; mergeeId: number; update?: ContactUpdate };

function normalize(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  return jidNormalizedUser(jid) || undefined;
}

function digitsOf(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/** Monta a identidade a partir de um par principal/Alt, em qualquer ordem. */
export function contactIdentityFromJids(...jids: (string | null | undefined)[]): ContactIdentity | undefined {
  let pnJid: string | undefined;
  let lidJid: string | undefined;

  for (const jid of jids.map(normalize)) {
    if (!jid) continue;
    if (!pnJid && isPnUser(jid)) pnJid = jid;
    else if (!lidJid && isLidUser(jid)) lidJid = jid;
  }

  const primaryJid = pnJid ?? lidJid;
  return primaryJid ? { pnJid, lidJid, primaryJid } : undefined;
}

/** Identidade do contato de uma conversa individual; undefined para grupo ou broadcast. */
export function contactIdentityFromKey(key?: KeyLike | null): ContactIdentity | undefined {
  if (!key || isJidGroup(key.remoteJid ?? undefined)) return undefined;
  return contactIdentityFromJids(key.remoteJid, key.remoteJidAlt);
}

/** Identidade de quem enviou a mensagem num grupo. */
export function participantIdentityFromKey(key?: KeyLike | null): ContactIdentity | undefined {
  if (!key) return undefined;
  return contactIdentityFromJids(key.participant, key.participantAlt);
}

/**
 * Telefone de exibição em E.164. No Brasil o JID de celulares com DDD 31 ou maior vem sem
 * o 9º dígito, mas o número real (e o que o atendente vê e disca) tem o 9: celulares
 * começam com 6 a 9 depois do DDD. Fixos (2 a 5) ficam como estão.
 */
export function displayPhone(pnJid: string): string {
  const digits = digitsOf(pnJid);
  const isBrazilianMobileWithoutNine = digits.startsWith('55') && digits.length === 12 && /[6-9]/.test(digits[4]);
  return `+${isBrazilianMobileWithoutNine ? `${digits.slice(0, 4)}9${digits.slice(4)}` : digits}`;
}

/** O telefone do contato é o LID gravado como se fosse número (versões anteriores faziam isso). */
function hasLidAsPhone(contact: ChatwootContactRef, lidJid?: string): boolean {
  return Boolean(lidJid) && contact.phone_number === `+${digitsOf(lidJid)}`;
}

/** Correção do contato que representa o número: identifier no JID canônico e telefone real. */
function pnContactUpdate(contact: ChatwootContactRef, identity: ContactIdentity): ContactUpdate | undefined {
  const update: ContactUpdate = {};
  if (contact.identifier !== identity.pnJid) update.identifier = identity.pnJid;
  if (!contact.phone_number || hasLidAsPhone(contact, identity.lidJid)) {
    update.phone_number = displayPhone(identity.pnJid);
  }
  return Object.keys(update).length ? update : undefined;
}

/**
 * Decide como ligar a mensagem a um contato do Chatwoot sem quebrar o vínculo existente.
 *
 * - Contato do número e contato do LID diferentes: o LID é mesclado no do número. O merge
 *   do Chatwoot leva as conversas e mensagens do LID para a base, então o histórico legado
 *   continua no mesmo lugar.
 * - Só o contato do LID existe e o número é conhecido: ele é religado no lugar (identifier
 *   e telefone passam para o número), mantendo o id, as conversas e os atributos.
 * - Só o contato do número: usado como está, corrigindo identifier/telefone se preciso.
 * - Nenhum: cria pelo número; sem número, pelo LID e sem telefone — dígitos de LID nunca
 *   viram telefone.
 */
export function planContactLink(
  identity: ContactIdentity,
  pnContact?: ChatwootContactRef | null,
  lidContact?: ChatwootContactRef | null,
): ContactLinkPlan {
  if (pnContact && identity.pnJid) {
    const update = pnContactUpdate(pnContact, identity);
    if (lidContact && lidContact.id !== pnContact.id) {
      return { action: 'merge', baseId: pnContact.id, mergeeId: lidContact.id, update };
    }
    return { action: 'use', contactId: pnContact.id, update };
  }

  if (lidContact) {
    if (identity.pnJid) {
      return {
        action: 'use',
        contactId: lidContact.id,
        update: { identifier: identity.pnJid, phone_number: displayPhone(identity.pnJid) },
      };
    }
    return { action: 'use', contactId: lidContact.id };
  }

  if (identity.pnJid) {
    return { action: 'create', identifier: identity.pnJid, phoneNumber: displayPhone(identity.pnJid) };
  }
  return { action: 'create', identifier: identity.lidJid };
}

/**
 * Escolhe a conversa da caixa de entrada: a de atividade mais recente. Depois de um merge o
 * contato tem mais de uma, e a lista da API não tem ordem garantida.
 */
export function pickInboxConversation<T extends { inbox_id?: number | string; last_activity_at?: number; id: number }>(
  conversations: T[],
  inboxId: number,
  accept: (conversation: T) => boolean = () => true,
): T | undefined {
  return conversations
    .filter((conversation) => conversation && conversation.inbox_id == inboxId && accept(conversation))
    .sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0) || b.id - a.id)[0];
}
