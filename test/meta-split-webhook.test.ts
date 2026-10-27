import { payloadForEntry } from '@api/integrations/channel/meta/split-webhook';
import assert from 'node:assert/strict';

const entry = (phoneNumberId: string, text: string) => ({
  id: `waba-${phoneNumberId}`,
  changes: [
    {
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: phoneNumberId },
        messages: [{ id: `wamid.${text}`, type: 'text', text: { body: text } }],
      },
    },
  ],
});

function cadaInstanciaRecebeSoOProprioEntry() {
  // Um POST da Meta com mensagens de dois números: a instância do número 222 não pode
  // processar a mensagem do 111 (o serviço lê sempre entry[0]).
  const data = { object: 'whatsapp_business_account', entry: [entry('111', 'de A'), entry('222', 'de B')] };
  const forB = payloadForEntry(data, data.entry[1]);
  assert.equal(forB.entry.length, 1);
  assert.equal(forB.entry[0].changes[0].value.metadata.phone_number_id, '222');
  assert.equal(forB.entry[0].changes[0].value.messages[0].text.body, 'de B');
  assert.equal(forB.object, 'whatsapp_business_account');
}

function umEntrySoFicaIgual() {
  const data = { object: 'whatsapp_business_account', entry: [entry('111', 'de A')] };
  assert.deepEqual(payloadForEntry(data, data.entry[0]), data);
}

function naoMutaOPayloadOriginal() {
  const data = { object: 'whatsapp_business_account', entry: [entry('111', 'a'), entry('222', 'b')] };
  payloadForEntry(data, data.entry[1]);
  assert.equal(data.entry.length, 2);
}

const tests = [cadaInstanciaRecebeSoOProprioEntry, umEntrySoFicaIgual, naoMutaOPayloadOriginal];

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
