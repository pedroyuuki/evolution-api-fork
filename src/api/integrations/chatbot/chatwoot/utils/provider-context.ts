import { AsyncLocalStorage } from 'node:async_hooks';

/** Estado de uma chamada ao serviço do Chatwoot: a configuração da instância em uso. */
export type ProviderScope = { provider?: any };

/**
 * Faz cada chamada aos métodos do objeto rodar no próprio escopo assíncrono.
 *
 * O ChatwootService é um objeto só para todas as instâncias e guardava a configuração da
 * instância atual (`provider`) num campo compartilhado. Com várias instâncias processando
 * ao mesmo tempo, um `await` no meio deixava outra instância trocar esse campo: a busca da
 * caixa de uma instância Cloud comparou com o nome da caixa de uma Baileys e gravou a caixa
 * errada no cache por 7 dias (reproduzido na VPS de teste).
 *
 * Com isto, uma chamada que entra no serviço sem escopo ganha um escopo novo; as chamadas
 * internas que ela fizer reutilizam o mesmo. O `provider` gravado dentro do escopo só é
 * visto por ele.
 */
export function isolateCallsPerScope(target: object, storage: AsyncLocalStorage<ProviderScope>): void {
  const proto = Object.getPrototypeOf(target);
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || typeof descriptor.value !== 'function') continue; // getters/setters ficam como estão

    const original = descriptor.value as (...args: any[]) => any;
    Object.defineProperty(target, name, {
      configurable: true,
      writable: true,
      value: (...args: any[]) =>
        storage.getStore() ? original.apply(target, args) : storage.run({}, () => original.apply(target, args)),
    });
  }
}
