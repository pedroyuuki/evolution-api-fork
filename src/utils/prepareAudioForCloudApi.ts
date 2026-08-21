import { isAcceptedByCloudApi, sniffAudioFormat } from './audioFormat';
import { convertAudio } from './convertAudio';

export type PreparedAudio = {
  buffer: Buffer;
  mimetype: string;
  extension: string;
  /** Falso quando o arquivo original foi aproveitado sem transcodificar. */
  converted: boolean;
  detectedCodec: string;
};

/**
 * Deixa um audio pronto para o upload na WhatsApp Cloud API, convertendo apenas quando
 * o formato original nao e aceito.
 *
 * Nota de voz sai do Chatwoot e do WhatsApp em OGG Opus mono, que a Cloud API aceita
 * como esta. Transcodificar nesse caso so degrada a qualidade e aumenta o arquivo, entao
 * o caminho normal aqui e o passe direto.
 */
export async function prepareAudioForCloudApi(input: Buffer): Promise<PreparedAudio> {
  const format = sniffAudioFormat(input);

  if (isAcceptedByCloudApi(format)) {
    return {
      buffer: input,
      mimetype: format.mimetype,
      extension: format.extension,
      converted: false,
      detectedCodec: format.codec,
    };
  }

  try {
    return {
      buffer: await convertAudio(input, 'opus'),
      mimetype: 'audio/ogg',
      extension: 'ogg',
      converted: true,
      detectedCodec: format.codec,
    };
  } catch (opusError) {
    // Ultimo recurso: MP3 tambem e aceito pela Cloud API e depende de outro encoder,
    // entao serve de rede de seguranca se o libopus falhar neste ambiente.
    try {
      return {
        buffer: await convertAudio(input, 'mp3'),
        mimetype: 'audio/mpeg',
        extension: 'mp3',
        converted: true,
        detectedCodec: format.codec,
      };
    } catch {
      throw opusError;
    }
  }
}
