import {
  canonicalizeKey,
  chooseLidValue,
  extractLidPnPairs,
  getAvailableNumbers,
  lidsNeedingResolution,
  planLidMappingUpdate,
} from '@utils/jidIdentity';
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


const GROUP = '120363430145296423@g.us';

function canonicalSwapsLidAddressedMessage() {
  // Contrato do upstream (swap recíproco): número em remoteJid, LID em remoteJidAlt.
  const key = canonicalizeKey({ id: 'X', fromMe: false, remoteJid: LID, remoteJidAlt: PN, addressingMode: 'lid' });
  assert.equal(key.remoteJid, PN);
  assert.equal(key.remoteJidAlt, LID);
  assert.equal(key.addressingMode, 'pn');
  assert.equal(key.id, 'X', 'demais campos preservados');
}

function canonicalUsesResolvedPairWhenAltIsMissing() {
  // Mensagens do histórico chegam só com o LID: a resolução vem do banco/Baileys.
  const key = canonicalizeKey({ id: 'X', remoteJid: LID }, new Map([[LID, PN]]));
  assert.equal(key.remoteJid, PN);
  assert.equal(key.remoteJidAlt, LID);
  assert.equal(key.addressingMode, 'pn');
}

function canonicalLeavesUnresolvedLidUntouched() {
  // Sem par conhecido, nada muda — nem o addressingMode, que o Chatwoot ainda usa para
  // decidir de onde tirar o número (ajuste do lado do Chatwoot é a etapa 3).
  const original = { id: 'X', remoteJid: LID };
  assert.deepEqual(canonicalizeKey(original), original);
}

function canonicalKeepsPnAddressedMessage() {
  const original = { id: 'X', remoteJid: PN, remoteJidAlt: LID, addressingMode: 'pn' };
  assert.deepEqual(canonicalizeKey(original), original);
}

function canonicalSwapsGroupParticipantNotGroupJid() {
  const key = canonicalizeKey({ id: 'X', remoteJid: GROUP, participant: LID, participantAlt: PN, addressingMode: 'lid' });
  assert.equal(key.remoteJid, GROUP, 'o JID do grupo nunca muda');
  assert.equal(key.participant, PN);
  assert.equal(key.participantAlt, LID);
  assert.equal(key.addressingMode, 'pn');
}

function canonicalNeverMutatesInput() {
  // A chave original é usada em chamadas de protocolo (readMessages, download de mídia)
  // e precisa continuar exatamente como o WhatsApp entregou.
  const original = { id: 'X', remoteJid: LID, remoteJidAlt: PN, addressingMode: 'lid' };
  const snapshot = { ...original };
  const key = canonicalizeKey(original);
  assert.deepEqual(original, snapshot, 'a chave de entrada não pode ser alterada');
  assert.notEqual(key, original);
}

function lidsNeedingResolutionOnlyWhenAltIsMissing() {
  assert.deepEqual(lidsNeedingResolution({ remoteJid: LID }), [LID]);
  assert.deepEqual(lidsNeedingResolution({ remoteJid: LID, remoteJidAlt: PN }), [], 'já tem o número');
  assert.deepEqual(lidsNeedingResolution({ remoteJid: PN }), []);
  assert.deepEqual(lidsNeedingResolution({ remoteJid: GROUP, participant: '85049596768352:9@lid' }), [LID]);
  assert.deepEqual(lidsNeedingResolution({ remoteJid: 'status@broadcast' }), []);
  assert.deepEqual(lidsNeedingResolution(undefined), []);
}

function planSetsLidColumnWhenEmptyOrFlag() {
  const plan = planLidMappingUpdate({ lid: 'lid', jidOptions: PN }, LID);
  assert.equal(plan.lid, LID);
  assert.equal(plan.jidOptions, [LID, PN].sort().join(','), 'o LID também entra nas variações do número');
}

function planKeepsFirstLidAndStoresSecondInJidOptions() {
  // Visto no QA: 555197821273 tem dois LIDs no Baileys. A coluna guarda um; o segundo
  // não pode sobrescrever o primeiro (os dois ficariam alternando), vai para jidOptions.
  const SECOND = '132328009502871@lid';
  const plan = planLidMappingUpdate({ lid: LID, jidOptions: [LID, PN].join(',') }, SECOND);
  assert.equal(plan.lid, undefined, 'a coluna lid não muda');
  assert.equal(plan.jidOptions, [SECOND, LID, PN].sort().join(','));
}

function planIsNoopWhenAlreadyKnown() {
  const plan = planLidMappingUpdate({ lid: LID, jidOptions: [LID, PN].sort().join(',') }, LID);
  assert.deepEqual(plan, { lid: undefined, jidOptions: undefined }, 'nada a gravar');
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
  canonicalSwapsLidAddressedMessage,
  canonicalUsesResolvedPairWhenAltIsMissing,
  canonicalLeavesUnresolvedLidUntouched,
  canonicalKeepsPnAddressedMessage,
  canonicalSwapsGroupParticipantNotGroupJid,
  canonicalNeverMutatesInput,
  lidsNeedingResolutionOnlyWhenAltIsMissing,
  planSetsLidColumnWhenEmptyOrFlag,
  planKeepsFirstLidAndStoresSecondInJidOptions,
  planIsNoopWhenAlreadyKnown,
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
