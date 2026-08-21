import { SerialQueue } from '@api/integrations/chatbot/chatwoot/utils/serial-queue';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const noopErrors = () => {
  const errors: Array<{ key: string; error: unknown }> = [];
  return { errors, handler: (key: string, error: unknown) => errors.push({ key, error }) };
};

async function sameKeyRunsInOrder() {
  const { handler } = noopErrors();
  const queue = new SerialQueue(handler);
  const order: number[] = [];

  // A primeira task é a mais lenta: sem serialização, ela terminaria por último.
  queue.enqueue('conv-1', async () => {
    await sleep(40);
    order.push(1);
  });
  queue.enqueue('conv-1', async () => {
    await sleep(5);
    order.push(2);
  });
  queue.enqueue('conv-1', async () => {
    order.push(3);
  });

  await queue.drain();

  assert.deepEqual(order, [1, 2, 3], 'tasks da mesma chave devem rodar em ordem de chegada');
}

async function differentKeysRunConcurrently() {
  const { handler } = noopErrors();
  const queue = new SerialQueue(handler);
  let aStarted = false;
  let bStartedWhileARunning = false;

  queue.enqueue('conv-1', async () => {
    aStarted = true;
    await sleep(40);
  });
  queue.enqueue('conv-2', async () => {
    bStartedWhileARunning = aStarted;
  });

  await queue.drain();

  assert.equal(bStartedWhileARunning, true, 'chaves diferentes não devem bloquear umas às outras');
}

async function failingTaskDoesNotBreakTheChain() {
  const { errors, handler } = noopErrors();
  const queue = new SerialQueue(handler);
  const order: string[] = [];

  queue.enqueue('conv-1', async () => {
    order.push('antes');
  });
  queue.enqueue('conv-1', async () => {
    throw new Error('falha proposital');
  });
  queue.enqueue('conv-1', async () => {
    order.push('depois');
  });

  await queue.drain();

  assert.deepEqual(order, ['antes', 'depois'], 'uma task que falha não pode impedir as seguintes');
  assert.equal(errors.length, 1, 'o erro deve ser reportado uma única vez');
  assert.equal(errors[0].key, 'conv-1');
}

async function rejectsBeyondTheLimit() {
  const { errors, handler } = noopErrors();
  const queue = new SerialQueue(handler, 2);
  const done: number[] = [];

  const first = queue.enqueue('conv-1', async () => {
    await sleep(20);
    done.push(1);
  });
  const second = queue.enqueue('conv-1', async () => {
    done.push(2);
  });
  const third = queue.enqueue('conv-1', async () => {
    done.push(3);
  });

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(third, false, 'a task acima do teto deve ser recusada');

  await queue.drain();

  assert.deepEqual(done, [1, 2], 'a task recusada não pode executar');
  assert.equal(errors.length, 1, 'o descarte deve ser reportado');
}

async function releasesMemoryWhenIdle() {
  const { handler } = noopErrors();
  const queue = new SerialQueue(handler);

  queue.enqueue('conv-1', async () => sleep(5));
  queue.enqueue('conv-2', async () => sleep(5));

  await queue.drain();

  assert.equal(queue.size, 0, 'o mapa de cadeias deve esvaziar quando tudo termina');
  assert.equal(queue.pendingFor('conv-1'), 0);
}

async function brokenErrorReporterDoesNotKillTheKey() {
  // Se o próprio relato de erro lançar, a cadeia não pode rejeitar: isso deixaria
  // todas as mensagens seguintes daquela conversa presas para sempre.
  const queue = new SerialQueue(() => {
    throw new Error('logger quebrado');
  });
  const order: string[] = [];

  queue.enqueue('conv-1', async () => {
    throw new Error('falha proposital');
  });
  queue.enqueue('conv-1', async () => {
    order.push('depois');
  });

  await queue.drain();

  assert.deepEqual(order, ['depois'], 'a chave não pode morrer quando o onError lança');
  assert.equal(queue.pendingFor('conv-1'), 0, 'o contador de pendentes não pode vazar');
  assert.equal(queue.size, 0);
}

async function hangingTaskReleasesTheChain() {
  const { errors, handler } = noopErrors();
  const queue = new SerialQueue(handler, 100, 30);
  const order: string[] = [];

  // Uma requisição HTTP sem timeout pode nunca resolver; a conversa inteira ficaria travada.
  queue.enqueue('conv-1', () => new Promise(() => undefined));
  queue.enqueue('conv-1', async () => {
    order.push('depois');
  });

  await queue.drain();

  assert.deepEqual(order, ['depois'], 'uma task travada não pode bloquear a fila para sempre');
  assert.equal(errors.length, 1, 'o destravamento deve ser reportado');
  assert.match(String((errors[0].error as Error).message), /30ms/);
}

async function synchronousThrowIsCaught() {
  const { errors, handler } = noopErrors();
  const queue = new SerialQueue(handler);
  const order: string[] = [];

  queue.enqueue('conv-1', (() => {
    throw new Error('erro síncrono');
  }) as () => Promise<unknown>);
  queue.enqueue('conv-1', async () => {
    order.push('depois');
  });

  await queue.drain();

  assert.deepEqual(order, ['depois'], 'uma task que lança de forma síncrona não pode quebrar a cadeia');
  assert.equal(errors.length, 1);
}

const tests = [
  sameKeyRunsInOrder,
  differentKeysRunConcurrently,
  failingTaskDoesNotBreakTheChain,
  rejectsBeyondTheLimit,
  releasesMemoryWhenIdle,
  brokenErrorReporterDoesNotKillTheKey,
  hangingTaskReleasesTheChain,
  synchronousThrowIsCaught,
];

(async () => {
  let failed = 0;

  // Os timers de timeout da fila usam unref() para não atrasar o shutdown do servidor.
  // Numa task que nunca resolve, isso deixaria o processo sem nenhum handle ativo e o
  // Node sairia antes do timeout disparar — então ancoramos o event loop aqui.
  const keepAlive = setInterval(() => undefined, 1000);

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

  clearInterval(keepAlive);

  console.log(`\n${tests.length - failed}/${tests.length} passaram`);
  process.exit(failed === 0 ? 0 : 1);
})();
