import { canUseInstance, resolvePrincipal } from '@api/integrations/event/websocket/websocket-access';
import assert from 'node:assert/strict';

const base = {
  allowedHosts: '127.0.0.1,::1',
  globalKey: 'GLOBAL',
  findInstanceNameByToken: async (token: string) => (token === 'token-de-A' ? 'A' : null),
};

async function hostLiberadoEhGlobal() {
  assert.deepEqual(await resolvePrincipal({ ...base, remoteAddress: '127.0.0.1' }), { global: true });
}

async function todosOsHostsLiberados() {
  assert.deepEqual(await resolvePrincipal({ ...base, allowedHosts: '*', remoteAddress: '10.0.0.9' }), { global: true });
}

async function chaveGlobalEhGlobal() {
  assert.deepEqual(await resolvePrincipal({ ...base, apiKey: 'GLOBAL', remoteAddress: '10.0.0.9' }), { global: true });
}

async function tokenDeInstanciaFicaPresoAEla() {
  assert.deepEqual(await resolvePrincipal({ ...base, apiKey: 'token-de-A', remoteAddress: '10.0.0.9' }), {
    global: false,
    instanceName: 'A',
  });
}

async function tokenInvalidoOuAusenteEhRecusado() {
  assert.equal(await resolvePrincipal({ ...base, apiKey: 'outro', remoteAddress: '10.0.0.9' }), null);
  assert.equal(await resolvePrincipal({ ...base, remoteAddress: '10.0.0.9' }), null);
}

async function instanciaSoAcessaASi() {
  assert.equal(canUseInstance({ global: false, instanceName: 'A' }, 'B'), false, 'token de A não lê nem envia por B');
  assert.equal(canUseInstance({ global: false, instanceName: 'A' }, 'A'), true);
  assert.equal(canUseInstance({ global: true }, 'B'), true);
  assert.equal(canUseInstance(null, 'A'), false);
  assert.equal(canUseInstance(undefined, 'A'), false);
}

const tests = [
  hostLiberadoEhGlobal,
  todosOsHostsLiberados,
  chaveGlobalEhGlobal,
  tokenDeInstanciaFicaPresoAEla,
  tokenInvalidoOuAusenteEhRecusado,
  instanciaSoAcessaASi,
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
