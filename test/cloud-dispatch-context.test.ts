import { pickDispatchForSync } from '@api/integrations/channel/meta/dispatch-context';
import { KeyedMutex } from '@utils/keyedMutex';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mutexSerializaPorChave() {
  const mutex = new KeyedMutex();
  const done: string[] = [];
  const started = Date.now();
  await Promise.all([
    mutex.runExclusive('a', async () => {
      await sleep(50);
      done.push('a1');
    }, 1000),
    mutex.runExclusive('a', async () => {
      done.push('a2');
    }, 1000),
    mutex.runExclusive('b', async () => {
      await sleep(50);
      done.push('b1');
    }, 1000),
  ]);
  assert.ok(done.indexOf('a1') < done.indexOf('a2'), 'a 2ª mensagem do contato espera a 1ª');
  assert.ok(Date.now() - started < 90, 'contatos diferentes não esperam um pelo outro');
}

async function mutexNaoTravaNoTimeout() {
  const mutex = new KeyedMutex();
  void mutex.runExclusive('a', () => new Promise(() => undefined), 1000);
  const result = await mutex.runExclusive('a', async () => 'segue', 30);
  assert.equal(result, 'segue', 'uma sincronização travada não segura a mensagem do cliente');
}

async function mutexRepassaOErro() {
  const mutex = new KeyedMutex();
  await assert.rejects(mutex.runExclusive('a', async () => Promise.reject(new Error('x')), 100));
  assert.equal(await mutex.runExclusive('a', async () => 'depois', 100), 'depois', 'um erro não trava a chave');
}

async function escolheOMaisRecenteEPulaOsDemais() {
  const now = 1_800_000_000;
  const h = 3600;
  const picked = pickDispatchForSync(
    [
      { id: 'v', messageTimestamp: now - 100 * h, status: 'DELIVERED' },
      { id: 'f', messageTimestamp: now - 1 * h, status: 'FAILED' },
      { id: 'a', messageTimestamp: now - 10 * h, status: 'DELIVERED' },
      { id: 'b', messageTimestamp: now - 2 * h, status: 'READ' },
    ],
    now,
    72,
  );
  assert.deepEqual(picked, { sync: 'b', skip: ['a'] });
}

async function nadaElegivel() {
  assert.deepEqual(pickDispatchForSync([], 1_800_000_000, 72), { sync: null, skip: [] });
  assert.deepEqual(
    pickDispatchForSync([{ id: 'f', messageTimestamp: 1_800_000_000, status: 'FAILED' }], 1_800_000_000, 72),
    { sync: null, skip: [] },
  );
}

async function statusPendenteTambemVale() {
  // Resposta antes do primeiro status da Meta chegar: a mensagem ainda está PENDING/SERVER_ACK.
  const now = 1_800_000_000;
  assert.equal(pickDispatchForSync([{ id: 'p', messageTimestamp: now - 5, status: 'PENDING' }], now, 72).sync, 'p');
  assert.equal(pickDispatchForSync([{ id: 'n', messageTimestamp: now - 5, status: null }], now, 72).sync, 'n');
}

const tests = [
  mutexSerializaPorChave,
  mutexNaoTravaNoTimeout,
  mutexRepassaOErro,
  escolheOMaisRecenteEPulaOsDemais,
  nadaElegivel,
  statusPendenteTambemVale,
];

(async () => {
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      console.log(`  ok  ${test.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${test.name}`);
      console.error(error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passaram`);
  process.exit(failed === 0 ? 0 : 1);
})();
