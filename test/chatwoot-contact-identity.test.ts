import {
  contactIdentityFromKey,
  contactLookup,
  displayPhone,
  electBaseContact,
  nameScore,
  participantIdentityFromKey,
  pickInboxConversation,
  planContactLink,
  sameContactCandidates,
} from '@api/integrations/chatbot/chatwoot/utils/contact-identity';
import assert from 'node:assert/strict';

const LID = '85049596768352@lid';
const PN = '554497091885@s.whatsapp.net';
const PN_WITH_NINE = '5544997091885@s.whatsapp.net';
const GROUP = '120363430145296423@g.us';
const IDENTITY = { pnJid: PN, lidJid: LID, primaryJid: PN };
const PHONES = ['5544997091885', '554497091885', '85049596768352'];

function identityFromCanonicalKey() {
  // Formato que a Evolution entrega depois da etapa 2: número no principal, LID no Alt.
  assert.deepEqual(contactIdentityFromKey({ remoteJid: PN, remoteJidAlt: LID }), IDENTITY);
}

function identityFromLidAddressedKeyInAnyOrder() {
  assert.deepEqual(contactIdentityFromKey({ remoteJid: LID, remoteJidAlt: PN }), IDENTITY);
}

function identityWithUnresolvedLidUsesLid() {
  // Antes quebrava: remoteJidAlt undefined virava phoneNumber e o split explodia.
  assert.deepEqual(contactIdentityFromKey({ remoteJid: LID }), { pnJid: undefined, lidJid: LID, primaryJid: LID });
}

function identityOfCloudApiKey() {
  assert.deepEqual(contactIdentityFromKey({ remoteJid: PN }), { pnJid: PN, lidJid: undefined, primaryJid: PN });
}

function groupKeyHasNoContactIdentityButParticipantDoes() {
  const key = { remoteJid: GROUP, participant: PN, participantAlt: LID };
  assert.equal(contactIdentityFromKey(key), undefined);
  assert.deepEqual(participantIdentityFromKey(key), IDENTITY);
  assert.equal(participantIdentityFromKey({ remoteJid: GROUP }), undefined, 'fromMe em grupo pode vir sem participant');
}

function deviceSuffixIsDropped() {
  assert.equal(contactIdentityFromKey({ remoteJid: '554497091885:7@s.whatsapp.net' }).primaryJid, PN);
}

function displayPhoneAddsNinthDigitForBrazilianMobiles() {
  assert.equal(displayPhone(PN), '+5544997091885', 'DDD 44: o JID vem sem o 9, o telefone tem');
  assert.equal(displayPhone('5511987654321@s.whatsapp.net'), '+5511987654321', 'DDD 11 já vem com o 9');
  assert.equal(displayPhone('554432221234@s.whatsapp.net'), '+554432221234', 'fixo não ganha 9');
  assert.equal(displayPhone('34613327359@s.whatsapp.net'), '+34613327359', 'outros países intactos');
}

function lookupCoversNinthDigitVariantsAndLid() {
  const { identifiers, phones } = contactLookup(IDENTITY);
  assert.deepEqual([...identifiers].sort(), [PN_WITH_NINE, PN, LID].sort());
  assert.deepEqual([...phones].sort(), PHONES.map((p) => `+${p}`).sort());
}

function candidatesExcludeContactsOfOtherPeople() {
  const found = [
    { id: 3, identifier: PN, phone_number: '+554497091885' },
    { id: 9, identifier: null, phone_number: '+5544997091885' }, // gêmeo manual do atendente
    { id: 2, identifier: LID, phone_number: '+85049596768352' }, // legado LID
    { id: 7, identifier: '5511999990000@s.whatsapp.net', phone_number: '+5544997091885' }, // outra pessoa
    { id: 8, identifier: '', phone_number: '+5511999990000' }, // veio na busca mas é outro telefone
    { id: 3, identifier: PN, phone_number: '+554497091885' }, // repetido pelas duas buscas
  ];
  assert.deepEqual(
    sameContactCandidates(IDENTITY, found).map((c) => c.id),
    [3, 9, 2],
  );
}

function baseIsContactWithEmailThenOldest() {
  const evolution = { id: 3, created_at: 100, email: null };
  const manual = { id: 9, created_at: 500, email: 'cliente@exemplo.com' };
  const legacy = { id: 2, created_at: 50, email: '  ' };
  assert.equal(electBaseContact([evolution, manual, legacy]).id, 9, 'e-mail elimina, e espaços não contam');
  assert.equal(electBaseContact([evolution, { ...manual, email: null }, legacy]).id, 2, 'sem e-mail: o mais antigo');
  assert.equal(electBaseContact([{ id: 5, created_at: 100 }, { id: 4, created_at: 100 }]).id, 4, 'empate: menor id');
  assert.equal(electBaseContact([{ id: 5 }, { id: 6, created_at: 999 }]).id, 6, 'sem data vai para o fim');
  assert.equal(electBaseContact([]), undefined);
}

function nameScoreRejectsPlaceholders() {
  assert.equal(nameScore(null, PHONES), -1);
  assert.equal(nameScore('554497091885', PHONES), 0, 'nome-número gerado pela Evolution');
  assert.equal(nameScore('Cliente 97091885', PHONES), 0, 'contém o telefone');
  assert.equal(nameScore('+-()', PHONES), 0, 'sem letras');
  assert.ok(nameScore('Miguel Harinton Leiria Neto', PHONES) > nameScore('Miguel', PHONES));
  assert.ok(nameScore('Miguel', PHONES) > 0);
}

function manualTwinWithEmailSurvivesAndGetsCanonicalIdentity() {
  // O cenário relatado: o atendente não achou o contato (9º dígito) e criou outro, com e-mail.
  const plan = planContactLink(IDENTITY, [
    { id: 3, identifier: PN, phone_number: '+554497091885', name: 'Pedro', created_at: 100 },
    { id: 9, identifier: null, phone_number: '+5544997091885', name: 'Pedro Kimura', email: 'p@x.com', created_at: 500 },
  ]);
  assert.deepEqual(plan, { action: 'link', baseId: 9, mergeIds: [3], update: { identifier: PN } });
}

function manualTwinWithoutEmailIsMergedIntoOldestAndNameIsRescued() {
  // Sem e-mail a base é o da Evolution (nome-número); o nome real do gêmeo não pode se perder.
  const plan = planContactLink(IDENTITY, [
    { id: 3, identifier: PN, phone_number: '+554497091885', name: '554497091885', created_at: 100 },
    { id: 9, identifier: null, phone_number: '+5544997091885', name: 'Pedro Kimura', created_at: 500 },
  ]);
  assert.deepEqual(plan, {
    action: 'link',
    baseId: 3,
    mergeIds: [9],
    update: { name: 'Pedro Kimura', phone_number: '+5544997091885' },
  });
}

function equallyGoodNamesKeepTheBaseName() {
  const plan = planContactLink(IDENTITY, [
    { id: 3, identifier: PN, phone_number: '+5544997091885', name: 'Pedro', created_at: 100 },
    { id: 9, identifier: null, phone_number: '+554497091885', name: 'Ana', created_at: 500 },
  ]);
  assert.deepEqual(plan, { action: 'link', baseId: 3, mergeIds: [9], update: undefined });
}

function legacyLidContactIsRelinkedInPlace() {
  // Contato #2 criado com o LID, sem contato do número.
  const plan = planContactLink(IDENTITY, [{ id: 2, identifier: LID, phone_number: '+85049596768352', name: 'Pedro' }]);
  assert.deepEqual(plan, {
    action: 'link',
    baseId: 2,
    mergeIds: [],
    update: { identifier: PN, phone_number: '+5544997091885' },
  });
}

function lidTwinIsMergedIntoNumberContact() {
  // O caso #2 (LID) + #3 (gêmeo pelo número), sem e-mail: vence o mais antigo.
  const plan = planContactLink(IDENTITY, [
    { id: 3, identifier: PN, phone_number: '+5544997091885', name: 'Pedro', created_at: 200 },
    { id: 2, identifier: LID, phone_number: '+85049596768352', name: '85049596768352', created_at: 100 },
  ]);
  assert.deepEqual(plan, {
    action: 'link',
    baseId: 2,
    mergeIds: [3],
    update: { name: 'Pedro', identifier: PN, phone_number: '+5544997091885' },
  });
}

function consolidatedContactNeedsNoUpdate() {
  const plan = planContactLink(IDENTITY, [{ id: 3, identifier: PN, phone_number: '+5544997091885', name: 'Pedro' }]);
  assert.deepEqual(plan, { action: 'link', baseId: 3, mergeIds: [], update: undefined });
}

function unresolvedLidNeverWritesPhone() {
  assert.deepEqual(planContactLink({ lidJid: LID, primaryJid: LID }, [{ id: 2, identifier: LID, name: 'Pedro' }]), {
    action: 'link',
    baseId: 2,
    mergeIds: [],
    update: undefined,
  });
  assert.deepEqual(planContactLink({ lidJid: LID, primaryJid: LID }), { action: 'create', identifier: LID });
}

function newContactUsesNumberWithDisplayPhone() {
  assert.deepEqual(planContactLink(IDENTITY), { action: 'create', identifier: PN, phoneNumber: '+5544997091885' });
}

function mostRecentConversationOfInboxWins() {
  const conversations = [
    { id: 2, inbox_id: 1, last_activity_at: 100, status: 'open' },
    { id: 3, inbox_id: 1, last_activity_at: 300, status: 'resolved' },
    { id: 9, inbox_id: 2, last_activity_at: 999, status: 'open' },
  ];
  assert.equal(pickInboxConversation(conversations, 1).id, 3);
  assert.equal(pickInboxConversation(conversations, 1, (c) => c.status !== 'resolved').id, 2);
  assert.equal(pickInboxConversation(conversations, 5), undefined);
}

const tests = [
  identityFromCanonicalKey,
  identityFromLidAddressedKeyInAnyOrder,
  identityWithUnresolvedLidUsesLid,
  identityOfCloudApiKey,
  groupKeyHasNoContactIdentityButParticipantDoes,
  deviceSuffixIsDropped,
  displayPhoneAddsNinthDigitForBrazilianMobiles,
  lookupCoversNinthDigitVariantsAndLid,
  candidatesExcludeContactsOfOtherPeople,
  baseIsContactWithEmailThenOldest,
  nameScoreRejectsPlaceholders,
  manualTwinWithEmailSurvivesAndGetsCanonicalIdentity,
  manualTwinWithoutEmailIsMergedIntoOldestAndNameIsRescued,
  equallyGoodNamesKeepTheBaseName,
  legacyLidContactIsRelinkedInPlace,
  lidTwinIsMergedIntoNumberContact,
  consolidatedContactNeedsNoUpdate,
  unresolvedLidNeverWritesPhone,
  newContactUsesNumberWithDisplayPhone,
  mostRecentConversationOfInboxWins,
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
