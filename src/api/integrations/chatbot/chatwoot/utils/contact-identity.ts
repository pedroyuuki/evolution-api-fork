import { getAvailableNumbers } from '@utils/jidIdentity';
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
  email?: string | null;
  name?: string | null;
  created_at?: number | null;
};

export type ContactUpdate = { name?: string; identifier?: string; phone_number?: string };

export type ContactLinkPlan =
  | { action: 'create'; identifier: string; phoneNumber?: string }
  | { action: 'link'; baseId: number; mergeIds: number[]; update?: ContactUpdate };

function normalize(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  return jidNormalizedUser(jid) || undefined;
}

function digitsOf(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

function clean(value?: string | null): string | undefined {
  return value?.trim() || undefined;
}

/** Monta a identidade a partir de JIDs em qualquer ordem. */
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
 * o 9º dígito, mas o número real (e o que o atendente vê, procura e disca) tem o 9:
 * celulares começam com 6 a 9 depois do DDD. Fixos (2 a 5) ficam como estão.
 */
export function displayPhone(pnJid: string): string {
  const digits = digitsOf(pnJid);
  const isBrazilianMobileWithoutNine = digits.startsWith('55') && digits.length === 12 && /[6-9]/.test(digits[4]);
  return `+${isBrazilianMobileWithoutNine ? `${digits.slice(0, 4)}9${digits.slice(4)}` : digits}`;
}

/**
 * O que procurar no Chatwoot para achar todos os cadastros da mesma pessoa: o identifier
 * pelo número (e as variantes do 9º dígito), pelo LID, e os telefones dessas variantes —
 * inclusive os dígitos do LID, que versões anteriores gravavam como telefone.
 */
export function contactLookup(identity: ContactIdentity): { identifiers: string[]; phones: string[] } {
  const pnVariants = identity.pnJid ? getAvailableNumbers(identity.pnJid) : [];
  const identifiers = [...pnVariants, identity.lidJid].filter(Boolean);
  const phones = identifiers.map((jid) => `+${digitsOf(jid)}`);
  return { identifiers: [...new Set(identifiers)], phones: [...new Set(phones)] };
}

/** Telefones do número (variantes do 9º dígito), sem os dígitos do LID. */
function pnPhones(identity: ContactIdentity): string[] {
  return identity.pnJid ? getAvailableNumbers(identity.pnJid).map((jid) => `+${digitsOf(jid)}`) : [];
}

/**
 * Um contato achado pela busca só é da mesma pessoa se:
 * - o identifier for um JID dela (número, variante do 9 ou LID); ou
 * - o identifier estiver vazio e o telefone for dela (cadastro manual do atendente); ou
 * - o identifier for outro LID e o telefone for o número dela (a mesma pessoa pode ter
 *   mais de um LID; dígitos de LID como telefone não servem de prova aqui).
 * Contato com identifier de outra pessoa nunca entra, mesmo com telefone parecido.
 */
export function sameContactCandidates(identity: ContactIdentity, found: ChatwootContactRef[]): ChatwootContactRef[] {
  const { identifiers, phones } = contactLookup(identity);
  const numberPhones = pnPhones(identity);
  const byId = new Map<number, ChatwootContactRef>();

  for (const contact of found) {
    if (!contact?.id || byId.has(contact.id)) continue;
    const identifier = clean(contact.identifier);
    const phone = clean(contact.phone_number);
    const matchesIdentifier = identifier && identifiers.includes(identifier);
    const matchesPhone = !identifier && phones.includes(phone);
    const otherLidOfSameNumber = identifier && isLidUser(identifier) && numberPhones.includes(phone);
    if (matchesIdentifier || matchesPhone || otherLidOfSameNumber) byId.set(contact.id, contact);
  }

  return [...byId.values()];
}

/**
 * Qual cadastro sobrevive: quem tem e-mail (o dado que o atendente preencheu e que não se
 * reconstrói), depois o mais antigo, depois o menor id. Nada se perde pela direção: o
 * merge do Chatwoot preenche o que está vazio na base com o do outro contato, e nome,
 * identifier e telefone são consolidados depois.
 */
export function electBaseContact(candidates: ChatwootContactRef[]): ChatwootContactRef | undefined {
  const withEmail = candidates.filter((contact) => clean(contact.email));
  const pool = withEmail.length ? withEmail : candidates;
  const age = (contact: ChatwootContactRef) => contact.created_at ?? Number.POSITIVE_INFINITY;
  return [...pool].sort((a, b) => age(a) - age(b) || a.id - b.id)[0];
}

/**
 * Qualidade de um nome de contato. Zero ou menos é placeholder: vazio, só números, contém
 * o telefone ou não tem letras (padrões que a Evolution gera quando não há pushName). Um
 * nome real ganha pontos por ter sobrenome e por comprimento.
 */
export function nameScore(name: string | null | undefined, phoneDigits: string[]): number {
  const value = clean(name);
  if (!value) return -1;

  const digits = value.replace(/\D/g, '');
  if (digits.length >= 8) return 0;
  if (phoneDigits.some((phone) => phone && value.includes(phone.slice(-8)))) return 0;
  if (!/\p{L}/u.test(value)) return 0;

  let score = 1;
  if (/\s/.test(value)) score += 2;
  score += Math.min(value.length / 20, 1);
  return score;
}

/** Dígitos de telefone da identidade, para reconhecer nome-número. */
export function identityPhoneDigits(identity: ContactIdentity): string[] {
  return contactLookup(identity).phones.map((phone) => phone.slice(1));
}

/**
 * O melhor nome entre todos os cadastros, independente de qual sobrevive. Empate fica com
 * a base, depois com o menor id (a ordem da API não é garantida); se nenhum nome for real,
 * mantém o da base. Devolve undefined quando não muda.
 */
function consolidatedName(
  base: ChatwootContactRef,
  candidates: ChatwootContactRef[],
  phoneDigits: string[],
): string | undefined {
  const isBase = (contact: ChatwootContactRef) => (contact.id === base.id ? 1 : 0);
  const ranked = [...candidates].sort(
    (a, b) => nameScore(b.name, phoneDigits) - nameScore(a.name, phoneDigits) || isBase(b) - isBase(a) || a.id - b.id,
  );
  const best = clean(ranked[0]?.name);
  if (nameScore(best, phoneDigits) <= 0 || best === clean(base.name)) return undefined;
  return best;
}

/**
 * Decide como ligar a identidade a um único contato do Chatwoot sem perder o vínculo.
 *
 * Todos os cadastros da mesma pessoa (criados com o LID, pelo atendente com o 9º dígito
 * trocado, ou pela Evolution) são mesclados na base eleita. Depois a base recebe o melhor
 * nome, o identifier canônico (o JID que o WhatsApp devolve) e o telefone em E.164 com o
 * 9 — o formato que o atendente procura, para ele achar o contato e não criar outro.
 * Sem cadastro, cria pelo número; sem número, pelo LID e sem telefone.
 */
export function planContactLink(identity: ContactIdentity, candidates: ChatwootContactRef[] = []): ContactLinkPlan {
  const base = electBaseContact(candidates);

  if (!base) {
    return identity.pnJid
      ? { action: 'create', identifier: identity.pnJid, phoneNumber: displayPhone(identity.pnJid) }
      : { action: 'create', identifier: identity.lidJid };
  }

  const update: ContactUpdate = {};

  const name = consolidatedName(base, candidates, identityPhoneDigits(identity));
  if (name) update.name = name;

  if (identity.pnJid) {
    if (base.identifier !== identity.pnJid) update.identifier = identity.pnJid;
    // Só normaliza telefone vazio, LID ou variante do próprio número: um telefone diferente
    // foi posto de propósito pelo atendente (o identifier já garante o vínculo).
    const phone = displayPhone(identity.pnJid);
    const current = clean(base.phone_number);
    const ownPhone = !current || contactLookup(identity).phones.includes(current);
    if (ownPhone && current !== phone) update.phone_number = phone;
  } else if (!clean(base.identifier)) {
    // Sem número conhecido: o LID vira o identifier, mas nunca o telefone.
    update.identifier = identity.lidJid;
  }

  return {
    action: 'link',
    baseId: base.id,
    mergeIds: candidates.filter((contact) => contact.id !== base.id).map((contact) => contact.id),
    update: Object.keys(update).length ? update : undefined,
  };
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
