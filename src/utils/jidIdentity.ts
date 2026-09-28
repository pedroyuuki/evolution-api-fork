import { isLidUser, isPnUser, jidNormalizedUser } from 'baileys';

/**
 * Par de identidades do mesmo usuário do WhatsApp: o LID (identificador que esconde o
 * telefone) e o JID pelo número. O LID é estável por usuário, então o par é um fato
 * duradouro — diferente de um cache de "está no WhatsApp".
 */
export type LidPnPair = { lid: string; pn: string };

type KeyLike = {
  remoteJid?: string | null;
  remoteJidAlt?: string | null;
  participant?: string | null;
  participantAlt?: string | null;
};

const LEGACY_LID_FLAG = 'lid';

/** Remove sufixo de aparelho (`:12`) e agente; devolve undefined para vazio. */
function normalizeUserJid(jid?: string | null): string | undefined {
  if (!jid) return undefined;
  const normalized = jidNormalizedUser(jid);
  return normalized || undefined;
}

export function isRealLidJid(value?: string | null): boolean {
  return Boolean(value) && isLidUser(value) === true;
}

/**
 * Extrai os pares LID↔número presentes numa chave de mensagem do Baileys.
 *
 * Numa conversa individual o par vem em remoteJid/remoteJidAlt; num grupo, em
 * participant/participantAlt (o JID do grupo nunca forma par). Os dois sentidos
 * aparecem na prática: endereçamento por LID traz o número no Alt, e por número traz o
 * LID. Em mensagens fromMe de outro aparelho o Alt também é o do outro participante.
 */
export function extractLidPnPairs(key?: KeyLike | null): LidPnPair[] {
  if (!key) return [];

  const pairs: LidPnPair[] = [];
  const consider = (a?: string | null, b?: string | null) => {
    const first = normalizeUserJid(a);
    const second = normalizeUserJid(b);
    if (!first || !second) return;

    if (isLidUser(first) && isPnUser(second)) {
      pairs.push({ lid: first, pn: second });
    } else if (isPnUser(first) && isLidUser(second)) {
      pairs.push({ lid: second, pn: first });
    }
  };

  consider(key.remoteJid, key.remoteJidAlt);
  consider(key.participant, key.participantAlt);

  return dedupePairs(pairs);
}

export function dedupePairs(pairs: LidPnPair[]): LidPnPair[] {
  const byLid = new Map<string, LidPnPair>();
  for (const pair of pairs) {
    const lid = normalizeUserJid(pair?.lid);
    const pn = normalizeUserJid(pair?.pn);
    if (lid && pn && isLidUser(lid) && isPnUser(pn)) {
      byLid.set(lid, { lid, pn });
    }
  }
  return [...byLid.values()];
}

/**
 * Decide o valor da coluna IsOnWhatsapp.lid numa gravação.
 *
 * A coluna guardava só a flag 'lid'. Agora guarda o LID real quando conhecido, e um LID
 * real nunca é substituído por flag ou null: antes, qualquer mensagem sem LID apagava o
 * valor e o par se perdia. Sem LID real envolvido, mantém o comportamento anterior.
 */
export function chooseLidValue({
  incoming,
  existing,
  lidAddressed,
}: {
  incoming?: string | null;
  existing?: string | null;
  lidAddressed: boolean;
}): string | null {
  if (isRealLidJid(incoming)) return normalizeUserJid(incoming);
  if (isRealLidJid(existing)) return existing;
  return lidAddressed ? LEGACY_LID_FLAG : null;
}

/**
 * Variações do JID pelas quais o mesmo número pode aparecer (9º dígito no Brasil,
 * prefixos do México e da Argentina). LID e grupo não têm variações.
 */
export function getAvailableNumbers(remoteJid: string): string[] {
  const numbersAvailable: string[] = [];

  if (remoteJid.startsWith('+')) {
    remoteJid = remoteJid.slice(1);
  }

  const [number, domain] = remoteJid.split('@');

  if (domain === 'lid' || domain === 'g.us') {
    return [remoteJid];
  }

  // Brazilian numbers
  if (remoteJid.startsWith('55')) {
    const numberWithDigit =
      number.slice(4, 5) === '9' && number.length === 13 ? number : `${number.slice(0, 4)}9${number.slice(4)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 4) + number.slice(5);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Mexican/Argentina numbers
  // Ref: https://faq.whatsapp.com/1294841057948784
  else if (number.startsWith('52') || number.startsWith('54')) {
    let prefix = '';
    if (number.startsWith('52')) {
      prefix = '1';
    }
    if (number.startsWith('54')) {
      prefix = '9';
    }

    const numberWithDigit =
      number.slice(2, 3) === prefix && number.length === 13
        ? number
        : `${number.slice(0, 2)}${prefix}${number.slice(2)}`;
    const numberWithoutDigit = number.length === 12 ? number : number.slice(0, 2) + number.slice(3);

    numbersAvailable.push(numberWithDigit);
    numbersAvailable.push(numberWithoutDigit);
  }

  // Other countries
  else {
    // Só o número: o domínio é acrescentado abaixo. Empurrar o remoteJid inteiro gerava
    // 'X@s.whatsapp.net@s.whatsapp.net', variação que nunca casava com nada.
    numbersAvailable.push(number);
  }

  return numbersAvailable.map((number) => `${number}@${domain}`);
}
