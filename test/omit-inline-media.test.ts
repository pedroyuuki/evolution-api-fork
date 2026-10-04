import { omitInlineMedia } from '@utils/omitInlineMedia';
import assert from 'node:assert/strict';

const BASE64 = 'SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjYwLjE2LjEwMAAAAAAAAAAAAAAA//uQxAAAAAAAAAAAAAAAAAAAAAAA';

function dropsBase64ButKeepsTheReference() {
  const message = {
    audioMessage: { id: '1035412186175623', type: 'id', mimetype: 'audio/ogg', fileName: 'x.ogg', media: BASE64, ptt: true },
  };
  assert.deepEqual(omitInlineMedia(message), {
    audioMessage: { id: '1035412186175623', type: 'id', mimetype: 'audio/ogg', fileName: 'x.ogg', ptt: true },
  });
}

function keepsUrlMedia() {
  // URL é pequena e é a própria referência do arquivo.
  const message = { imageMessage: { media: 'https://cdn.exemplo.com/a.png', caption: 'oi' } };
  assert.deepEqual(omitInlineMedia(message), message);
}

function doesNotMutateTheOriginal() {
  // O original segue para o webhook e para a resposta da API como sempre.
  const message = { documentMessage: { media: BASE64, fileName: 'a.pdf' }, contextInfo: { stanzaId: 'X' } };
  const result = omitInlineMedia(message);
  assert.equal(message.documentMessage.media, BASE64);
  assert.equal('media' in result.documentMessage, false);
  assert.deepEqual(result.contextInfo, { stanzaId: 'X' });
}

function leavesOtherMessagesAlone() {
  assert.deepEqual(omitInlineMedia({ conversation: 'texto' }), { conversation: 'texto' });
  assert.equal(omitInlineMedia(null), null);
}

const tests = [dropsBase64ButKeepsTheReference, keepsUrlMedia, doesNotMutateTheOriginal, leavesOtherMessagesAlone];

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
