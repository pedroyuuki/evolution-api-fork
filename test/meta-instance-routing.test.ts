import { pickPrimaryInstance, shouldWarnDuplicate } from '@api/integrations/channel/meta/instance-routing';
import assert from 'node:assert/strict';

function maisAntigaVence() {
  const picked = pickPrimaryInstance([
    { id: 'b', name: 'Disparo em Massa', createdAt: new Date('2026-10-01') },
    { id: 'a', name: 'Original', createdAt: new Date('2026-01-01') },
  ]);
  assert.equal(picked.id, 'a', 'as respostas dos clientes vão para a original');
}

function createdAtNuloEhMaisAntigo() {
  // Linhas antigas, de antes da coluna ter default, ficam com createdAt nulo.
  const picked = pickPrimaryInstance([
    { id: 'b', name: 'Nova', createdAt: new Date('2026-01-01') },
    { id: 'z', name: 'Legada', createdAt: null },
  ]);
  assert.equal(picked.id, 'z');
}

function empateNoCreatedAtPeloId() {
  const when = new Date('2026-01-01');
  assert.equal(pickPrimaryInstance([{ id: 'c', name: 'C', createdAt: when }, { id: 'b', name: 'B', createdAt: when }]).id, 'b');
}

function listaVaziaNull() {
  assert.equal(pickPrimaryInstance([]), null);
}

function avisoNoMaximoACada10Min() {
  const last = new Map<string, number>();
  const t0 = 1_800_000_000_000;
  assert.equal(shouldWarnDuplicate('527322467134997', t0, last), true);
  assert.equal(shouldWarnDuplicate('527322467134997', t0 + 5 * 60_000, last), false);
  assert.equal(shouldWarnDuplicate('892305380642363', t0 + 5 * 60_000, last), true, 'outro número avisa à parte');
  assert.equal(shouldWarnDuplicate('527322467134997', t0 + 11 * 60_000, last), true);
}

const tests = [maisAntigaVence, createdAtNuloEhMaisAntigo, empateNoCreatedAtPeloId, listaVaziaNull, avisoNoMaximoACada10Min];

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
