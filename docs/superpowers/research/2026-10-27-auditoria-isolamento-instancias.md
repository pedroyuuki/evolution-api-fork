# Auditoria: isolamento entre instâncias e envios pelo número errado

Data: 27/10/2026. Branch `v2.3.7-sphot-rc13` @ c572d688. Motivação: [incidente de 26/10](2026-10-26-incidente-templates-cloud.md).

## Escopo e método

Quatro varreduras em paralelo, só de leitura:

1. integração Chatwoot;
2. demais chatbots;
3. canais WhatsApp, banco, cache e utils;
4. eventos, autenticação e rotas.

O alvo era tudo que pode fazer uma instância enviar, ler, gravar ou guardar em cache dados de outra, ou reenviar o que não devia. Os achados críticos e altos foram conferidos no código depois, e estão marcados **[verificado]**. Os demais são relatos da varredura, a confirmar durante a correção. AUT-1 foi reproduzido com um script Express 4.21.2 isolado.

Gravidade:

- **crítico**: envio pelo número errado, ou leitura/escrita de dados de outro cliente;
- **alto**: o mesmo, com uma condição a mais;
- **médio** e **baixo**: o restante.

## Autenticação e rotas (AUT)

| ID | Grav. | Onde | Problema | Cenário |
|---|---|---|---|---|
| AUT-1 | crítico [verificado] | `abstract/abstract.router.ts:36` | `dataValidate` faz `Object.assign(request.params, request.query)` depois dos guards. | `POST /message/sendText/A?instanceName=B` com o token de A envia pelo número B. Vale para todas as rotas com dataValidate: ler mensagens, trocar o webhook, logout, delete. |
| AUT-2 | crítico [verificado] | `guards/auth.guard.ts:23,37`, `guards/instance.guard.ts:26,43` | Usa `originalUrl.includes('/instance/fetchInstances')`, e o `originalUrl` inclui a query string. | `POST /instance/create?x=/instance/fetchInstances` com token de instância passa como chave global. `/verify-creds` também, e devolve `FACEBOOK_USER_TOKEN`. |
| AUT-3 | crítico [verificado] | `chatwoot/routes/chatwoot.router.ts:35` | `POST /chatwoot/webhook/:instance` não tem autenticação. | Quem sabe o nome da instância envia texto por ela para qualquer número, desconecta o número (`/disconnect`), faz SSRF via `attachments[].data_url` e apaga mensagens. |
| AUT-4 | crítico [verificado] | `event/websocket/websocket.controller.ts:44-83,144` | O token é validado só no handshake. Qualquer token conecta em qualquer namespace. | Recebe todos os eventos de outra instância, incluindo o apikey. `sendNode` envia stanza crua por qualquer instância (`waInstances[data.instanceId]`). Com `GLOBAL_EVENTS`, todo cliente recebe tudo. `WEBSOCKET_ALLOWED_HOSTS` dispensa o apikey. |
| AUT-5 | alto | `channel/meta/meta.router.ts:15`, `meta.controller.ts` | Não valida `X-Hub-Signature-256`. | POST forjado com um `phone_number_id` conhecido injeta mensagens recebidas falsas. Bots e Chatwoot respondem pelo número da instância. |
| AUT-6 | alto | `channel/evolution/evolution.controller.ts:24-32` | `/webhook/evolution` não tem autenticação, e o `findFirst({number})` não filtra `integration`. | `numberId` = número de uma instância Baileys chama `connectToWhatsapp(obj)` e força reconexão. Em instância EVOLUTION, injeta mensagens. |
| AUT-7 | alto | `event/pusher/pusher.controller.ts:176,201` | Os canais do Pusher são públicos, com o nome da instância. | Com Pusher global, quem tem a chave pública assina qualquer instância. |
| AUT-8 | médio | `services/channel.service.ts:455-467` | `apikey` da instância vai em todo payload de evento quando `EXPOSE_IN_FETCH_INSTANCES=true`. | O token chega a terceiros (n8n etc.). Destinos globais recebem os tokens de todos. |
| AUT-9 | médio | `routes/index.router.ts:59` | `allowedIPs.filter(...) === 0` compara um array com 0 e nunca é verdadeiro. | A lista de IPs liberados do `/metrics` nunca vale. |
| AUT-10 | baixo | `main.ts:64` | `/store` é estático, sem autenticação. | Hoje quase vazio. |
| AUT-11 | baixo | `abstract/abstract.router.ts:40` | `originalUrl.includes('/instance/create')` junta o body nos params de qualquer rota com `?x=/instance/create`. | Hoje bloqueado por acaso pelo `instanceLoggedGuard`. |

## Chatwoot (CW)

| ID | Grav. | Onde | Problema | Cenário |
|---|---|---|---|---|
| CW-1 | alto [verificado] | `chatwoot.service.ts:115-150`, `channel.service.ts:297,367` | `receiveWebhook` não confere `provider.enabled`. Ao desligar o Chatwoot, `clearCacheChatwoot` só limpa se `enabled` (que já virou false), e o cache dura 7 dias. | Instância com o Chatwoot desligado, mas com webhook (da caixa, da conta ou de agente-robô) apontando para ela, continua enviando. Pode ser a rota do incidente. |
| CW-2 | alto | `utils/webhook-message.ts:42-52`, `chatwoot.service.ts:1707` | `isFromAnotherInbox` deixa passar quando não sabe a caixa da instância (`getInbox` null, por exemplo depois de renomear a caixa) ou a do evento. | Com webhook da conta apontando para X, X envia mensagens de todas as caixas. |
| CW-3 | médio-alto | `chatwoot.service.ts:1139`, `:242-276` | A caixa da instância é achada só pelo nome. Na configuração, a Evolution reaproveita qualquer caixa com o mesmo nome. | Duas instâncias com o mesmo `nameInbox` resolvem para a mesma caixa, e a resposta sai pelo número da outra. |
| CW-4 | alto [verificado] | `chatwoot-import-helper.ts:570-576`, `:193-195`; `chatwoot.service.ts:448-483`, `:3253` | O banco de importação é um só (`CHATWOOT_IMPORT_DATABASE_CONNECTION_URI`). `UPDATE messages ... WHERE id = $2` não filtra conta nem caixa e roda em toda mensagem enviada pelo webhook. `getExistingSourceIds` também não filtra a caixa. | Com instâncias em contas ou servidores diferentes, altera o `source_id`/`created_at` de mensagem de outro cliente. |
| CW-5 | médio | `utils/webhook-dispatcher.ts:158-162`, `:247-261` | A fila garante "pelo menos uma vez": não reserva o job de forma atômica e não reconfere `isDone` antes de rodar. | Troca de imagem start-first, ou duas réplicas no mesmo Redis: os dois processos enviam a mesma mensagem. Queda entre o envio e o `markDone` reenvia no boot. |
| CW-6 | médio [verificado] | `chatwoot.service.ts:1731-1756` | `instance.instanceId = waInstance?.instanceId` pode ficar undefined, e o Prisma ignora o filtro em `findFirst`/`deleteMany` por `chatwootMessageId`. | Logo após o boot, um evento de exclusão apaga registros de mensagem de todas as instâncias com aquele id. |
| CW-7 | médio | `chatwoot.service.ts:850-881` | A conversa em cache (`createConversation-<jid>`) não é conferida contra a caixa da instância. | Cache apontando para conversa de outra caixa: a mensagem recebida cai na caixa errada e a resposta sai pelo outro número. |
| CW-8 | baixo-médio [verificado] | `chatwoot.service.ts:1727` | O nome da assinatura vem de `conversation.messages[0]`, o mesmo erro da causa 1 do incidente. | Com `signMsg`, a mensagem sai assinada com o nome do cliente ou de outro atendente. |
| CW-9 | baixo-médio | `chatwoot.service.ts:1967-1975` | `MESSAGE_READ` marca como lida uma mensagem qualquer da instância (sem conversa nem ordem). | Recibo de leitura enviado para um chat não relacionado. |
| CW-10 | baixo | `chatwoot.service.ts:1670-1676` | `notifyUnsentMessage` não passa pelo guard de caixa. | Nota privada "não enviada" numa conversa de outra caixa. |
| CW-11 | baixo | `utils/provider-context.ts` | O isolamento por chamada (ALS) funciona, mas é frágil: o escopo é reaproveitado e há o fallback `lastProvider`. | Hoje nenhum caminho chama a instância B dentro do escopo de A. Fica para reforço. |
| CW-12 | baixo | `validate/instance.schema.ts:29` | Nome de instância sem validação, e `deleteAll(name)` vira glob no Redis. | Instância chamada `webhook` ou com `*`/`:` apaga chaves de outras instâncias. |
| CW-13 | baixo | `utils/webhook-dispatcher.ts` | O id do job `message_updated-${id}` descarta atualizações seguintes da mesma mensagem por 24h. | Exclusão depois de outra atualização não chega ao WhatsApp. |
| CW-14 | baixo | dispatcher | Dois deploys no mesmo Redis e com o mesmo `PREFIX_KEY` processam os jobs um do outro. | Operacional: produção e teste não podem dividir o Redis. |

## Chatbots (BOT)

| ID | Grav. | Onde | Problema | Cenário |
|---|---|---|---|---|
| BOT-1 | crítico [verificado] | `openai/services/openai.service.ts:21,37-39` | `this.client` (OpenAI com a chave) fica num serviço compartilhado e é trocado a cada mensagem. | O texto do cliente A vai para a conta OpenAI do cliente B. Thread/run do assistant com a chave errada dá 404 e o cliente fica sem resposta. |
| BOT-2 | crítico [verificado] | `chatbot/chatbot.controller.ts:109-134` | O debounce é identificado só por `remoteJid`. | Grupo com dois números nossos, ou cliente falando com dois números: as mensagens se juntam, A não responde e B responde com o texto de A. |
| BOT-3 | crítico [verificado] | `typebot/services/typebot.service.ts:991`, `openai.service.ts:681` | `speechToText(msg, instance)` recebe a linha Prisma (`.id`, sem `.instanceId`), e o `findFirst({instanceId: undefined})` devolve a configuração de qualquer instância. | O áudio é transcrito na conta OpenAI de outro cliente. |
| BOT-4 | crítico [verificado] | `typebot.service.ts:103,119,141` | Manda a chave GLOBAL da Evolution como variável para a URL do Typebot e a grava em `IntegrationSession.parameters`, que `fetchSessions` devolve. | Quem configura um Typebot recebe a chave mestra. |
| BOT-5 | alto [verificado] | `base-chatbot.controller.ts:450,462-490` | `changeStatus` apaga ou fecha sessões por `remoteJid` sem `instanceId`. `getSession` recebe o DTO sem `instanceId`. | Fechar o contato X na instância A apaga as sessões de bot de X em todas as instâncias. |
| BOT-6 | alto [verificado] | `base-chatbot.controller.ts:277-281` | `fetchBot` faz `findUnique({id})` sem conferir de quem é o bot. | Com o token de A, lê o bot de B, com URL, apiKey e senha. |
| BOT-7 | médio | `base-chatbot.controller.ts:328,822`, `openai.controller.ts:53,68,189,374` | `fallbackId` e `openaiCredsId` de outra instância são aceitos. | A usa as credenciais de B. Exige saber o id. |
| BOT-8 | médio | `meta/whatsapp.business.service.ts:662,711` | `speechToText` é chamado com os argumentos invertidos. | Hoje sempre falha (TypeError). Se alguém corrigir só metade, vira o BOT-3. |
| BOT-9 | médio | `flowise.service.ts:59`, `n8n.service.ts:49`, `evoai.service.ts:133` | O `sessionId` enviado ao bot externo é só o `remoteJid`. | Um fluxo n8n/Flowise usado por várias instâncias divide a memória da conversa. |
| BOT-10 | médio | `chatbot.controller.ts:170-208` | `getSession` não filtra pelo tipo de bot. | A sessão de um bot é processada por outro (dentro da mesma instância). |
| BOT-11 | baixo | `dify.controller.ts:36`, `n8n.controller.ts:36` | Lê `fallbackId`, mas a coluna é `difyIdFallback`/`n8nIdFallback`. | O fallback do Dify e do n8n nunca dispara. |
| BOT-12 | baixo | `typebot.controller.ts:275-291` | `startBot` com `startSession=false` passa `session=null`. | Nada é enviado. |
| BOT-13 | baixo | `openai.controller.ts:239-247` | A checagem de apiKey duplicada olha todas as instâncias. | Revela que outro cliente usa a mesma chave. |
| BOT-14 | baixo | `base-chatbot.service.ts:289-302` | Um reject dentro do `setTimeout` nunca resolve a promise. | A fila de envio trava. |

## Canais, banco e cache (CH)

| ID | Grav. | Onde | Problema | Cenário |
|---|---|---|---|---|
| CH-1 | crítico [verificado] | `meta/meta.controller.ts:38-60`, `whatsapp.business.service.ts:139` | Acha a instância por entry, mas passa o payload inteiro, e o serviço lê sempre `entry[0]`. | POST da Meta com entries de dois números: B processa a mensagem de A como sua (grava, dispara webhook, Chatwoot e bot) e responde pelo número errado. |
| CH-2 | alto | `meta.controller.ts:48`, schema | `Instance.number` não é único, e a busca não filtra `integration`/`clientName`. | Duas instâncias com o mesmo `phone_number_id`: os eventos vão para uma qualquer. |
| CH-3 | alto [verificado] | `whatsapp.baileys.service.ts:5076-5088` | `updateChatUnreadMessages` faz `chat.findFirst({remoteJid})` sem `instanceId` e atualiza o resultado. | A conta de não lidas de A é gravada no chat de B. |
| CH-4 | médio | `instance.controller.ts` (delete), `monitor.service.ts:393-436` | A instância apagada durante o backoff de reconexão não cancela o `reconnectTimer`. | Ela reconecta e os eventos por nome derrubam uma nova instância criada com o mesmo nome. |
| CH-5 | médio | `monitor.service.ts:399-400,167-175` | A limpeza do delete não é aguardada e acha a instância pelo nome. | Apagar e recriar rápido com o mesmo nome apaga a sessão da nova. |
| CH-6 | médio | `whatsapp.business.service.ts:875` | `contact.updateMany({remoteJid})` sem `instanceId`. | Bloqueado pelo índice único, mas a atualização do pushName falha quando o contato existe em duas instâncias. |
| CH-7 | médio | `evolution.channel.service.ts:270,293` | `chat.updateMany({remoteJid})` sem `instanceId`, e `chat.create` sempre. | Erro no canal Evolution. |
| CH-8 | médio | `whatsapp.baileys.service.ts:1552,1859` | A chave de dedup de leitura no `baileysCache` não leva a instância. | Duas instâncias no mesmo grupo: a segunda pula a atualização de lidas/não lidas. |
| CH-9 | baixo | `whatsapp.baileys.service.ts:164,4606,4622,2628` | O `groupMetadataCache` é global, só pelo JID do grupo. | Uma instância fora do grupo passa no "Group not found" e o Baileys usa a visão de participantes de outra instância. |
| CH-10 | baixo | `whatsapp.baileys.service.ts:1310,1806` | `protocol_${key.id}` sem a instância. | O valor é o mesmo para todos. Baixo. |
| CH-11 | baixo | `utils/onWhatsappCache.ts:55-62` | `contains` sem conferência exata depois. | Pode juntar o número X à linha de Y (destinatário errado). Raro. |
| CH-12 | baixo | `services/template.service.ts:19-130` | `this.businessId`/`this.token` num singleton. | Seguro hoje porque não há `await` entre a gravação e o uso. Um `await` novo traz o bug do incidente. |
| CH-13 | baixo | `whatsapp.business.service.ts:149,890` | `phoneNumber` sobrescrito por webhooks simultâneos. | Impacto mínimo. |
| CH-14 | baixo | `monitor.service.ts:260` | `saveInstance` engole o erro. Corrida em dois creates com o mesmo nome. | Só com a chave global. |
| CH-15 | crítico [verificado] | `storage/s3/services/s3.service.ts:15-18` | `instanceId` vem undefined do DTO, e o body entra no `where`. | `getMedia` lista mídias de todas as instâncias. Produção não usa S3. |
| CH-16 | médio | `channel/whatsapp/voiceCalls/useVoiceCallsBaileys.ts:6` | `let baileys_connection_state` no nível do módulo. | O estado de uma instância vaza para a outra no Wavoip. |
| CH-17 | médio | `whatsapp.business.service.ts` | Só `changes[0]` e `messages[0]` do webhook da Meta são processados. | Mensagens em lote são perdidas. |
| CH-18 | baixo | kafka/nats/rabbitmq | Os nomes de tópico, subject e exchange usam o nome da instância sem escape. | Instância chamada `global` ou com `.`/`*` cai em canais de outra. |
| CH-19 | baixo | `pusher.controller.ts:148` | `delete ...qrcode.base64` altera o objeto compartilhado. | O Kafka perde o QR. |
| CH-20 | baixo | `telemetry.guard.ts` | A telemetria envia `req.path` (com o nome da instância) para log.evolution-api.com. | Privacidade. |

## Conferido e seguro

- **Eventos.**
  - O EventManager e o webhook montam a configuração e o payload por chamada.
  - O retry não mistura instâncias.
  - No RabbitMQ, SQS, NATS e Kafka, a fila e o payload vêm do `instanceName` da chamada.
- **Guards e rotas.**
  - Com `:instanceName`, o token é comparado ao da instância (salvo AUT-1 e AUT-2).
  - `fetchInstances` com token de instância filtra pelo token.
  - Os controllers de envio, chat, grupo, label e business delegam ao serviço da instância.
- **Chatwoot.**
  - As chaves do dispatcher e do cache do serviço levam `instanceName`.
  - Cada job do dispatcher roda num escopo novo.
  - Não sobrou outro campo por requisição.
  - Os ecos levam `WAID:`.
  - Os outros eventos (status, contato, typing, nota privada) não enviam ao WhatsApp.
- **Chatbots.**
  - Os pontos de emit passam a instância certa.
  - As respostas dos bots não reentram (`isIntegration=false`).
  - A sessão é atualizada por `session.id`, e a busca de trigger e de settings filtra por `instanceId`.
- **Canais.** Filtram por `instanceId`:
  - Baileys: as gravações de chats, contatos e mensagens, `messages.update`, `getMessage`, `fetchMessages`, labels, `deleteMessage`/`updateMessage` (corrigidos em 8ad88d04);
  - Meta: a busca de status;
  - o estado de autenticação.
  - As tabelas IsOnWhatsapp e LID↔PN são globais de propósito.
