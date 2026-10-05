import {
  ChatwootWebhookDispatcher,
  pickNextJob,
  WebhookJob,
  webhookJobId,
  WebhookJobStore,
} from '@api/integrations/chatbot/chatwoot/utils/webhook-dispatcher';
import assert from 'node:assert/strict';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Store em memória com as mesmas regras do Redis: pendente e concluído por id. */
class MemoryStore implements WebhookJobStore {
  public readonly pending = new Map<string, WebhookJob>();
  public readonly done = new Set<string>();
  public failSave = false;

  private key(job: WebhookJob) {
    return `${job.instanceName}:${job.id}`;
  }
  async save(job: WebhookJob) {
    if (this.failSave) throw new Error('redis fora');
    this.pending.set(this.key(job), job);
  }
  async remove(job: WebhookJob) {
    this.pending.delete(this.key(job));
  }
  async list() {
    return [...this.pending.values()];
  }
  async markDone(job: WebhookJob) {
    this.done.add(this.key(job));
  }
  async isDone(job: WebhookJob) {
    return this.done.has(this.key(job));
  }
  async isPending(job: WebhookJob) {
    return this.pending.has(this.key(job));
  }
}

const message = (id: number, conversation = 8, extra: any = {}) => ({
  event: 'message_created',
  id,
  message_type: 'outgoing',
  conversation: { id: conversation },
  ...extra,
});

function setup(overrides: Partial<ConstructorParameters<typeof ChatwootWebhookDispatcher>[0]> = {}) {
  const store = (overrides.store as MemoryStore) ?? new MemoryStore();
  const handled: any[] = [];
  const expired: any[] = [];
  const errors: string[] = [];
  const dispatcher = new ChatwootWebhookDispatcher({
    store,
    handle: async (job) => {
      handled.push(job.body);
    },
    onExpired: async (job) => {
      expired.push(job.body);
    },
    onError: (context) => errors.push(context),
    isReady: () => true,
    orderWindowMs: 20,
    recoveryPollMs: 20,
    ...overrides,
    store,
  });
  return { dispatcher, store, handled, expired, errors };
}

async function acceptedJobIsPersistedUntilDone() {
  let release: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { dispatcher, store } = setup({ handle: () => gate });

  assert.equal(await dispatcher.accept('qa', message(1)), 'accepted');
  assert.equal(store.pending.size, 1, 'gravado antes de processar: sobrevive a um reinício');

  release();
  await dispatcher.stop(1_000);
  assert.equal(store.pending.size, 0, 'sai do store ao terminar');
  assert.ok(store.done.has('qa:message_created-1'), 'marcado como concluído');
}

async function duplicateDeliveryIsProcessedOnce() {
  const { dispatcher, handled } = setup();

  const results = await Promise.all([
    dispatcher.accept('qa', message(1)),
    dispatcher.accept('qa', message(1)), // entrega simultânea do mesmo evento
  ]);
  assert.deepEqual(results.sort(), ['accepted', 'duplicate']);
  await sleep(80);

  assert.equal(await dispatcher.accept('qa', message(1)), 'duplicate', 'repetição depois de concluído');
  await dispatcher.stop(1_000);
  assert.equal(handled.length, 1);
}

async function sameMessageIdInOtherInstanceIsNotDuplicate() {
  const { dispatcher, handled } = setup();
  await dispatcher.accept('qa-1', message(1));
  await dispatcher.accept('qa-2', message(1));
  await dispatcher.stop(1_000);
  assert.equal(handled.length, 2);
}

async function messagesOfAConversationFollowChatwootIdOrder() {
  const { dispatcher, handled } = setup();
  // O Sidekiq dispara em paralelo: chegam 3, 1, 2.
  await dispatcher.accept('qa', message(3));
  await dispatcher.accept('qa', message(1));
  await dispatcher.accept('qa', message(2));
  await dispatcher.stop(1_000);
  assert.deepEqual(
    handled.map((body) => body.id),
    [1, 2, 3],
  );
}

async function statusEventsAreNotDeduplicatedAndKeepArrivalOrder() {
  const { dispatcher, handled } = setup();
  const status = (s: string) => ({ event: 'conversation_status_changed', id: 8, status: s });
  await dispatcher.accept('qa', status('resolved'));
  await dispatcher.accept('qa', status('open')); // mesmo id, evento diferente
  await dispatcher.stop(1_000);
  assert.deepEqual(
    handled.map((body) => body.status),
    ['resolved', 'open'],
  );
}

async function conversationsRunInParallel() {
  const { dispatcher, handled } = setup({
    handle: async (job) => {
      if (job.body.conversation.id === 1) await sleep(150);
      handled.push(job.body.conversation.id);
    },
  });
  await dispatcher.accept('qa', message(1, 1));
  await dispatcher.accept('qa', message(2, 2));
  await dispatcher.stop(1_000);
  assert.deepEqual(handled, [2, 1], 'a conversa lenta não segura a outra');
}

async function failingHandlerIsReportedAndCompleted() {
  const { dispatcher, store, errors } = setup({
    handle: async () => {
      throw new Error('boom');
    },
  });
  await dispatcher.accept('qa', message(1));
  await dispatcher.stop(1_000);
  assert.equal(errors.length, 1);
  assert.equal(store.pending.size, 0, 'não fica preso no store para sempre');
}

async function storeOutageStillDeliversInMemory() {
  const { dispatcher, store, handled, errors } = setup();
  store.failSave = true;
  assert.equal(await dispatcher.accept('qa', message(1)), 'accepted');
  await dispatcher.stop(1_000);
  assert.equal(handled.length, 1, 'perder durabilidade é melhor que perder a mensagem');
  assert.ok(errors.some((e) => e.startsWith('store indisponível')));
}

async function recoveryWaitsForInstanceAndResumesInOrder() {
  const store = new MemoryStore();
  const old = Date.now() - 1_000;
  for (const [id, offset] of [
    [2, 20],
    [1, 10],
  ]) {
    await store.save({
      id: webhookJobId(message(id)),
      instanceName: 'qa',
      queueKey: 'qa:8',
      body: message(id),
      receivedAt: old + offset,
    });
  }

  let ready = false;
  const { dispatcher, handled } = setup({ store, isReady: () => ready });

  assert.equal(await dispatcher.recover(), 2);
  await sleep(60);
  assert.equal(handled.length, 0, 'instância ainda conectando: espera');

  ready = true;
  await sleep(150);
  assert.deepEqual(
    handled.map((body) => body.id),
    [1, 2],
  );
  assert.equal(store.pending.size, 0);
  await dispatcher.stop(1_000);
}

async function staleRecoveredMessageBecomesNotice() {
  const store = new MemoryStore();
  await store.save({
    id: webhookJobId(message(1)),
    instanceName: 'qa',
    queueKey: 'qa:8',
    body: message(1),
    receivedAt: Date.now() - 60 * 60_000,
  });
  const { dispatcher, handled, expired } = setup({ store, isReady: () => false });

  await dispatcher.recover();
  await sleep(80);
  assert.equal(handled.length, 0, 'mensagem de uma hora atrás não é enviada fora de contexto');
  assert.equal(expired.length, 1, 'o atendente é avisado mesmo sem a instância conectar');
  assert.equal(store.pending.size, 0);
  await dispatcher.stop(1_000);
}

async function completedOrphanIsDroppedNotResent() {
  // Morte entre markDone e remove: o pendente sobra, mas o envio já aconteceu.
  const store = new MemoryStore();
  const job = { id: webhookJobId(message(1)), instanceName: 'qa', queueKey: 'qa:8', body: message(1), receivedAt: Date.now() - 1_000 };
  await store.save(job);
  await store.markDone(job);
  const { dispatcher, handled } = setup({ store });

  assert.equal(await dispatcher.recover(), 0);
  await sleep(80);
  assert.equal(handled.length, 0, 'não reenvia o que já foi entregue');
  assert.equal(store.pending.size, 0, 'e limpa o pendente que sobrou');
  await dispatcher.stop(1_000);
}

async function jobsOfThisProcessAreNotRecoveredTwice() {
  const { dispatcher, handled } = setup();
  await dispatcher.accept('qa', message(1));
  assert.equal(await dispatcher.recover(), 0, 'o job é deste processo, não é órfão');
  await dispatcher.stop(1_000);
  assert.equal(handled.length, 1);
}

async function stopRefusesNewWorkAndHonorsTimeout() {
  const { dispatcher, store } = setup({ handle: () => sleep(300) });
  await dispatcher.accept('qa', message(1));

  const started = Date.now();
  const drained = await dispatcher.stop(50);
  assert.equal(drained, false);
  assert.ok(Date.now() - started < 250, 'não espera além do prazo');
  assert.equal(await dispatcher.accept('qa', message(2)), 'stopping');
  assert.equal(store.pending.size, 1, 'o que não terminou continua no store para o próximo processo');
}

function pickNextPrefersLowestMessageIdButKeepsOtherEventsFifo() {
  const job = (body: any): WebhookJob => ({ id: 'x', instanceName: 'qa', queueKey: 'k', body, receivedAt: 0 });
  const status = job({ event: 'conversation_status_changed', id: 99 });
  assert.equal(pickNextJob([status, job(message(5)), job(message(4))]), status);
  assert.equal(pickNextJob([job(message(5)), status, job(message(4))]).body.id, 4);
  assert.equal(pickNextJob([]), undefined);
}

const tests = [
  acceptedJobIsPersistedUntilDone,
  duplicateDeliveryIsProcessedOnce,
  sameMessageIdInOtherInstanceIsNotDuplicate,
  messagesOfAConversationFollowChatwootIdOrder,
  statusEventsAreNotDeduplicatedAndKeepArrivalOrder,
  conversationsRunInParallel,
  failingHandlerIsReportedAndCompleted,
  storeOutageStillDeliversInMemory,
  recoveryWaitsForInstanceAndResumesInOrder,
  staleRecoveredMessageBecomesNotice,
  completedOrphanIsDroppedNotResent,
  jobsOfThisProcessAreNotRecoveredTwice,
  stopRefusesNewWorkAndHonorsTimeout,
  pickNextPrefersLowestMessageIdButKeepsOtherEventsFifo,
];

(async () => {
  let failed = 0;
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
