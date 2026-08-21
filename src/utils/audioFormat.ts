export type AudioCodec = 'opus' | 'vorbis' | 'mp3' | 'aac' | 'mp4' | 'amr' | 'unknown';

export type SniffedAudio = {
  codec: AudioCodec;
  /** Só é conhecido para Opus, cujo cabeçalho declara a contagem explicitamente. */
  channels?: number;
  /** Preenchidos apenas quando a Cloud API aceita o arquivo como está. */
  mimetype?: string;
  extension?: string;
};

/**
 * Tipos que a WhatsApp Cloud API aceita no upload de audio, conforme a tabela oficial
 * de midia suportada. OGG e o unico com ressalva: somente codec OPUS e somente mono.
 */
const ACCEPTED: Record<string, { mimetype: string; extension: string }> = {
  opus: { mimetype: 'audio/ogg', extension: 'ogg' },
  mp3: { mimetype: 'audio/mpeg', extension: 'mp3' },
  aac: { mimetype: 'audio/aac', extension: 'aac' },
  mp4: { mimetype: 'audio/mp4', extension: 'm4a' },
  amr: { mimetype: 'audio/amr', extension: 'amr' },
};

const startsWith = (buffer: Buffer, marker: string, offset = 0) =>
  buffer.length >= offset + marker.length &&
  buffer.subarray(offset, offset + marker.length).toString('latin1') === marker;

/**
 * Identifica o formato do audio pelo conteudo, e nao pela extensao do arquivo.
 *
 * A extensao mente: o Chatwoot serve nota de voz como .oga, e uma URL sem extensao
 * derruba a deteccao por completo. Como a regra da Meta depende do codec real e da
 * contagem de canais, so o conteudo responde com seguranca.
 */
export function sniffAudioFormat(buffer: Buffer): SniffedAudio {
  if (!buffer?.length) {
    return { codec: 'unknown' };
  }

  if (startsWith(buffer, 'OggS')) {
    // O cabecalho de identificacao vem na primeira pagina do fluxo Ogg.
    const head = buffer.subarray(0, Math.min(buffer.length, 512));

    const opusAt = head.indexOf('OpusHead', 0, 'latin1');
    if (opusAt !== -1) {
      // Layout do OpusHead: 8 bytes de marca, 1 de versao, 1 de canais.
      const channels = head.length > opusAt + 9 ? head[opusAt + 9] : undefined;
      return { codec: 'opus', channels, ...(channels === 1 ? ACCEPTED.opus : {}) };
    }

    if (head.indexOf('\x01vorbis', 0, 'latin1') !== -1) {
      return { codec: 'vorbis' };
    }

    return { codec: 'unknown' };
  }

  if (startsWith(buffer, 'ID3')) {
    return { codec: 'mp3', ...ACCEPTED.mp3 };
  }

  if (startsWith(buffer, '#!AMR')) {
    return { codec: 'amr', ...ACCEPTED.amr };
  }

  if (startsWith(buffer, 'ftyp', 4)) {
    return { codec: 'mp4', ...ACCEPTED.mp4 };
  }

  // Quadro MPEG-audio sem tag ID3. O campo "layer" separa MP3 de AAC-ADTS: no ADTS
  // ele e sempre 00, enquanto o MP3 (Layer III) traz 01.
  if (buffer.length > 1 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const isAdts = (buffer[1] & 0x06) === 0;
    return isAdts ? { codec: 'aac', ...ACCEPTED.aac } : { codec: 'mp3', ...ACCEPTED.mp3 };
  }

  return { codec: 'unknown' };
}

/** Verdadeiro quando o arquivo pode ir para a Cloud API sem passar por conversao. */
export function isAcceptedByCloudApi(format: SniffedAudio): boolean {
  return Boolean(format.mimetype);
}
