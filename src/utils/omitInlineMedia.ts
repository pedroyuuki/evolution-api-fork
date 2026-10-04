const isHttpUrl = (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value);

/**
 * Cópia da mensagem sem o conteúdo da mídia embutido (`media` em base64).
 *
 * No envio pelo Cloud API a mensagem registrada carregava o arquivo inteiro em base64:
 * cada mídia enviada virava uma linha do tamanho do arquivo (+33%). O que identifica a
 * mídia continua — o id da Meta, a URL, mimetype, nome e legenda —, então dá para
 * baixá-la de novo pelo getBase64FromMediaMessage enquanto a Meta mantiver o id.
 */
export function omitInlineMedia<T extends Record<string, any>>(message: T): T {
  if (!message || typeof message !== 'object') return message;

  const copy: Record<string, any> = { ...message };
  for (const [type, content] of Object.entries(copy)) {
    if (type.endsWith('Message') && content && typeof content === 'object' && 'media' in content) {
      if (!isHttpUrl(content.media)) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { media, ...rest } = content;
        copy[type] = rest;
      }
    }
  }
  return copy as T;
}
