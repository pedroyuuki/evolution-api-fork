import { convertAudioToMp3 } from '@utils/convertAudioToMp3';
import assert from 'node:assert/strict';

/**
 * WAV PCM mono 8kHz gerado na mão: um formato que NÃO é ogg, que é exatamente o caso
 * que o `.inputFormat('ogg')` fixo quebrava.
 */
function makeWav(durationMs = 200): Buffer {
  const sampleRate = 8000;
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(samples * 2);

  for (let i = 0; i < samples; i++) {
    // Senoide de 440Hz — áudio real, não silêncio, para o encoder ter o que codificar.
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

async function convertsNonOggInput() {
  const result = await convertAudioToMp3(makeWav());

  assert.ok(result.length > 0, 'a conversão de um WAV não pode devolver buffer vazio');

  // MP3 começa com tag ID3 ou com o frame sync 0xFFEx.
  const isId3 = result.subarray(0, 3).toString('latin1') === 'ID3';
  const isFrameSync = result[0] === 0xff && (result[1] & 0xe0) === 0xe0;
  assert.ok(isId3 || isFrameSync, `saída não parece um MP3 (primeiros bytes: ${result.subarray(0, 4).toString('hex')})`);
}

async function acceptsBase64() {
  const result = await convertAudioToMp3(makeWav().toString('base64'));
  assert.ok(result.length > 0);
}

async function rejectsGarbageInsteadOfReturningEmpty() {
  await assert.rejects(
    () => convertAudioToMp3(Buffer.from('isto definitivamente nao e um audio valido')),
    'entrada inválida deve rejeitar, nunca resolver com buffer vazio',
  );
}

async function rejectsEmptyInput() {
  await assert.rejects(() => convertAudioToMp3(Buffer.alloc(0)), /Invalid audio input type/);
}

const tests = [convertsNonOggInput, acceptsBase64, rejectsGarbageInsteadOfReturningEmpty, rejectsEmptyInput];

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
