import { isAcceptedByCloudApi, sniffAudioFormat } from './audioFormat';
import { convertAudio } from './convertAudio';

export type PreparedAudio = {
  buffer: Buffer;
  mimetype: string;
  extension: string;
  /** Falso quando o arquivo original foi aproveitado sem transcodificar. */
  converted: boolean;
  detectedCodec: string;
  /** Verdadeiro quando o arquivo atende à nota de voz da Meta (OGG Opus): envia com `voice: true`. */
  voice: boolean;
};

/**
 * Acima disto a Meta troca o botão de play da nota de voz por um de download.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages
 */
export const VOICE_NOTE_MAX_BYTES = 512 * 1024;

/** Taxa que a Meta recomenda para nota de voz; usada quando 32k passa do limite. */
const VOICE_FALLBACK_BITRATE = '16k';

const OPUS = { mimetype: 'audio/ogg', extension: 'ogg' };

/**
 * Deixa um áudio pronto para o upload na WhatsApp Cloud API.
 *
 * Nota de voz (padrão): a Meta só exibe como nota de voz — ícone de microfone, play e
 * transcrição — um OGG Opus mono enviado com `voice: true`. Qualquer outro formato,
 * mesmo aceito pela API (MP3, M4A, AAC), chega como arquivo de áudio comum. Por isso
 * só Opus mono dentro do limite passa direto (sem perda); o resto é convertido.
 *
 * `voice: false`: envio de arquivo de áudio comum, convertendo só o que a API recusa.
 */
export async function prepareAudioForCloudApi(
  input: Buffer,
  { voice = true }: { voice?: boolean } = {},
): Promise<PreparedAudio> {
  const format = sniffAudioFormat(input);

  const isOpusMono = format.codec === 'opus' && format.channels === 1;
  const keepAsIs = voice ? isOpusMono && input.length <= VOICE_NOTE_MAX_BYTES : isAcceptedByCloudApi(format);

  if (keepAsIs) {
    return {
      buffer: input,
      mimetype: format.mimetype,
      extension: format.extension,
      converted: false,
      detectedCodec: format.codec,
      voice: isOpusMono,
    };
  }

  try {
    let buffer = await convertAudio(input, 'opus');
    if (voice && buffer.length > VOICE_NOTE_MAX_BYTES) {
      buffer = await convertAudio(input, 'opus', VOICE_FALLBACK_BITRATE);
    }
    return { buffer, ...OPUS, converted: true, detectedCodec: format.codec, voice: true };
  } catch (opusError) {
    // Último recurso: MP3 também é aceito pela Cloud API e depende de outro encoder,
    // então serve de rede de segurança se o libopus falhar neste ambiente. Sai como
    // áudio comum: nota de voz exige Opus.
    try {
      return {
        buffer: await convertAudio(input, 'mp3'),
        mimetype: 'audio/mpeg',
        extension: 'mp3',
        converted: true,
        detectedCodec: format.codec,
        voice: false,
      };
    } catch {
      throw opusError;
    }
  }
}
