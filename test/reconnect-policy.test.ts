import { decideReconnect } from '@utils/reconnectPolicy';
import assert from 'node:assert/strict';

// Códigos do Baileys (DisconnectReason), repetidos aqui para o teste ler como a especificação.
const LOGGED_OUT = 401;
const FORBIDDEN = 403;
const TIMED_OUT = 408;
const CONNECTION_CLOSED = 428;
const RESTART_REQUIRED = 515;

function restartRequiredIsImmediateEvenAfterManyFailures() {
  // Cenário do bug: a instância acumulou falhas enquanto o QR girava, o usuário escaneia,
  // o servidor manda 515 e o celular fica esperando o aparelho voltar. Esperar mata o pareamento.
  const decision = decideReconnect({ statusCode: RESTART_REQUIRED, isPaired: false, attempts: 7 });

  assert.equal(decision.reconnect, true);
  assert.equal(decision.delayMs, 0, 'o reinício pedido pelo protocolo não pode esperar backoff');
  assert.equal(decision.countsAsFailure, false);
  assert.equal(decision.fullRestart, false);
}

function restartRequiredOnPairedSessionIsAlsoImmediate() {
  const decision = decideReconnect({ statusCode: RESTART_REQUIRED, isPaired: true, attempts: 3 });

  assert.equal(decision.delayMs, 0);
  assert.equal(decision.countsAsFailure, false);
}

function qrExpiryWhilePairingIsNotAFailure() {
  // Sem credencial, fechar por QR vencido é o ciclo normal de geração de QR.
  for (const statusCode of [TIMED_OUT, CONNECTION_CLOSED, undefined]) {
    const decision = decideReconnect({ statusCode, isPaired: false, attempts: 10 });

    assert.equal(decision.reconnect, true, `status ${statusCode}`);
    assert.equal(decision.delayMs, 0, `status ${statusCode}: QR não pode atrasar`);
    assert.equal(decision.countsAsFailure, false, `status ${statusCode}: não pode inflar o contador`);
  }
}

function pairedSessionBacksOffExponentially() {
  const delays = [1, 2, 3, 4, 5, 6, 7].map(
    (attempts) => decideReconnect({ statusCode: TIMED_OUT, isPaired: true, attempts }).delayMs,
  );

  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
}

function pairedSessionEscalatesToFullRestartAfterThreeAttempts() {
  const full = [1, 2, 3, 4, 5].map(
    (attempts) => decideReconnect({ statusCode: CONNECTION_CLOSED, isPaired: true, attempts }).fullRestart,
  );

  assert.deepEqual(full, [false, false, false, true, true]);
  assert.equal(decideReconnect({ statusCode: CONNECTION_CLOSED, isPaired: true, attempts: 1 }).countsAsFailure, true);
}

function terminalCodesStopReconnecting() {
  for (const statusCode of [LOGGED_OUT, FORBIDDEN, 402, 406]) {
    for (const isPaired of [true, false]) {
      const decision = decideReconnect({ statusCode, isPaired, attempts: 1 });
      assert.equal(decision.reconnect, false, `status ${statusCode} (paired=${isPaired}) encerra a sessão`);
    }
  }
}

const tests = [
  restartRequiredIsImmediateEvenAfterManyFailures,
  restartRequiredOnPairedSessionIsAlsoImmediate,
  qrExpiryWhilePairingIsNotAFailure,
  pairedSessionBacksOffExponentially,
  pairedSessionEscalatesToFullRestartAfterThreeAttempts,
  terminalCodesStopReconnecting,
];

let failed = 0;

for (const test of tests) {
  try {
    test();
    console.log(`  ok  ${test.name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL  ${test.name}`);
    console.error(error);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passaram`);
process.exit(failed === 0 ? 0 : 1);
