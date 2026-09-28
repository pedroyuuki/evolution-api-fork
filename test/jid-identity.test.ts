import { chooseLidValue, extractLidPnPairs, getAvailableNumbers } from '@utils/jidIdentity';
import assert from 'node:assert/strict';

const LID = '85049596768352@lid';
const PN = '554497091885@s.whatsapp.net';

function lidAddressedMessageYieldsPair() {
  // Como o Baileys entrega uma mensagem endereçada por LID (observado nas duas instâncias de QA).
  const pairs = extractLidPnPairs({ remoteJid: LID, remoteJidAlt: PN, addressingMode: 'lid' });
  assert.deepEqual(pairs, [{ lid: LID, pn: PN }]);
}

function pnAddressedMessageWithLidAltYieldsPair() {
  const pairs = extractLidPnPairs({ remoteJid: PN, remoteJidAlt: LID, addressingMode: 'pn' });
  assert.deepEqual(pairs, [{ lid: LID, pn: PN }]);
}

function groupParticipantYieldsPairButGroupJidDoesNot() {
  const pairs = extractLidPnPairs({
    remoteJid: '120363430145296423@g.us',
    participant: LID,
    participantAlt: PN,
    addressingMode: 'lid',
  });
  assert.deepEqual(pairs, [{ lid: LID, pn: PN }], 'o JID do grupo nunca vira par');
}

function deviceSuffixIsNormalized() {
  const pairs = extractLidPnPairs({ remoteJid: '85049596768352:12@lid', remoteJidAlt: '554497091885:7@s.whatsapp.net' });
  assert.deepEqual(pairs, [{ lid: LID, pn: PN }], 'o sufixo de aparelho (:N) precisa sair');
}

function incompleteOrSameKindKeysYieldNothing() {
  assert.deepEqual(extractLidPnPairs({ remoteJid: LID }), [], 'sem alt não há par');
  assert.deepEqual(extractLidPnPairs({ remoteJid: PN, remoteJidAlt: PN }), [], 'número com número não é par');
  assert.deepEqual(extractLidPnPairs({ remoteJid: 'status@broadcast', remoteJidAlt: PN }), []);
  assert.deepEqual(extractLidPnPairs(undefined), []);
  assert.deepEqual(extractLidPnPairs({}), []);
}

function chooseLidValueNeverErasesARealLid() {
  // Mensagem sem LID não pode apagar o LID já aprendido: era assim que o par se perdia.
  assert.equal(chooseLidValue({ incoming: undefined, existing: LID, lidAddressed: false }), LID);
  assert.equal(chooseLidValue({ incoming: undefined, existing: LID, lidAddressed: true }), LID);
}

function chooseLidValuePrefersIncomingRealLid() {
  assert.equal(chooseLidValue({ incoming: LID, existing: null, lidAddressed: false }), LID);
  assert.equal(chooseLidValue({ incoming: LID, existing: 'lid', lidAddressed: true }), LID);
}

function chooseLidValueKeepsLegacyFlagBehaviour() {
  // Sem LID real envolvido, o comportamento anterior (flag 'lid' ou null) é preservado.
  assert.equal(chooseLidValue({ incoming: undefined, existing: null, lidAddressed: true }), 'lid');
  assert.equal(chooseLidValue({ incoming: undefined, existing: 'lid', lidAddressed: false }), null);
  assert.equal(chooseLidValue({ incoming: undefined, existing: null, lidAddressed: false }), null);
}

function availableNumbersForOtherCountriesHasSingleDomain() {
  // Antes: '34613327359@s.whatsapp.net@s.whatsapp.net' (visto no banco de QA).
  assert.deepEqual(getAvailableNumbers('34613327359@s.whatsapp.net'), ['34613327359@s.whatsapp.net']);
}

function availableNumbersBrazilKeepsBothVariants() {
  assert.deepEqual(getAvailableNumbers('554497091885@s.whatsapp.net').sort(), [
    '554497091885@s.whatsapp.net',
    '5544997091885@s.whatsapp.net',
  ]);
  assert.deepEqual(getAvailableNumbers(LID), [LID], 'LID não gera variantes');
}

const tests = [
  lidAddressedMessageYieldsPair,
  pnAddressedMessageWithLidAltYieldsPair,
  groupParticipantYieldsPairButGroupJidDoesNot,
  deviceSuffixIsNormalized,
  incompleteOrSameKindKeysYieldNothing,
  chooseLidValueNeverErasesARealLid,
  chooseLidValuePrefersIncomingRealLid,
  chooseLidValueKeepsLegacyFlagBehaviour,
  availableNumbersForOtherCountriesHasSingleDomain,
  availableNumbersBrazilKeepsBothVariants,
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
