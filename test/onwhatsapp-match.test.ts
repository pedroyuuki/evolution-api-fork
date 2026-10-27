import { jidOptionsInclude } from '@utils/jidIdentity';
import assert from 'node:assert/strict';

// IsOnWhatsapp é global: juntar o número X à linha de Y faz o envio para X ir para Y.

function sufixoNaoCasa() {
  // Número alemão que termina com o número brasileiro: o `contains` casava.
  assert.equal(jidOptionsInclude('491234555511999999999@s.whatsapp.net', ['5511999999999@s.whatsapp.net']), false);
  assert.equal(jidOptionsInclude('1234567890123456@lid', ['234567890123456@lid']), false);
}

function opcaoExataCasa() {
  assert.equal(jidOptionsInclude('5511999999999@s.whatsapp.net,123@lid', ['123@lid']), true);
  assert.equal(jidOptionsInclude('5511999999999@s.whatsapp.net', ['551199999999@s.whatsapp.net', '5511999999999@s.whatsapp.net']), true);
}

function vazio() {
  assert.equal(jidOptionsInclude('', ['123@lid']), false);
  assert.equal(jidOptionsInclude(null, ['123@lid']), false);
}

const tests = [sufixoNaoCasa, opcaoExataCasa, vazio];

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
