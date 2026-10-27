import { debounceKey } from '@api/integrations/chatbot/utils/debounce-key';
import assert from 'node:assert/strict';

function debounceSeparaInstancias() {
  // Grupo com dois números nossos: a mesma mensagem chega às duas instâncias.
  assert.notEqual(debounceKey('inst-A', '1203@g.us'), debounceKey('inst-B', '1203@g.us'));
  assert.equal(debounceKey('inst-A', '1203@g.us'), debounceKey('inst-A', '1203@g.us'));
}

const tests = [debounceSeparaInstancias];

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
