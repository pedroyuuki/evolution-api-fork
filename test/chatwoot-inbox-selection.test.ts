import { isOwnInbox, mustBlockSend, pickOwnInbox } from '@api/integrations/chatbot/chatwoot/utils/inbox-selection';
import assert from 'node:assert/strict';

const EVO = 'https://evo.c2m.nexawise.com.br/chatwoot/webhook/';
const PROD_NAME = 'GG - SUPORTE GRATUITO (API)';

function nomeContinuaSendoOCriterioPrincipal() {
  // Compatibilidade: onde o nome já funcionava, a caixa escolhida é a mesma, mesmo que
  // outra caixa aponte para a instância.
  const inboxes = [
    { id: 120, name: 'GG - Andrei', webhook_url: EVO + 'X' },
    { id: 160, name: 'Caixa X', webhook_url: EVO + 'outra' },
  ];
  assert.equal(pickOwnInbox(inboxes, 'X', 'Caixa X').inbox?.id, 160);
}

function nomeRepetidoDesempataPelaUrl() {
  const inboxes = [
    { id: 1, name: 'Suporte', webhook_url: EVO + 'outra' },
    { id: 2, name: 'Suporte', webhook_url: EVO + 'X' },
  ];
  const picked = pickOwnInbox(inboxes, 'X', 'Suporte');
  assert.equal(picked.inbox?.id, 2, 'a resposta não pode sair pelo número da outra instância');
  assert.equal(picked.ambiguous, true);
}

function nomeRepetidoSemUrlFicaComAPrimeiraEAvisa() {
  const inboxes = [
    { id: 1, name: 'Suporte', webhook_url: null },
    { id: 2, name: 'Suporte', webhook_url: '' },
  ];
  assert.deepEqual(pickOwnInbox(inboxes, 'X', 'Suporte'), { inbox: inboxes[0], ambiguous: true });
}

function caixaRenomeadaEhAchadaPelaUrl() {
  // Nome de produção com espaço e parênteses: a URL vem com %20.
  const inboxes = [{ id: 173, name: 'Novo nome', webhook_url: EVO + encodeURIComponent(PROD_NAME) }];
  assert.equal(pickOwnInbox(inboxes, PROD_NAME, 'Nome antigo').inbox?.id, 173);
}

function urlComBarraFinalOuQuery() {
  const inboxes = [{ id: 5, name: 'outro', webhook_url: EVO + 'X/?a=1' }];
  assert.equal(pickOwnInbox(inboxes, 'X', 'sem caixa').inbox?.id, 5);
}

function urlDeInstanciaComNomeParecidoNaoConta() {
  const inboxes = [{ id: 5, name: 'outro', webhook_url: EVO + 'XY' }];
  assert.equal(pickOwnInbox(inboxes, 'X', 'sem caixa').inbox, null);
  assert.equal(pickOwnInbox([{ id: 6, name: 'o', webhook_url: EVO + 'aX' }], 'X', 'n').inbox, null);
}

function urlMalformadaNaoQuebra() {
  const inboxes = [{ id: 7, name: 'Caixa', webhook_url: EVO + '%E0%A4%A' }];
  assert.equal(pickOwnInbox(inboxes, 'X', 'Caixa').inbox?.id, 7);
}

function nenhumaCaixa() {
  assert.deepEqual(pickOwnInbox([], 'X', 'Caixa'), { inbox: null, ambiguous: false });
}

function cacheValeSePeloNomeOuPelaUrl() {
  assert.equal(isOwnInbox({ id: 1, name: 'Caixa X' }, 'X', 'Caixa X'), true);
  assert.equal(isOwnInbox({ id: 1, name: 'Renomeada', webhook_url: EVO + 'X' }, 'X', 'Caixa X'), true);
  assert.equal(isOwnInbox({ id: 162, name: 'Nexa-DEMO-1', webhook_url: EVO + 'Nexa-DEMO-1' }, 'NexaAI-Cloud', 'NexaAI-CLOUD'), false);
}

function semCaixaNaoEnvia() {
  assert.equal(mustBlockSend(null), true);
  assert.equal(mustBlockSend(undefined), true);
  assert.equal(mustBlockSend(162), false);
}

const tests = [
  nomeContinuaSendoOCriterioPrincipal,
  nomeRepetidoDesempataPelaUrl,
  nomeRepetidoSemUrlFicaComAPrimeiraEAvisa,
  caixaRenomeadaEhAchadaPelaUrl,
  urlComBarraFinalOuQuery,
  urlDeInstanciaComNomeParecidoNaoConta,
  urlMalformadaNaoQuebra,
  nenhumaCaixa,
  cacheValeSePeloNomeOuPelaUrl,
  semCaixaNaoEnvia,
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
