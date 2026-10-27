/**
 * Payload do webhook da Meta só com o entry de uma instância. Um mesmo POST pode trazer
 * entries de números diferentes (um app atende vários WABAs); o controller achava a
 * instância por entry, mas passava o payload inteiro, e o serviço lê sempre `entry[0]`:
 * a instância do 2º número processava a mensagem do 1º como sua e respondia por ele.
 */
export function payloadForEntry(data: any, entry: any): any {
  return { ...data, entry: [entry] };
}
