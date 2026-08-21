import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';

/**
 * Converte um áudio para MP3, formato que a WhatsApp Cloud API aceita no upload.
 *
 * Aceita Buffer ou string base64. Rejeita quando o ffmpeg falha ou quando a conversão
 * não produz bytes — nunca devolve um buffer vazio como se fosse sucesso.
 */
export async function convertAudioToMp3(audioInput: string | Buffer): Promise<Buffer> {
  const input = Buffer.isBuffer(audioInput)
    ? audioInput
    : typeof audioInput === 'string'
      ? Buffer.from(audioInput, 'base64')
      : null;

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

    // Sem inputFormat: o ffmpeg detecta o container (ogg, m4a, mp3, wav...). Fixá-lo em
    // 'ogg' fazia todo áudio de outro formato cair direto no handler de erro.
    ffmpeg(inputStream)
      .outputFormat('mp3')
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .audioFrequency(44100)
      .audioChannels(2)
      .on('error', (error: Error) => fail(error instanceof Error ? error : new Error(String(error))))
      .pipe(outputStream, { end: true });

    outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    outputStream.on('error', fail);
    outputStream.on('end', () => {
      const outputBuffer = Buffer.concat(chunks);

      // Quando o ffmpeg falha, o stream de saída ainda emite 'end' com zero chunks.
      // Sem esta guarda a promise resolvia com buffer vazio antes do handler de erro
      // rodar, e a Cloud API recebia um áudio de 0 byte como se tivesse dado certo.
      if (outputBuffer.length === 0) {
        fail(new Error('Conversão de áudio não produziu bytes'));
        return;
      }

      succeed(outputBuffer);
    });
  });
}
