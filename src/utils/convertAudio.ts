import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';

export type AudioTarget = 'opus' | 'mp3';

const toBuffer = (audioInput: string | Buffer): Buffer | null => {
  if (Buffer.isBuffer(audioInput)) return audioInput;
  if (typeof audioInput === 'string') return Buffer.from(audioInput, 'base64');
  return null;
};

/**
 * Converte audio para um formato aceito pela WhatsApp Cloud API.
 *
 * O alvo padrao e OGG Opus mono, o mesmo formato em que o WhatsApp grava nota de voz:
 * preserva a qualidade da fala com arquivo menor que o original e evita a perda
 * geracional de recomprimir Opus em MP3.
 *
 * Os parametros sao calibrados para voz. Reamostrar para 44.1kHz e duplicar mono em
 * estereo, como a implementacao anterior fazia, triplicava o tamanho sem acrescentar
 * informacao nenhuma - a banda util de uma nota de voz nao passa de ~8kHz.
 *
 * Rejeita quando o ffmpeg falha ou quando a saida vem vazia: nunca devolve um buffer
 * vazio como se fosse sucesso.
 */
export async function convertAudio(audioInput: string | Buffer, target: AudioTarget = 'opus'): Promise<Buffer> {
  const input = toBuffer(audioInput);

  if (!input?.length) {
    throw new Error('Invalid audio input type');
  }

  return new Promise<Buffer>((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(input);

    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (buffer: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };

    ffmpeg.setFfmpegPath(ffmpegPath.path);

    // Sem inputFormat: o ffmpeg detecta o container. Fixa-lo em 'ogg', como antes,
    // fazia todo audio de outro formato cair direto no handler de erro.
    const command = ffmpeg(inputStream).noVideo().audioChannels(1);

    if (target === 'opus') {
      command.audioCodec('libopus').audioBitrate('32k').outputFormat('ogg');
    } else {
      command.audioCodec('libmp3lame').audioBitrate('64k').audioFrequency(16000).outputFormat('mp3');
    }

    command
      .on('error', (error: Error) => fail(error instanceof Error ? error : new Error(String(error))))
      .pipe(outputStream, { end: true });

    outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    outputStream.on('error', fail);
    outputStream.on('end', () => {
      const outputBuffer = Buffer.concat(chunks);

      // Quando o ffmpeg falha, o stream de saida ainda emite 'end' com zero chunks.
      // Sem esta guarda a promise resolvia antes do handler de erro rodar, e a Cloud
      // API recebia um audio de 0 byte como se tivesse dado certo.
      if (outputBuffer.length === 0) {
        fail(new Error('Conversão de áudio não produziu bytes'));
        return;
      }

      succeed(outputBuffer);
    });
  });
}

export const convertAudioToOpus = (audioInput: string | Buffer) => convertAudio(audioInput, 'opus');

export const convertAudioToMp3 = (audioInput: string | Buffer) => convertAudio(audioInput, 'mp3');
