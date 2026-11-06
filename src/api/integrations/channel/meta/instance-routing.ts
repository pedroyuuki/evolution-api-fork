/**
 * Qual instância recebe um evento do webhook da Meta quando mais de uma tem o mesmo número
 * (phone_number_id): o `findFirst` sem ordem escolhia qualquer uma, e na prática a instância
 * de disparo "sequestrava" respostas e status da original.
 *
 * Mensagens recebidas vão para a principal: a mais antiga (createdAt nulo = linha antiga =
 * mais antiga; empate pelo id). Status vão para a dona da mensagem (ver meta.controller).
 */
type Candidate = { id: string; name: string; createdAt: Date | null };

export function pickPrimaryInstance<T extends Candidate>(candidates: T[]): T | null {
  if (!candidates.length) return null;
  const time = (c: Candidate) => (c.createdAt ? c.createdAt.getTime() : -Infinity);
  return [...candidates].sort((a, b) => time(a) - time(b) || a.id.localeCompare(b.id))[0];
}

const WARN_EVERY_MS = 10 * 60_000;

/** Aviso de número duplicado no log, no máximo uma vez a cada 10 min por número. */
export function shouldWarnDuplicate(number: string, nowMs: number, lastWarned: Map<string, number>): boolean {
  const last = lastWarned.get(number);
  if (last !== undefined && nowMs - last < WARN_EVERY_MS) return false;
  lastWarned.set(number, nowMs);
  return true;
}
