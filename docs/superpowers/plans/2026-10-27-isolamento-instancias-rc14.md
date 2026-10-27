# Isolamento entre instâncias (rc14) — plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** fechar os caminhos pelos quais uma instância envia, lê ou grava dados de outra, sem mudar nada para configurações legítimas de produção.

**Arquitetura:** cada correção tira a decisão de isolamento para uma função pura e pequena em `utils/` (testável com `npx tsx`, sem subir config/Prisma) e o serviço só a chama. Os serviços grandes (`chatwoot.service.ts`, `whatsapp.baileys.service.ts`) recebem edições pontuais.

**Stack:** TypeScript, Express 4, Prisma, socket.io 4.8, testes `test/*.test.ts` com `node:assert/strict` rodados por `npx tsx` (padrão de `test/chatwoot-webhook-message.test.ts`).

**Spec:** [docs/superpowers/specs/2026-10-27-isolamento-instancias-rc14-design.md](../specs/2026-10-27-isolamento-instancias-rc14-design.md) (IDs da [auditoria](../research/2026-10-27-auditoria-isolamento-instancias.md)).

## Restrições globais

- Nenhuma env nova, nenhuma migration, nenhuma reconfiguração de Chatwoot/Meta/webhooks/instâncias.
- AUT-3 (token no webhook do Chatwoot) e AUT-5 (assinatura da Meta) NÃO entram.
- Comentários e mensagens de log em português, no estilo do código vizinho; commits em português, um por tarefa, com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Todo `where` do Prisma tocado leva `instanceId` definido (nunca `undefined`).
- Ao fim de cada tarefa: `npx tsc --noEmit` e `npx eslint <arquivos de src tocados>` sem erro, e todos os `test/*.test.ts` passando.

## Foco da revisão

1. Payload do Chatwoot sem `inbox` e sem `conversation.inbox_id` (eventos antigos/forjados): não pode enviar quando a caixa da instância é desconhecida; com caixa conhecida e evento sem caixa, segue como hoje (o guard de eco e de caixa continuam). Teste na Tarefa 5.
2. Nome de instância com espaço/acentos/parênteses (produção tem `GG - SUPORTE GRATUITO (API)`, URL com `%20`): a comparação com `webhook_url` decodifica a URL. Teste na Tarefa 5.
3. `fetchInstances` chamado com token de instância e sem `instanceName` continua passando; `/instance/create` com a chave global continua passando. Teste na Tarefa 2.
4. Webhook da Meta com um único entry (o caso normal) gera exatamente o mesmo objeto que hoje é passado ao serviço. Teste na Tarefa 4.
5. Mensagem de saída do Chatwoot repetida (mesmo `body.id`) depois de já enviada: não reenvia; mensagem nova com id diferente: envia. Teste na Tarefa 7.

---

### Tarefa 1: nome da instância só do path (AUT-1, AUT-11)

**Arquivos:**
- Criar: `src/api/abstract/instance-params.ts`
- Modificar: `src/api/abstract/abstract.router.ts:30-45`
- Teste: `test/instance-params.test.ts`

**Interfaces:**
- Produz: `resolveInstanceParams(params: Record<string, any>, query: Record<string, any> | undefined, body: any, isCreateRoute: boolean): InstanceDto` — devolve um objeto NOVO (não muta `params`); query entra primeiro, params por cima; no create, o body entra por cima de tudo (comportamento atual do create).
- Produz: `isRoute(req: Request, fullPath: string): boolean` em `src/api/guards/route-match.ts` (usado na Tarefa 2; definido aqui porque `dataValidate` usa para o create) — compara `req.baseUrl + (req.route?.path ?? req.path)` com `fullPath`, sem query string.

- [ ] **Passo 1: testes que falham** — `queryNaoTrocaAInstancia`: `resolveInstanceParams({instanceName:'A'}, {instanceName:'B', page:'2'}, {}, false)` → `instanceName === 'A'` e `page === '2'`; `naoMutaParams`: o objeto `params` passado continua `{instanceName:'A'}`; `createUsaOBody`: `(…, {}, undefined, {instanceName:'nova'}, true)` → `instanceName === 'nova'`; `isRoute` com objeto fake `{baseUrl:'/instance', route:{path:'/create'}, path:'/create'}` → true para `/instance/create`; com `{baseUrl:'/message', route:{path:'/sendText/:instanceName'}, originalUrl:'/message/sendText/A?x=/instance/create'}` → false.
- [ ] **Passo 2:** `npx tsx test/instance-params.test.ts` → falha (módulo não existe).
- [ ] **Passo 3:** implementar as duas funções e trocar o bloco de `dataValidate` por `const instance = resolveInstanceParams(request.params, request.query, body, isRoute(request, '/instance/create'))`.
- [ ] **Passo 4:** teste passa; tsc/eslint ok.
- [ ] **Passo 5:** commit `fix(auth): nome da instancia vem so do path validado pelos guards`.

### Tarefa 2: guards comparam a rota exata (AUT-2)

**Arquivos:**
- Modificar: `src/api/guards/auth.guard.ts:23,37`, `src/api/guards/instance.guard.ts:26,43`
- Teste: `test/instance-params.test.ts` (acrescentar)

**Interfaces:**
- Consome: `isRoute(req, fullPath)` da Tarefa 1.

- [ ] **Passo 1: teste que falha** — `queryNaoViraRotaGlobal`: req fake de `/message/sendText/:instanceName` com `originalUrl` contendo `?x=/instance/fetchInstances` → `isRoute(req,'/instance/fetchInstances') === false`; req de `/instance` + `/fetchInstances` → true. (Os guards em si dependem de config/Prisma; o comportamento deles é coberto no smoke da Tarefa 10.)
- [ ] **Passo 2:** rodar → falha só se a Tarefa 1 não cobriu; caso já passe, seguir.
- [ ] **Passo 3:** trocar as quatro ocorrências de `req.originalUrl.includes('/instance/create' | '/instance/fetchInstances')` por `isRoute(req, …)`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(auth): guards comparam a rota exata, nao a URL com query`.

### Tarefa 3: websocket só entrega à própria instância (AUT-4)

**Arquivos:**
- Criar: `src/api/integrations/event/websocket/websocket-access.ts`
- Modificar: `src/api/integrations/event/websocket/websocket.controller.ts:30-90,144-160`
- Teste: `test/websocket-access.test.ts`

**Interfaces:**
- Produz: `type SocketPrincipal = { global: boolean; instanceName?: string }`
- Produz: `resolvePrincipal(input: { apiKey?: string; remoteAddress?: string; allowedHosts: string[]; globalKey: string; findInstanceNameByToken: (token: string) => Promise<string | null> }): Promise<SocketPrincipal | null>` — host liberado ou chave global → `{global:true}`; token de instância → `{global:false, instanceName}`; senão `null`.
- Produz: `canUseInstance(principal: SocketPrincipal | null, instanceName: string): boolean`.

- [ ] **Passo 1: testes que falham** — host liberado sem apikey → global; chave global → global; token de A → `{global:false, instanceName:'A'}`; token inválido → null; `canUseInstance({global:false,instanceName:'A'},'B') === false`, `(…'A') === true`, `({global:true},'B') === true`, `(null,'A') === false`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** implementar; no controller: `allowRequest` passa a usar `resolvePrincipal` (mesmo resultado aceitar/recusar de hoje); middleware `io.use` e `io.of(/^\/.+$/).use` resolvem o principal do `socket.handshake` (query `apikey` ou header `apikey`, `handshake.address`) e guardam em `socket.data.principal`; o do namespace recusa quando `!canUseInstance(principal, nsp.name.slice(1))`; na conexão do namespace principal, `global` entra na sala `global-events`; `GLOBAL_EVENTS` emite para `this.socket.to('global-events')`; `sendNode` só roda com `canUseInstance(socket.data.principal, data.instanceId)`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(websocket): cada conexao so recebe e envia pela propria instancia`.

### Tarefa 4: webhook da Meta por entry e Evolution só para instâncias EVOLUTION (CH-1, AUT-6 parcial)

**Arquivos:**
- Criar: `src/api/integrations/channel/meta/split-webhook.ts`
- Modificar: `src/api/integrations/channel/meta/meta.controller.ts:38-60`, `src/api/integrations/channel/evolution/evolution.controller.ts:24`
- Teste: `test/meta-split-webhook.test.ts`

**Interfaces:**
- Produz: `payloadForEntry(data: any, entry: any): any` → `{ ...data, entry: [entry] }`.

- [ ] **Passo 1: testes que falham** — payload com dois entries (phone_number_id `111` e `222`, mensagens diferentes): `payloadForEntry(data, data.entry[1]).entry[0].changes[0].value.metadata.phone_number_id === '222'` e `.entry.length === 1`; payload de um entry: `deepEqual(payloadForEntry(d, d.entry[0]), d)`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** implementar; no controller `connectToWhatsapp(payloadForEntry(data, entry))`; no Evolution `where: { number: numberId, integration: Integration.EVOLUTION }`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(meta): cada instancia processa so o proprio entry do webhook`.

### Tarefa 5: caixa da instância pela URL do webhook e bloqueio sem caixa (CW-2, CW-3, CW-10)

**Arquivos:**
- Criar: `src/api/integrations/chatbot/chatwoot/utils/inbox-selection.ts`
- Modificar: `chatwoot.service.ts` (`getInbox` ~1105-1150, `receiveWebhook` ~1700-1715, `notifyUnsentMessage` ~1670)
- Teste: `test/chatwoot-inbox-selection.test.ts`

**Interfaces:**
- Produz: `pickOwnInbox(inboxes: Array<{ id: number; name: string; webhook_url?: string | null }>, instanceName: string, nameInbox: string | undefined): { inbox: any | null; ambiguous: boolean }` — 1º caixa cujo `webhook_url` decodificado (`decodeURIComponent`, sem barra final) termina com `/chatwoot/webhook/${instanceName}`; senão, por nome; `ambiguous` quando mais de uma caixa casa pelo critério usado.
- Produz: `mustBlockSend(ownInboxId: number | null | undefined): boolean` → true quando a caixa da instância é desconhecida.
- Consome: `isFromAnotherInbox` existente.

- [ ] **Passo 1: testes que falham** — caixa com `webhook_url` `https://evo/chatwoot/webhook/GG%20-%20SUPORTE%20GRATUITO%20(API)` é escolhida para a instância `GG - SUPORTE GRATUITO (API)` mesmo com outro nome; duas caixas com o mesmo nome e nenhuma URL da instância → a primeira, `ambiguous: true`; caixa renomeada mas com URL da instância → achada; nenhuma → `{inbox:null}`; `mustBlockSend(null) === true`, `mustBlockSend(162) === false`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** `getInbox` usa `pickOwnInbox` (cache continua validado pelo nome OU pelo id da caixa escolhida; com `ambiguous`, `logger.error` dizendo o nome repetido); em `receiveWebhook`, depois do guard de outra caixa, para `message_created` de saída e `message_updated` com `deleted`: `if (mustBlockSend(ownInbox?.id))` → `logger.error` e `return { message: 'bot' }`; `notifyUnsentMessage` não escreve quando `isFromAnotherInbox(body, (await this.getInbox(instance))?.id)`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(chatwoot): caixa da instancia pela URL do webhook; sem caixa nao envia`.

### Tarefa 6: Chatwoot desligado, instanceId ausente, conversa em cache, assinatura, leitura (CW-1, CW-6, CW-7, CW-8, CW-9)

**Arquivos:**
- Modificar: `chatwoot/utils/webhook-message.ts`, `chatwoot.service.ts` (`receiveWebhook`, `createConversation` ~850-881, `MESSAGE_READ` ~1967), `src/api/services/channel.service.ts:367-371`
- Teste: `test/chatwoot-webhook-message.test.ts` (acrescentar)

**Interfaces:**
- Produz em `webhook-message.ts`: `signatureName(body: any): string | undefined` → `body.sender?.available_name ?? body.sender?.name`; `belongsToInbox(conversation: any, inboxId: number | null | undefined): boolean` → `false` se o `inbox_id` da conversa existe e difere.

- [ ] **Passo 1: testes que falham** — `signatureName` ignora `conversation.messages[0].sender` (payload com cliente em `messages[0]` e atendente em `sender`); `belongsToInbox({inbox_id:160},162) === false`, `({inbox_id:162},162) === true`, `({},162) === true`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** no `receiveWebhook`, logo após `clientCw`: provider com `enabled === false` → `logger.warn('Chatwoot desligado em <instância>: evento ignorado')` e `return { message: 'bot' }`; depois de resolver `waInstance`, sem `instanceId` → `logger.warn` e retorno antes de qualquer consulta Prisma; `senderName = signatureName(body)`; no caminho do cache de `createConversation`, `!belongsToInbox(conversationExists, filterInbox.id)` → apaga a chave e segue criando; `MESSAGE_READ` filtra `chatwootConversationId: body.conversation.id`, `chatwootIsRead: false` e `orderBy: { messageTimestamp: 'desc' }`; `clearCacheChatwoot` limpa sempre.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(chatwoot): desligado nao envia; consultas sempre com a instancia`.

### Tarefa 7: não reenviar o que já saiu e importação com conta/caixa (CW-5 parcial, CW-4)

**Arquivos:**
- Modificar: `chatwoot/utils/webhook-dispatcher.ts` (`runNext`), `chatwoot.service.ts` (`receiveWebhook`, `updateChatwootMessageId` ~2068), `chatwoot/utils/chatwoot-import-helper.ts` (`updateMessageSourceID`, `getExistingSourceIds`)
- Teste: `test/chatwoot-webhook-dispatcher.test.ts` (acrescentar)

**Interfaces:**
- Muda: `updateMessageSourceID(messageId, sourceId, scope: { accountId: number | string; inboxId: number })` — SQL com `AND account_id = $3 AND inbox_id = $4`; sem `scope` completo não roda.
- Muda: `getExistingSourceIds(sourceIds: string[], inboxId?: number)` — com `inboxId`, filtra `AND inbox_id = $2`.

- [ ] **Passo 1: teste que falha** — dispatcher: job marcado `done` no store entre o enfileiramento e a execução não chama `handle` (store fake com `isDone` true).
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** `runNext` reconfere `store.isDone(job)` antes de `handle`; em `receiveWebhook`, para `message_created` de saída: `prisma.message.findFirst({ where: { instanceId, chatwootMessageId: body.id } })` existente → `logger.warn` "já enviada" e retorno; `updateChatwootMessageId` passa `{ accountId: provider.accountId, inboxId: (await this.getInbox(instance))?.id }`; chamadas de `getExistingSourceIds` na importação passam o `inbox.id` que já têm.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(chatwoot): nao reenvia mensagem ja enviada; importacao filtra conta e caixa`.

### Tarefa 8: chatbots (BOT-1 a BOT-6)

**Arquivos:**
- Modificar: `openai/services/openai.service.ts`, `openai/controllers/openai.controller.ts:36,472`, `chatbot/chatbot.controller.ts:109-134`, `base-chatbot.controller.ts:277-281,430-500,922`, `typebot/services/typebot.service.ts:103,119,141,991`
- Teste: `test/chatbot-isolation.test.ts`

**Interfaces:**
- Produz: `debounceKey(instanceId: string, remoteJid: string): string` em `src/api/integrations/chatbot/utils/debounce-key.ts` → `${instanceId}:${remoteJid}`.
- Muda: os métodos privados do OpenaiService que usavam `this.client` recebem `client: OpenAI` como primeiro parâmetro; `initClient` vira `createClient(apiKey): OpenAI` sem gravar campo.

- [ ] **Passo 1: teste que falha** — `debounceKey('i1','x@s') !== debounceKey('i2','x@s')`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** BOT-1 (sem `this.client` no serviço e no controller); BOT-2 (`processDebounce` usa `debounceKey(instance.instanceId, remoteJid)`); BOT-3 (Typebot chama `speechToText(msg, { instanceId: instance.id })`; `speechToText` retorna `null` com `logger.error` se `!instance?.instanceId`); BOT-4 (`instance.token` no lugar da chave global nos três pontos); BOT-5 (`changeStatus` resolve `instanceId` via `waMonitor.waInstances[instance.instanceName].instanceId`, usa nos três `where` e passa `{ ...instance, instanceId }` a `getSession`); BOT-6 (`fetchBot` devolve `null`/404 quando `bot.instanceId !== instanceId`).
- [ ] **Passo 4:** teste, tsc, eslint; `grep -n "this.client" src/api/integrations/chatbot/openai` vazio.
- [ ] **Passo 5:** commit `fix(chatbot): cliente OpenAI, debounce, sessoes e bots sempre da propria instancia`.

### Tarefa 9: canais e cache (CH-3, CH-6, CH-8, CH-9, CH-11)

**Arquivos:**
- Modificar: `whatsapp.baileys.service.ts:5076, 1552, 1859, 4606, 4622, 2628`, `whatsapp.business.service.ts:875`, `src/utils/onWhatsappCache.ts:55-62`
- Teste: `test/onwhatsapp-match.test.ts`

**Interfaces:**
- Produz: `jidOptionsMatch(jidOptions: string, jid: string): boolean` em `src/utils/onWhatsappCache.ts` (exportada) — compara as opções separadas por vírgula com igualdade exata.

- [ ] **Passo 1: teste que falha** — `jidOptionsMatch('491234555511999999999@s.whatsapp.net', '5511999999999@s.whatsapp.net') === false`; `jidOptionsMatch('5511999999999@s.whatsapp.net,123@lid', '123@lid') === true`.
- [ ] **Passo 2:** rodar → falha.
- [ ] **Passo 3:** CH-11: depois do `findFirst` com `contains`, descartar o registro se nenhum `expandedJids` casa por `jidOptionsMatch` e o `remoteJid` também não é igual (mesmo padrão de `saveLidPnMappings`); CH-3: `where: { instanceId: this.instanceId, remoteJid }`; CH-6: `where: { instanceId: this.instanceId, remoteJid: contact.remoteJid }`; CH-8: prefixo `${this.instanceId}_` nas duas chaves; CH-9: chave `${this.instanceId}:${groupJid}` em set/get/has do `groupMetadataCache`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(channel): nao lidas, contatos, cache de grupo e onWhatsapp por instancia`.

### Tarefa 10: verificação, report e release

**Arquivos:**
- Criar: `docs/superpowers/reports/2026-10-27-isolamento-instancias-rc14.md`, `docs/superpowers/releases/v2.3.7-sphot-rc14.md`
- Modificar: `docs/pendencias.md` (itens resolvidos para "Resolvidas"), `test/e2e/smoke.py` (cenários AUT-1 e AUT-2)

- [ ] **Passo 1:** acrescentar ao smoke: com o token da instância A, `POST /message/sendText/A?instanceName=B` não envia por B (envia por A ou 401) e `GET /instance/fetchInstances?x=1` com token de A só lista A; `POST /instance/create?x=/instance/fetchInstances` com token de instância → 401/403.
- [ ] **Passo 2:** todos os `test/*.test.ts`, `npm run build`.
- [ ] **Passo 3:** imagem de teste `sphott/evolution-api:v2.3.7-sphot-rc14-test3` (amd64, `--builder multiarch`), deploy na VPS (`vps_deploy.py`).
- [ ] **Passo 4:** VPS: smoke (`SMOKE_WEBHOOK_URL=off`), dedup 3 rodadas, `echo_repro.py`, `other_inbox.py`, áudio da Cloud pela conversa 124, Chatwoot desligado numa instância de teste não envia (religar depois), webhook da Meta com dois entries (forjado: entry 1 com o phone_number_id da NexaAI-Cloud e mensagem A, entry 2 com um phone_number_id sem instância e mensagem B; a NexaAI-Cloud grava só A).
- [ ] **Passo 5:** report e release note (rc14 só é gerada com o OK do usuário); commit `docs: report e release da rc14`.
