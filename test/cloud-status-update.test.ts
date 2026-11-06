import { buildStatusUpdate } from '@api/integrations/channel/meta/status-update';
import assert from 'node:assert/strict';

const base = { messageId: 'm1', keyId: 'wamid.X', remoteJid: '554497091885@s.whatsapp.net', fromMe: true, instanceId: 'i1' };

function falhaLevaErrorsCompletoEErrorLegado() {
  const errors = [
    {
      code: 131053,
      title: 'Media upload error',
      message: 'Media upload error',
      error_data: { details: 'Video file has size 97917424 bytes' },
    },
  ];
  const update = buildStatusUpdate(base, { status: 'failed', timestamp: '1793540339', errors });
  assert.equal(update.status, 'FAILED');
  assert.equal(update.error.code, 131053, 'o campo error de hoje continua (n8n lê)');
  assert.equal(update.error.details, 'Video file has size 97917424 bytes');
  assert.deepEqual(update.errors, errors, 'o array da Meta como veio');
  assert.equal(update.timestamp, 1793540339);
}

function entregueLevaConversationEPricing() {
  const update = buildStatusUpdate(base, {
    status: 'delivered',
    conversation: { id: 'c1' },
    pricing: { category: 'utility' },
  });
  assert.equal(update.status, 'DELIVERED');
  assert.equal(update.conversation.id, 'c1');
  assert.equal(update.pricing.category, 'utility');
  assert.equal('error' in update, false);
  assert.equal('errors' in update, false);
}

function semCamposOpcionaisNaoInventa() {
  const update = buildStatusUpdate(base, { status: 'read' });
  assert.deepEqual(Object.keys(update).sort(), [...Object.keys(base), 'status'].sort());
}

function errosForaDeFalhaTambemVao() {
  // A Meta pode mandar errors junto de outros status (ex.: aviso); o array vai, o legado só em FAILED.
  const update = buildStatusUpdate(base, { status: 'sent', errors: [{ code: 1 }] });
  assert.deepEqual(update.errors, [{ code: 1 }]);
  assert.equal('error' in update, false);
}

const tests = [
  falhaLevaErrorsCompletoEErrorLegado,
  entregueLevaConversationEPricing,
  semCamposOpcionaisNaoInventa,
  errosForaDeFalhaTambemVao,
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
