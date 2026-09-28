import {
  contactIdentityFromKey,
  displayPhone,
  participantIdentityFromKey,
  pickInboxConversation,
  planContactLink,
} from '@api/integrations/chatbot/chatwoot/utils/contact-identity';
import assert from 'node:assert/strict';

const LID = '85049596768352@lid';
const PN = '554497091885@s.whatsapp.net';
const GROUP = '120363430145296423@g.us';

function identityFromCanonicalKey() {
  // Formato que a Evolution entrega depois da etapa 2: número no principal, LID no Alt.
  assert.deepEqual(contactIdentityFromKey({ remoteJid: PN, remoteJidAlt: LID }), {
    pnJid: PN,
    lidJid: LID,
    primaryJid: PN,
  });
}

function identityFromLidAddressedKeyInAnyOrder() {
  // Chave ainda endereçada por LID (ex.: outro canal): a ordem não importa.
  assert.deepEqual(contactIdentityFromKey({ remoteJid: LID, remoteJidAlt: PN }), {
    pnJid: PN,
    lidJid: LID,
    primaryJid: PN,
  });
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
  assert.deepEqual(participantIdentityFromKey(key), { pnJid: PN, lidJid: LID, primaryJid: PN });
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

function legacyLidContactIsRelinkedInPlace() {
  // O caso real do QA: contato #2 criado com o LID, sem contato do número.
  const plan = planContactLink(
    { pnJid: PN, lidJid: LID, primaryJid: PN },
    null,
    { id: 2, identifier: LID, phone_number: '+85049596768352' },
  );
  assert.deepEqual(plan, {
    action: 'use',
    contactId: 2,
    update: { identifier: PN, phone_number: '+5544997091885' },
  });
}

function lidTwinIsMergedIntoNumberContact() {
  // O caso #2 (LID) + #3 (gêmeo pelo número): o número é a base, o LID é absorvido.
  const plan = planContactLink(
    { pnJid: PN, lidJid: LID, primaryJid: PN },
    { id: 3, identifier: PN, phone_number: '+554497091885' },
    { id: 2, identifier: LID, phone_number: '+85049596768352' },
  );
  assert.deepEqual(plan, { action: 'merge', baseId: 3, mergeeId: 2, update: undefined });
}

function numberContactIsUsedAndKeepsItsPhone() {
  // Telefone válido sem o 9 não é reescrito: evita churn e conflito com cadastros manuais.
  const plan = planContactLink({ pnJid: PN, lidJid: LID, primaryJid: PN }, { id: 3, identifier: PN, phone_number: '+554497091885' });
  assert.deepEqual(plan, { action: 'use', contactId: 3, update: undefined });
}

function numberContactFoundByPhoneGetsCanonicalIdentifier() {
  const plan = planContactLink({ pnJid: PN, primaryJid: PN }, { id: 7, identifier: null, phone_number: '+5544997091885' });
  assert.deepEqual(plan, { action: 'use', contactId: 7, update: { identifier: PN } });
}

function numberContactWithLidAsPhoneGetsRealPhone() {
  const plan = planContactLink(
    { pnJid: PN, lidJid: LID, primaryJid: PN },
    { id: 3, identifier: PN, phone_number: '+85049596768352' },
  );
  assert.deepEqual(plan, { action: 'use', contactId: 3, update: { phone_number: '+5544997091885' } });
}

function sameContactFoundTwiceIsNotMerged() {
  const contact = { id: 3, identifier: PN, phone_number: '+554497091885' };
  assert.equal(planContactLink({ pnJid: PN, lidJid: LID, primaryJid: PN }, contact, contact).action, 'use');
}

function unresolvedLidUsesLegacyContactUntouched() {
  const plan = planContactLink({ lidJid: LID, primaryJid: LID }, null, { id: 2, identifier: LID });
  assert.deepEqual(plan, { action: 'use', contactId: 2 });
}

function newContactUsesNumberOrLidWithoutFakePhone() {
  assert.deepEqual(planContactLink({ pnJid: PN, lidJid: LID, primaryJid: PN }), {
    action: 'create',
    identifier: PN,
    phoneNumber: '+5544997091885',
  });
  assert.deepEqual(planContactLink({ lidJid: LID, primaryJid: LID }), { action: 'create', identifier: LID });
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
  legacyLidContactIsRelinkedInPlace,
  lidTwinIsMergedIntoNumberContact,
  numberContactIsUsedAndKeepsItsPhone,
  numberContactFoundByPhoneGetsCanonicalIdentifier,
  numberContactWithLidAsPhoneGetsRealPhone,
  sameContactFoundTwiceIsNotMerged,
  unresolvedLidUsesLegacyContactUntouched,
  newContactUsesNumberOrLidWithoutFakePhone,
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
