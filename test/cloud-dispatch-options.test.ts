import {
  dispatchColumns,
  dispatchOptions,
  optionsFromRow,
  resolveRecipientNumber,
} from '@api/integrations/channel/meta/dispatch-options';
import assert from 'node:assert/strict';

function padraoNaoMudaNada() {
  // n8n e sistema de agente não mandam as opções: nada muda para eles.
  assert.equal(dispatchOptions({}), null);
  assert.equal(dispatchOptions({ emitWebhook: true, chatwoot: true }), null);
  assert.equal(dispatchOptions(undefined), null);
  assert.deepEqual(dispatchColumns(null), {});
}

function opcoesFalsasSaoGravadas() {
  assert.deepEqual(dispatchOptions({ chatwoot: false }), { emitWebhook: true, chatwoot: false });
  assert.deepEqual(dispatchOptions({ emitWebhook: false, chatwoot: false }), { emitWebhook: false, chatwoot: false });
  assert.deepEqual(dispatchColumns({ emitWebhook: false, chatwoot: false }), {
    dispatchEmitWebhook: false,
    dispatchChatwoot: false,
  });
}

function linhaAntigaValeComoPadrao() {
  assert.deepEqual(optionsFromRow({}), { emitWebhook: true, chatwoot: true });
  assert.deepEqual(optionsFromRow({ dispatchEmitWebhook: null, dispatchChatwoot: null }), {
    emitWebhook: true,
    chatwoot: true,
  });
  assert.deepEqual(optionsFromRow({ dispatchEmitWebhook: false, dispatchChatwoot: true }), {
    emitWebhook: false,
    chatwoot: true,
  });
  assert.deepEqual(optionsFromRow(null), { emitWebhook: true, chatwoot: true });
}

function numeroSemDdiUsaWaIdSoComDispatch() {
  const meta = { contacts: [{ input: '44997091885', wa_id: '554497091885' }] };
  const opts = { emitWebhook: false, chatwoot: false };
  assert.equal(resolveRecipientNumber('44997091885', meta, opts), '554497091885');
  assert.equal(resolveRecipientNumber('44997091885', meta, null), '44997091885', 'sem dispatch nada muda');
  assert.equal(resolveRecipientNumber('44997091885', {}, opts), '44997091885');
  assert.equal(resolveRecipientNumber('44997091885', undefined, opts), '44997091885');
}

const tests = [padraoNaoMudaNada, opcoesFalsasSaoGravadas, linhaAntigaValeComoPadrao, numeroSemDdiUsaWaIdSoComDispatch];

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
