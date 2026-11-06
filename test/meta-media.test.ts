import {
  assertPublicHttpUrl,
  detectMime,
  guardedLookup,
  isHttpUrl,
  isPrivateAddress,
  metaMediaError,
} from '@utils/metaMedia';
import assert from 'node:assert/strict';

const MB = 1024 * 1024;

function detectaTipos() {
  assert.equal(detectMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  assert.equal(detectMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectMime(Buffer.from('\0\0\0\x18ftypmp42\0\0\0\0', 'binary')), 'video/mp4');
  assert.equal(detectMime(Buffer.from('\0\0\0\x14ftypisom\0\0\0\0', 'binary')), 'video/mp4');
  assert.equal(detectMime(Buffer.from('\0\0\0\x14ftyp3gp4\0\0\0\0', 'binary')), 'video/3gpp');
  assert.equal(detectMime(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(detectMime(Buffer.from('<html>oi</html>')), null);
  assert.equal(detectMime(Buffer.alloc(0)), null);
}

function limitesDaMeta() {
  assert.equal(metaMediaError('video/mp4', 16 * MB), null, '16 MB exatos (16777216) passam');
  assert.match(metaMediaError('video/mp4', 16 * MB + 1), /16/);
  assert.equal(metaMediaError('image/png', 5 * MB), null);
  assert.match(metaMediaError('image/jpeg', 5 * MB + 1), /5/);
  assert.equal(metaMediaError('application/pdf', 100 * MB), null);
  assert.match(metaMediaError(null, 10), /tipo/i);
  assert.match(metaMediaError('video/mp4', 0), /vazio/i);
}

function redesInternas() {
  for (const ip of ['127.0.0.1', '169.254.169.254', '10.1.2.3', '172.20.0.1', '192.168.0.10', '0.0.0.0', '100.64.1.1', '::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
}

async function urlInternaRecusada() {
  await assert.rejects(assertPublicHttpUrl('http://127.0.0.1/x'));
  await assert.rejects(assertPublicHttpUrl('http://[::1]/x'));
  await assert.rejects(assertPublicHttpUrl('ftp://exemplo.com/a'));
  await assert.rejects(assertPublicHttpUrl('nao-e-url'));
  await assert.rejects(assertPublicHttpUrl('http://localhost:8080/x'), 'localhost resolve para 127.0.0.1');
}

function linkNaoEhIdDaMeta() {
  // Mídia enviada por link: o "id" guardado é a URL, e não dá para pedir à Graph.
  assert.equal(isHttpUrl('https://www.w3.org/Icons/w3c_home.png'), true);
  assert.equal(isHttpUrl('1338946308215377'), false);
  assert.equal(isHttpUrl(undefined), false);
}

function ipv6QueEmbuteIpv4Interno() {
  // O parser de URL normaliza [::ffff:127.0.0.1] para ::ffff:7f00:1 (hexadecimal).
  for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:a00:1::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['::ffff:808:808', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
}

async function urlComIpEmbutidoOuNumericoRecusada() {
  await assert.rejects(assertPublicHttpUrl('http://[::ffff:127.0.0.1]/x'));
  await assert.rejects(assertPublicHttpUrl('http://[::ffff:169.254.169.254]/latest/meta-data'));
  await assert.rejects(assertPublicHttpUrl('http://2130706433/x'), 'decimal de 127.0.0.1');
  await assert.rejects(assertPublicHttpUrl('http://0x7f.0.0.1/x'));
}

async function conexaoConfereOIpResolvido() {
  // DNS rebinding: o host pode resolver público na checagem e interno na conexão. O lookup
  // da conexão confere de novo.
  const err = await new Promise((resolve) => guardedLookup('localhost', {}, (e: any) => resolve(e)));
  assert.ok(err, 'localhost (127.0.0.1) recusado na conexão');
}

function soMp4E3gpDeVerdade() {
  const ftyp = (brand: string) => Buffer.from(`\0\0\0\x18ftyp${brand}\0\0\0\0`, 'binary');
  for (const brand of ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'mmp4', 'dash']) {
    assert.equal(detectMime(ftyp(brand)), 'video/mp4', brand);
  }
  for (const brand of ['3gp4', '3gp5', '3gp6']) assert.equal(detectMime(ftyp(brand)), 'video/3gpp', brand);
  // Foto HEIC do iPhone, AVIF, áudio M4A, QuickTime e 3GPP2 passariam como vídeo e a Meta
  // só recusaria depois, em cada envio do disparo.
  for (const brand of ['heic', 'heix', 'mif1', 'msf1', 'avif', 'M4A ', 'qt  ', '3g2a']) {
    assert.equal(detectMime(ftyp(brand)), null, brand);
  }
}

const tests = [
  soMp4E3gpDeVerdade,
  conexaoConfereOIpResolvido,
  detectaTipos,
  limitesDaMeta,
  redesInternas,
  urlInternaRecusada,
  linkNaoEhIdDaMeta,
  ipv6QueEmbuteIpv4Interno,
  urlComIpEmbutidoOuNumericoRecusada,
];

(async () => {
  let failed = 0;
  for (const test of tests) {
    try {
      await test();
      console.log(`  ok  ${test.name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${test.name}`);
      console.error(error);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passaram`);
  process.exit(failed === 0 ? 0 : 1);
})();
