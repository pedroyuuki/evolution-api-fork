import axios from 'axios';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Readable } from 'stream';

/**
 * Mídia para a Cloud API: tipo pelo conteúdo, limites da Meta e download seguro de URL.
 * Tipo errado ou arquivo grande demais a Meta só recusa depois (erro 131053 no status);
 * aqui a recusa é imediata e com o motivo.
 */

const MB = 1024 * 1024;

/** Limites da Meta por tipo (bytes). 16 MB = 16777216, como na mensagem de erro da Meta. */
export const META_MEDIA_LIMITS: Record<string, number> = {
  'image/jpeg': 5 * MB,
  'image/png': 5 * MB,
  'video/mp4': 16 * MB,
  'video/3gpp': 16 * MB,
  'application/pdf': 100 * MB,
};

/** Tipo pela assinatura do arquivo (não pelo nome nem pelo que o cliente informou). */
export function detectMime(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    return buf.subarray(8, 10).toString('latin1') === '3g' ? 'video/3gpp' : 'video/mp4';
  }
  return null;
}

/** Motivo da recusa, ou null se a Meta aceita. */
export function metaMediaError(mime: string | null, size: number): string | null {
  if (!size || size <= 0) return 'Arquivo vazio';
  const limit = mime ? META_MEDIA_LIMITS[mime] : undefined;
  if (!limit) {
    return `Tipo de arquivo não aceito (${mime ?? 'desconhecido'}). Aceitos: ${Object.keys(META_MEDIA_LIMITS).join(', ')}`;
  }
  if (size > limit) {
    return `Arquivo de ${(size / MB).toFixed(1)} MB passa do limite de ${limit / MB} MB da Meta para ${mime}`;
  }
  return null;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** Endereço de rede interna, loopback, link-local, metadados de nuvem etc. */
export function isPrivateAddress(ip: string): boolean {
  const value = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (isIP(value) === 4) return PRIVATE_V4.some(([base, bits]) => inRange(value, base, bits));
  if (isIP(value) === 6) {
    if (value === '::' || value === '::1') return true;
    return /^f[cd]/.test(value) || /^fe[89ab]/.test(value);
  }
  return true; // não é IP válido: trata como inseguro
}

/** Só http/https e só hosts que resolvem para endereços públicos. */
export async function assertPublicHttpUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URL inválida: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Só URLs http/https são aceitas: ${url}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`URL aponta para rede interna: ${url}`);
  }
  return parsed;
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

/**
 * Baixa a URL sem nunca passar de `maxBytes` na memória (o download é interrompido) e
 * seguindo no máximo 3 redirecionamentos, cada um conferido como público.
 */
export async function downloadLimited(
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ buffer: Buffer; contentType?: string }> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    await assertPublicHttpUrl(current);
    const response = await axios.get<Readable>(current, {
      responseType: 'stream',
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    if (response.status >= 300) {
      response.data.destroy();
      const location = response.headers.location;
      if (!location) throw new Error(`Redirecionamento sem destino: ${current}`);
      current = new URL(location, current).toString();
      continue;
    }

    const declared = Number(response.headers['content-length']);
    if (declared > maxBytes) {
      response.data.destroy();
      throw new Error(`Arquivo de ${(declared / MB).toFixed(1)} MB passa do máximo de ${maxBytes / MB} MB`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.data) {
      size += chunk.length;
      if (size > maxBytes) {
        response.data.destroy();
        throw new Error(`Arquivo passa do máximo de ${maxBytes / MB} MB`);
      }
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType: response.headers['content-type'] };
  }
  throw new Error(`Redirecionamentos demais: ${url}`);
}
