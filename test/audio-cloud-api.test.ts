import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import { isAcceptedByCloudApi, sniffAudioFormat } from '@utils/audioFormat';
import { convertAudio } from '@utils/convertAudio';
import { prepareAudioForCloudApi, VOICE_NOTE_MAX_BYTES } from '@utils/prepareAudioForCloudApi';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const workdir = mkdtempSync(join(tmpdir(), 'evo-audio-'));

/** Gera uma amostra real com o ffmpeg embarcado, para não depender de fixtures binários. */
async function sample(name: string, ...args: string[]): Promise<Buffer> {
  const out = join(workdir, name);
  await run(ffmpegPath.path, [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=300:duration=${process.env.SAMPLE_SECONDS ?? 2}`,
    ...args,
    out,
  ]);
  return readFileSync(out);
}

async function sniffsRealFormats() {
  const opusMono = await sample('mono.ogg', '-ac', '1', '-ar', '16000', '-c:a', 'libopus');
  const opusStereo = await sample('stereo.ogg', '-ac', '2', '-ar', '48000', '-c:a', 'libopus');
  const vorbis = await sample('vorbis.ogg', '-ac', '1', '-c:a', 'libvorbis');
  const mp3 = await sample('a.mp3', '-ac', '1', '-c:a', 'libmp3lame');
  const m4a = await sample('a.m4a', '-ac', '1', '-c:a', 'aac');

  assert.deepEqual(
    { ...sniffAudioFormat(opusMono) },
    { codec: 'opus', channels: 1, mimetype: 'audio/ogg', extension: 'ogg' },
    'opus mono deve ser reconhecido e aceito',
  );

  const stereo = sniffAudioFormat(opusStereo);
  assert.equal(stereo.codec, 'opus');
  assert.equal(stereo.channels, 2);
  assert.equal(isAcceptedByCloudApi(stereo), false, 'a Cloud API so aceita ogg mono');

  assert.equal(sniffAudioFormat(vorbis).codec, 'vorbis');
  assert.equal(isAcceptedByCloudApi(sniffAudioFormat(vorbis)), false, 'ogg vorbis nao e aceito');

  assert.equal(sniffAudioFormat(mp3).codec, 'mp3');
  assert.equal(isAcceptedByCloudApi(sniffAudioFormat(mp3)), true);

  assert.equal(sniffAudioFormat(m4a).codec, 'mp4');
  assert.equal(isAcceptedByCloudApi(sniffAudioFormat(m4a)), true);

  assert.equal(sniffAudioFormat(Buffer.from('nao e audio')).codec, 'unknown');
  assert.equal(sniffAudioFormat(Buffer.alloc(0)).codec, 'unknown');
}

async function passesThroughWhenAlreadyAccepted() {
  const opusMono = await sample('pass.ogg', '-ac', '1', '-ar', '16000', '-c:a', 'libopus');
  const result = await prepareAudioForCloudApi(opusMono);

  assert.equal(result.converted, false, 'opus mono nao pode ser transcodificado');
  assert.equal(result.mimetype, 'audio/ogg');
  assert.ok(result.buffer.equals(opusMono), 'o buffer deve ser o original, byte a byte');
}

async function convertsOnlyWhatIsNotAccepted() {
  const stereo = await sample('conv.ogg', '-ac', '2', '-ar', '48000', '-c:a', 'libopus');
  const result = await prepareAudioForCloudApi(stereo);

  assert.equal(result.converted, true, 'opus estereo precisa virar mono');
  assert.equal(result.mimetype, 'audio/ogg');

  const converted = sniffAudioFormat(result.buffer);
  assert.equal(converted.codec, 'opus');
  assert.equal(converted.channels, 1, 'a saida tem de ser mono');
  assert.equal(isAcceptedByCloudApi(converted), true);
}

async function convertedOutputIsNotBiggerThanSource() {
  const vorbis = await sample('big.ogg', '-ac', '1', '-c:a', 'libvorbis');
  const result = await prepareAudioForCloudApi(vorbis);

  assert.equal(result.converted, true);
  assert.ok(
    result.buffer.length <= vorbis.length * 1.5,
    `conversao inflou o arquivo: ${vorbis.length} -> ${result.buffer.length} bytes`,
  );
}

async function mp3BecomesVoiceNote() {
  // O Chatwoot v4 grava a nota de voz do atendente em MP3: aceito pela API, mas a Meta só
  // mostra como nota de voz (microfone, onda, transcrição) um OGG Opus com voice: true.
  const mp3 = await sample('voz.mp3', '-ac', '1', '-c:a', 'libmp3lame');
  const result = await prepareAudioForCloudApi(mp3, { voice: true });

  assert.equal(result.converted, true);
  assert.equal(result.voice, true);
  assert.equal(result.mimetype, 'audio/ogg');
  const out = sniffAudioFormat(result.buffer);
  assert.equal(out.codec, 'opus');
  assert.equal(out.channels, 1);
}

async function opusMonoVoiceNoteIsSentAsVoiceWithoutTranscoding() {
  const opusMono = await sample('voz.ogg', '-ac', '1', '-ar', '16000', '-c:a', 'libopus');
  const result = await prepareAudioForCloudApi(opusMono, { voice: true });
  assert.equal(result.converted, false);
  assert.equal(result.voice, true);
}

async function audioFileKeepsAcceptedFormatAndIsNotVoice() {
  // sendMedia com áudio é envio de arquivo: o MP3 vai como está, sem voice.
  const mp3 = await sample('arquivo.mp3', '-ac', '1', '-c:a', 'libmp3lame');
  const result = await prepareAudioForCloudApi(mp3, { voice: false });
  assert.equal(result.converted, false);
  assert.equal(result.voice, false);
  assert.ok(result.buffer.equals(mp3));
}

async function longVoiceNoteFitsTheMetaPlayIconLimit() {
  // Acima de 512 KB a Meta troca o play por download. Opus a 32k estoura em ~2 min;
  // a 16k (taxa recomendada pela Meta) cabe até ~4 min.
  process.env.SAMPLE_SECONDS = '150';
  const big = await sample('longa.ogg', '-ac', '1', '-c:a', 'libopus', '-b:a', '64k');
  delete process.env.SAMPLE_SECONDS;
  assert.ok(big.length > VOICE_NOTE_MAX_BYTES, `amostra precisa passar do limite: ${big.length}`);

  const result = await prepareAudioForCloudApi(big, { voice: true });
  assert.equal(result.voice, true);
  assert.ok(result.buffer.length <= VOICE_NOTE_MAX_BYTES, `nota de voz com ${result.buffer.length} bytes`);
}

async function rejectsGarbageInsteadOfReturningEmpty() {
  await assert.rejects(
    () => convertAudio(Buffer.from('isto definitivamente nao e um audio valido')),
    'entrada invalida deve rejeitar, nunca resolver com buffer vazio',
  );
  await assert.rejects(() => convertAudio(Buffer.alloc(0)), /Invalid audio input type/);
}

const tests = [
  sniffsRealFormats,
  passesThroughWhenAlreadyAccepted,
  convertsOnlyWhatIsNotAccepted,
  convertedOutputIsNotBiggerThanSource,
  rejectsGarbageInsteadOfReturningEmpty,
  mp3BecomesVoiceNote,
  opusMonoVoiceNoteIsSentAsVoiceWithoutTranscoding,
  audioFileKeepsAcceptedFormatAndIsNotVoice,
  longVoiceNoteFitsTheMetaPlayIconLimit,
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

  rmSync(workdir, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passaram`);
  process.exit(failed === 0 ? 0 : 1);
})();
