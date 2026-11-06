import axios from 'axios';
import dns from 'dns';
import { lookup } from 'dns/promises';
import http from 'http';
import https from 'https';
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

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'M4V ',
  'mmp4',
  'dash',
]);

/** Tipo pela assinatura do arquivo (não pelo nome nem pelo que o cliente informou). */
export function detectMime(buf: Buffer): string | null {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    // O container ISO (ftyp) também é usado por HEIC/AVIF, M4A e QuickTime: só as marcas de
    // MP4 e 3GPP de vídeo passam, senão a Meta aceita o upload e recusa cada envio.
    const brand = buf.subarray(8, 12).toString('latin1');
    if (MP4_BRANDS.has(brand)) return 'video/mp4';
    if (/^3gp\d$/.test(brand) || brand === '3gs7' || brand === '3ge6' || brand === '3ge7') return 'video/3gpp';
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

/** IPv6 em 8 grupos de 16 bits (aceita "::" e IPv4 com pontos no fim), ou null se inválido. */
function ipv6Hextets(value: string): number[] | null {
  let text = value;
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[2]);
    text = `${dotted[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

const v4From = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/**
 * Endereço de rede interna, loopback, link-local, metadados de nuvem etc. No IPv6, inclusive
 * as formas que embutem um IPv4 (mapeado ::ffff:, compatível, NAT64 64:ff9b::/96, 6to4
 * 2002::/16): o parser de URL normaliza [::ffff:127.0.0.1] para ::ffff:7f00:1.
 */
export function isPrivateAddress(ip: string): boolean {
  const value = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(value) === 4) return PRIVATE_V4.some(([base, bits]) => inRange(value, base, bits));
  if (isIP(value) !== 6) return true; // não é IP válido: trata como inseguro

  const h = ipv6Hextets(value);
  if (!h) return true;
  const zeros = (from: number, to: number) => h.slice(from, to).every((g) => g === 0);
  if (zeros(0, 8) || (zeros(0, 7) && h[7] === 1)) return true; // :: e ::1
  if (zeros(0, 5) && h[5] === 0xffff) return isPrivateAddress(v4From(h[6], h[7])); // mapeado
  if (zeros(0, 6)) return isPrivateAddress(v4From(h[6], h[7])); // compatível (obsoleto)
  if (h[0] === 0x64 && h[1] === 0xff9b && zeros(2, 6)) return isPrivateAddress(v4From(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isPrivateAddress(v4From(h[1], h[2])); // 6to4
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || h[0] >> 8 === 0xff;
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

/**
 * Lookup usado na conexão: confere de novo o IP resolvido. Sem isso, um host que resolve
 * público na checagem e interno na conexão (DNS rebinding) passaria.
 */
export function guardedLookup(hostname: string, options: any, callback: (...args: any[]) => void) {
  dns.lookup(hostname, { ...(options ?? {}), all: true }, (error, addresses: dns.LookupAddress[]) => {
    if (error) return callback(error);
    if (!addresses?.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error(`${hostname} resolve para rede interna`), { code: 'EPRIVATE' }));
    }
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

const guardedHttpAgent = new http.Agent({ lookup: guardedLookup as any });
const guardedHttpsAgent = new https.Agent({ lookup: guardedLookup as any });

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
      httpAgent: guardedHttpAgent,
      httpsAgent: guardedHttpsAgent,
      proxy: false,
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
