// Websocket real (servidor e cliente locais): token de uma instância não lê nem envia por outra.
process.env.WEBSOCKET_ENABLED = 'true';
process.env.WEBSOCKET_GLOBAL_EVENTS = 'true';
process.env.WEBSOCKET_ALLOWED_HOSTS = '192.0.2.1'; // localhost NÃO liberado: o teste exercita os tokens
process.env.AUTHENTICATION_API_KEY = 'GLOBAL';

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { io as connect, Socket } from 'socket.io-client';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sentNodes: string[] = [];
const tokens: Record<string, string> = { 'token-de-A': 'A', 'token-de-B': 'B' };

const prisma: any = {
  instance: { findFirst: async ({ where }) => (tokens[where.token] ? { name: tokens[where.token] } : null) },
  websocket: { findUnique: async () => ({ enabled: true, events: ['MESSAGES_UPSERT'] }) },
};
const waMonitor: any = {
  waInstances: Object.fromEntries(
    ['A', 'B'].map((name) => [name, { instanceId: `id-${name}`, baileysSendNode: async () => sentNodes.push(name) }]),
  ),
};

let url = '';
const clients: Socket[] = [];

function client(namespace: string, apikey: string): Socket {
  const socket = connect(`${url}${namespace}`, { query: { apikey }, transports: ['websocket'], reconnection: false });
  clients.push(socket);
  return socket;
}

function connects(socket: Socket): Promise<boolean> {
  return new Promise((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('connect_error', () => resolve(false));
  });
}

function received(socket: Socket, event: string): () => any[] {
  const got: any[] = [];
  socket.on(event, (message) => got.push(message));
  return () => got;
}

(async () => {
  const { WebsocketController } = await import('@api/integrations/event/websocket/websocket.controller');
  const httpServer = createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const controller = new WebsocketController(prisma, waMonitor);
  controller.init(httpServer);

  const emit = (instanceName: string) =>
    controller.emit({
      instanceName,
      origin: 'teste',
      event: 'messages.upsert',
      data: { de: instanceName },
      serverUrl: '',
      dateTime: '',
      sender: '',
      apiKey: `apikey-de-${instanceName}`,
    } as any);

  const tests: [string, () => Promise<void>][] = [
    [
      'tokenDeANaoEntraNoNamespaceDeB',
      async () => {
        await emit('B'); // o namespace /B passa a existir, como em produção depois do 1º evento
        assert.equal(await connects(client('/B', 'token-de-A')), false, 'A não pode ouvir os eventos de B');
        assert.equal(await connects(client('/B', 'token-de-B')), true);
      },
    ],
    [
      'tokenDeAOuveSoA',
      async () => {
        const own = client('/A', 'token-de-A');
        assert.equal(await connects(own), true);
        const got = received(own, 'messages.upsert');
        await emit('B');
        await emit('A');
        await sleep(200);
        assert.deepEqual(
          got().map((m) => m.instance),
          ['A'],
        );
      },
    ],
    [
      'eventosGlobaisSoParaOTokenGlobal',
      async () => {
        const fromA = client('/', 'token-de-A');
        const global = client('/', 'GLOBAL');
        assert.equal(await connects(fromA), true);
        assert.equal(await connects(global), true);
        const gotA = received(fromA, 'messages.upsert');
        const gotGlobal = received(global, 'messages.upsert');
        await emit('B');
        await sleep(200);
        assert.equal(gotA().length, 0, 'token de A não recebe os eventos de todas as instâncias');
        assert.equal(gotGlobal().length, 1);
      },
    ],
    [
      'sendNodeSoPelaPropriaInstancia',
      async () => {
        const fromA = client('/', 'token-de-A');
        assert.equal(await connects(fromA), true);
        fromA.emit('sendNode', { instanceId: 'B', stanza: {} });
        fromA.emit('sendNode', { instanceId: 'A', stanza: {} });
        await sleep(200);
        assert.deepEqual(sentNodes, ['A']);
      },
    ],
    ['tokenInvalidoEhRecusado', async () => assert.equal(await connects(client('/', 'nada')), false)],
  ];

  let failed = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(error);
    }
  }
  clients.forEach((socket) => socket.close());
  controller.socket.close();
  httpServer.close();
  console.log(`\n${tests.length - failed}/${tests.length} passaram`);
  process.exit(failed === 0 ? 0 : 1);
})();
