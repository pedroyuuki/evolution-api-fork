/** Códigos que encerram a sessão de fato: reconectar só geraria outra rejeição. */
const TERMINAL_STATUS_CODES = [
  401, // DisconnectReason.loggedOut
  403, // DisconnectReason.forbidden
  402,
  406,
];

/** DisconnectReason.restartRequired — o servidor pede que o aparelho reabra a conexão. */
const RESTART_REQUIRED = 515;

const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
const SIMPLE_RECONNECT_ATTEMPTS = 3;

export type ReconnectInput = {
  statusCode?: number;
  /** A instância já tem credencial pareada (creds.me / creds.registered). */
  isPaired: boolean;
  /** Falhas consecutivas já contabilizadas, incluindo a atual quando ela conta. */
  attempts: number;
};

export type ReconnectDecision = {
  reconnect: boolean;
  delayMs: number;
  /** Se deve somar no contador que alimenta o backoff e o alerta de indisponibilidade. */
  countsAsFailure: boolean;
  /** Descartar o socket atual e criar outro do zero, em vez de só reabrir. */
  fullRestart: boolean;
};

const IMMEDIATE: ReconnectDecision = { reconnect: true, delayMs: 0, countsAsFailure: false, fullRestart: false };

/**
 * Decide o que fazer quando a conexão com o WhatsApp fecha.
 *
 * O backoff existe para não martelar o servidor durante uma queda de rede de uma sessão
 * já pareada. Ele não pode ser aplicado a dois fechamentos que fazem parte do protocolo:
 *
 * - 515 (restartRequired): logo após a leitura do QR o servidor fecha a conexão e o
 *   aparelho precisa voltar na hora. O celular fica aguardando esse retorno; esperar
 *   o backoff fazia o pareamento falhar com "não foi possível conectar o dispositivo".
 * - Expiração de QR numa instância ainda não pareada: é o ciclo normal de geração de
 *   QR, já limitado por QRCODE_LIMIT. Contá-lo como falha inflava o contador até o teto
 *   de 60s antes mesmo de alguém escanear.
 */
export function decideReconnect({ statusCode, isPaired, attempts }: ReconnectInput): ReconnectDecision {
  if (statusCode !== undefined && TERMINAL_STATUS_CODES.includes(statusCode)) {
    return { reconnect: false, delayMs: 0, countsAsFailure: false, fullRestart: false };
  }

  if (statusCode === RESTART_REQUIRED || !isPaired) {
    return IMMEDIATE;
  }

  const safeAttempts = Math.max(1, attempts);

  return {
    reconnect: true,
    delayMs: Math.min(BASE_DELAY_MS * 2 ** (safeAttempts - 1), MAX_DELAY_MS),
    countsAsFailure: true,
    fullRestart: safeAttempts > SIMPLE_RECONNECT_ATTEMPTS,
  };
}
