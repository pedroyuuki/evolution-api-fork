import { resolveInstanceParams } from '@api/abstract/instance-params';
import { isRoute } from '@api/guards/route-match';
import assert from 'node:assert/strict';

// Os guards validam `:instanceName` do path; nada depois deles pode trocar a instância.

function queryNaoTrocaAInstancia() {
  const instance = resolveInstanceParams({ instanceName: 'A' }, { instanceName: 'B', page: '2' }, {}, false);
  assert.equal(instance.instanceName, 'A', '?instanceName=B não pode agir na instância B');
  assert.equal((instance as any).page, '2', 'os outros campos da query continuam valendo');
}

function queryNaoDefineInstanceId() {
  const instance = resolveInstanceParams({ instanceName: 'A' }, { instanceId: 'id-de-B' }, {}, false);
  assert.equal(instance.instanceId, undefined);
}

function rotaSemInstanciaNoPathMantemOFiltroDaQuery() {
  // GET /instance/fetchInstances?instanceId=X (manager, chave global): a query É o filtro.
  const instance = resolveInstanceParams({}, { instanceId: 'id-B', instanceName: 'B' }, {}, false);
  assert.equal(instance.instanceId, 'id-B');
  assert.equal(instance.instanceName, 'B');
}

function naoMutaParams() {
  const params = { instanceName: 'A' };
  resolveInstanceParams(params, { page: '2' }, {}, false);
  assert.deepEqual(params, { instanceName: 'A' });
}

function createUsaOBody() {
  const instance = resolveInstanceParams({}, undefined, { instanceName: 'nova', qrcode: true }, true);
  assert.equal(instance.instanceName, 'nova');
  assert.equal(instance.qrcode, true);
}

function foraDoCreateOBodyNaoEntra() {
  const instance = resolveInstanceParams({ instanceName: 'A' }, {}, { instanceName: 'B' }, false);
  assert.equal(instance.instanceName, 'A');
}

const req = (baseUrl: string, routePath: string | undefined, originalUrl: string) =>
  ({ baseUrl, route: routePath ? { path: routePath } : undefined, path: routePath ?? '/', originalUrl }) as any;

function rotaExataDoCreate() {
  assert.equal(isRoute(req('/instance', '/create', '/instance/create'), '/instance/create'), true);
}

function queryNaoViraRotaDoCreate() {
  const r = req('/message', '/sendText/:instanceName', '/message/sendText/A?x=/instance/create');
  assert.equal(isRoute(r, '/instance/create'), false);
}

function queryNaoViraRotaGlobal() {
  const r = req('/message', '/sendText/:instanceName', '/message/sendText/A?x=/instance/fetchInstances');
  assert.equal(isRoute(r, '/instance/fetchInstances'), false);
  assert.equal(isRoute(req('/instance', '/fetchInstances', '/instance/fetchInstances?instanceName=A'), '/instance/fetchInstances'), true);
}

const tests = [
  queryNaoTrocaAInstancia,
  queryNaoDefineInstanceId,
  rotaSemInstanciaNoPathMantemOFiltroDaQuery,
  naoMutaParams,
  createUsaOBody,
  foraDoCreateOBodyNaoEntra,
  rotaExataDoCreate,
  queryNaoViraRotaDoCreate,
  queryNaoViraRotaGlobal,
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
