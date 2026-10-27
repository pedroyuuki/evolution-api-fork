import { isolateCallsPerScope, ProviderScope } from '@api/integrations/chatbot/chatwoot/utils/provider-context';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reproduz o desenho do ChatwootService: campo compartilhado + await no meio. */
class Service {
  public storage = new AsyncLocalStorage<ProviderScope>();
  private fallback: string;

  constructor(isolated: boolean) {
    if (isolated) isolateCallsPerScope(this, this.storage);
  }

  private get provider(): string {
    return (this.storage.getStore()?.provider as string) ?? this.fallback;
  }

  private set provider(value: string) {
    const scope = this.storage.getStore();
    if (scope) scope.provider = value;
    this.fallback = value;
  }

  public async findInbox(instance: string, delayMs: number) {
    this.provider = instance; // clientCw(instance)
    await sleep(delayMs); // client.inboxes.list(...)
    return this.inboxName(); // getClientCwConfig().nameInbox
  }

  public inboxName() {
    return `caixa de ${this.provider}`;
  }
}

async function sharedFieldReproducesTheRace() {
  const service = new Service(false);
  const [cloud, demo] = await Promise.all([service.findInbox('NexaAI-Cloud', 40), service.findInbox('Nexa-DEMO-1', 5)]);
  assert.equal(cloud, 'caixa de Nexa-DEMO-1', 'sem isolamento a Cloud enxerga a configuração da DEMO-1');
  assert.equal(demo, 'caixa de Nexa-DEMO-1');
}

async function isolatedCallsKeepTheirOwnProvider() {
  const service = new Service(true);
  const results = await Promise.all(
    ['NexaAI-Cloud', 'Nexa-DEMO-1', 'Nexa-AI-Bussines'].map((instance, i) => service.findInbox(instance, 40 - i * 15)),
  );
  assert.deepEqual(results, ['caixa de NexaAI-Cloud', 'caixa de Nexa-DEMO-1', 'caixa de Nexa-AI-Bussines']);
}

async function nestedCallsShareTheCallersScope() {
  // Uma chamada interna (método público chamado por outro) vê o provider do chamador.
  const service = new Service(true);
  const name = await service.storage.run({}, async () => {
    await service.findInbox('NexaAI-Cloud', 1);
    return service.inboxName();
  });
  assert.equal(name, 'caixa de NexaAI-Cloud');
}

const tests = [sharedFieldReproducesTheRace, isolatedCallsKeepTheirOwnProvider, nestedCallsShareTheCallersScope];

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
