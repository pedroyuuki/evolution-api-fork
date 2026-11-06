/**
 * Execução em série por chave, em memória. Quem chega depois numa chave espera o anterior
 * terminar, mas nunca mais que `timeoutMs`: uma tarefa travada não pode segurar as próximas
 * (ex.: a mensagem do cliente esperando a sincronização do disparo no Chatwoot).
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  public async runExclusive<T>(key: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);

    let timer: NodeJS.Timeout;
    await Promise.race([previous, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);

    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
