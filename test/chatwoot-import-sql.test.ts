import { existingSourceIdsQuery, sourceIdUpdateQuery } from '@api/integrations/chatbot/chatwoot/utils/chatwoot-sql';
import assert from 'node:assert/strict';

// O banco de importação é um só para todas as instâncias: toda escrita e leitura por id de
// mensagem leva a conta e a caixa da instância.

function atualizacaoFiltraContaECaixa() {
  const q = sourceIdUpdateQuery(9001, 'ABC', { accountId: 11, inboxId: 160 });
  assert.match(q.sql, /WHERE id = \$2 AND account_id = \$3 AND inbox_id = \$4/);
  assert.deepEqual(q.params, ['WAID:ABC', 9001, 11, 160]);
}

function semContaOuCaixaNaoAtualiza() {
  assert.equal(sourceIdUpdateQuery(9001, 'ABC', { accountId: 11, inboxId: undefined }), null);
  assert.equal(sourceIdUpdateQuery(9001, 'ABC', { accountId: undefined, inboxId: 160 }), null);
}

function buscaDeExistentesPelaCaixa() {
  const q = existingSourceIdsQuery(['WAID:a'], { inboxId: 160 });
  assert.match(q.sql, /source_id = ANY\(\$1\) AND inbox_id = \$2$/);
  assert.deepEqual(q.params, [['WAID:a'], 160]);
}

function buscaPelaConversaContinuaIgual() {
  const q = existingSourceIdsQuery(['WAID:a'], { conversationId: 5 });
  assert.equal(q.sql, 'SELECT source_id FROM messages WHERE source_id = ANY($1) AND conversation_id = $2');
  assert.deepEqual(q.params, [['WAID:a'], 5]);
}

const tests = [atualizacaoFiltraContaECaixa, semContaOuCaixaNaoAtualiza, buscaDeExistentesPelaCaixa, buscaPelaConversaContinuaIgual];

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
