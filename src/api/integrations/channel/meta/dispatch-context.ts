/**
 * Mensagem de disparo (enviada com chatwoot:false) que deve entrar no Chatwoot antes da
 * resposta do cliente, para o atendente ver o que foi enviado.
 *
 * Só a mais recente dentro da janela é levada; as anteriores ainda pendentes do mesmo
 * contato são marcadas como tratadas (duas campanhas seguidas não despejam tudo de uma
 * vez). Disparo que falhou não entra: o cliente não recebeu.
 */
export type DispatchCandidate = { id: string; messageTimestamp: number; status: string | null };

export function pickDispatchForSync(
  rows: DispatchCandidate[],
  nowSec: number,
  windowHours: number,
): { sync: string | null; skip: string[] } {
  const since = nowSec - windowHours * 3600;
  const eligible = rows
    .filter((row) => row.status !== 'FAILED' && row.messageTimestamp >= since)
    .sort((a, b) => b.messageTimestamp - a.messageTimestamp);
  return { sync: eligible[0]?.id ?? null, skip: eligible.slice(1).map((row) => row.id) };
}

/**
 * A mensagem do disparo entrou no Chatwoot. O eventWhatsapp engole os erros e devolve
 * undefined: sem o id da mensagem criada, a reserva precisa voltar para a próxima resposta
 * tentar de novo (senão o disparo ficava marcado e nunca aparecia).
 */
export function syncSucceeded(sent: any): boolean {
  return !!sent?.id;
}
