import { Request } from 'express';

/**
 * A requisição é exatamente a rota `fullPath` (ex.: `/instance/fetchInstances`).
 *
 * Os guards decidiam por `req.originalUrl.includes(...)`, e `originalUrl` inclui a query:
 * `/message/sendText/A?x=/instance/fetchInstances` passava como rota de chave global.
 * Aqui só conta o caminho que o Express casou, sem query.
 */
export function isRoute(req: Request, fullPath: string): boolean {
  const path = (req.baseUrl ?? '') + (req.route?.path ?? req.path ?? '');
  return path.replace(/\/+$/, '') === fullPath;
}
