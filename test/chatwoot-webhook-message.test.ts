import { eventMessages, isEvolutionEcho, isFromAnotherInbox } from '@api/integrations/chatbot/chatwoot/utils/webhook-message';
import assert from 'node:assert/strict';

// Payload real do incidente de 26/10: a cópia do template da Cloud (raiz, source_id WAID)
// chegou com outra mensagem em conversation.messages[0].
const echoWithOtherLastMessage = {
  event: 'message_created',
  id: 9001,
  content: '▶️atendimento◀️',
  message_type: 'outgoing',
  source_id: 'WAID:wamid.HBgMNTU1MTk1MTc0MDQ5FQIAERgSREYxMjQ0RUMyNjRCMjY1RDZEAA==',
  conversation: { id: 173538, messages: [{ id: 9002, content: 'mensagem automática', source_id: null }] },
};

function echoIsDetectedByTheMessageItself() {
  assert.equal(isEvolutionEcho(echoWithOtherLastMessage), true, 'a cópia não pode ser reenviada');
}

function legacyDetectionStillWorks() {
  assert.equal(isEvolutionEcho({ source_id: null, conversation: { messages: [{ source_id: 'WAID:abc' }] } }), true);
}

function agentMessagesAreNotEchoes() {
  assert.equal(isEvolutionEcho({ id: 1, source_id: null, conversation: { messages: [{ source_id: null }] } }), false);
  assert.equal(isEvolutionEcho({ id: 1, source_id: 'outro-sistema', conversation: { messages: [] } }), false);
  assert.equal(isEvolutionEcho(undefined), false);
}

function sendsTheEventMessageNotTheConversationsLast() {
  const body = {
    id: 10,
    content: 'nova',
    attachments: [{ data_url: 'https://cw/a.png' }],
    conversation: { messages: [{ id: 9, content: 'antiga', attachments: [{ data_url: 'https://cw/velha.pdf' }] }] },
  };
  const [message] = eventMessages(body);
  assert.equal(message.id, 10);
  assert.deepEqual(message.attachments, [{ data_url: 'https://cw/a.png' }], 'nunca reenviar o anexo antigo');
}

function messageWithoutAttachmentsHasEmptyList() {
  const [message] = eventMessages({ id: 10, content: 'só texto', conversation: { messages: [{ id: 9, attachments: [{}] }] } });
  assert.deepEqual(message.attachments, []);
}

function eventsOfAnotherInboxAreRejected() {
  // A cópia da Cloud (caixa 160) chegando no endereço da instância da caixa 162.
  assert.equal(isFromAnotherInbox({ inbox: { id: 160 }, conversation: { inbox_id: 160 } }, 162), true);
  assert.equal(isFromAnotherInbox({ inbox: { id: 162 } }, 162), false);
  assert.equal(isFromAnotherInbox({ conversation: { inbox_id: '162' } }, 162), false, 'id em texto ou número');
  assert.equal(isFromAnotherInbox({ conversation: { inbox_id: 160 } }, 162), true, 'sem inbox na raiz usa a da conversa');
}

function unknownInboxNeverBlocks() {
  // Sem saber a caixa da instância (nome não confere) ou do evento, não bloqueia.
  assert.equal(isFromAnotherInbox({ inbox: { id: 160 } }, undefined), false);
  assert.equal(isFromAnotherInbox({}, 162), false);
}

const tests = [
  eventsOfAnotherInboxAreRejected,
  unknownInboxNeverBlocks,
  echoIsDetectedByTheMessageItself,
  legacyDetectionStillWorks,
  agentMessagesAreNotEchoes,
  sendsTheEventMessageNotTheConversationsLast,
  messageWithoutAttachmentsHasEmptyList,
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
