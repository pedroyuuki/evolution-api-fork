/**
 * Quem está conectado no websocket. Antes o token só era conferido no handshake: qualquer
 * token válido entrava no namespace de qualquer instância (e recebia o apikey dela nos
 * eventos) e o `sendNode` enviava por qualquer número.
 */
export type SocketPrincipal = { global: boolean; instanceName?: string };

type ResolveInput = {
  apiKey?: string;
  remoteAddress?: string;
  /** WEBSOCKET_ALLOWED_HOSTS: `*` ou lista separada por vírgula. */
  allowedHosts: string;
  globalKey: string;
  findInstanceNameByToken: (token: string) => Promise<string | null>;
};

/** Host liberado ou chave global: acesso a tudo. Token de instância: só a ela. */
export async function resolvePrincipal(input: ResolveInput): Promise<SocketPrincipal | null> {
  const hosts = input.allowedHosts.trim();
  const isAllowedHost =
    hosts === '*' ||
    hosts
      .split(',')
      .map((h) => h.trim())
      .includes(input.remoteAddress ?? '');
  if (isAllowedHost) return { global: true };

  if (!input.apiKey) return null;
  if (input.apiKey === input.globalKey) return { global: true };

  const instanceName = await input.findInstanceNameByToken(input.apiKey);
  return instanceName ? { global: false, instanceName } : null;
}

export function canUseInstance(principal: SocketPrincipal | null | undefined, instanceName: string): boolean {
  if (!principal) return false;
  return principal.global || principal.instanceName === instanceName;
}
