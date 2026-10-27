# Pendências conhecidas

Falhas encontradas e ainda não corrigidas. Os IDs são os da [auditoria de 27/10](superpowers/research/2026-10-27-auditoria-isolamento-instancias.md), onde estão o arquivo:linha e o cenário de cada uma. Quando uma pendência for resolvida, mova a linha para "Resolvidas" com o commit.

## Abertas

### Precisam de decisão ou mudam configuração

| ID | Grav. | Problema | Por que não entrou | Caminho sugerido |
|---|---|---|---|---|
| AUT-3 | crítico | Webhook do Chatwoot (`/chatwoot/webhook/:instance`) sem autenticação: quem sabe o nome da instância envia por ela | Exigir token quebraria as caixas atuais na atualização (decisão de 27/10) | Token opcional na URL, gravado pelo `/chatwoot/set`; modo transição (aceita sem token e registra aviso), e só exige quando uma env opcional for ligada. Enquanto isso: não divulgar nomes de instância; restringir `/chatwoot/webhook` no Traefik ao IP do Chatwoot |
| AUT-5 | alto | Webhook da Meta sem validação de `X-Hub-Signature-256` | Precisa do App Secret em env nova (decisão de 27/10) | Env opcional `WA_BUSINESS_APP_SECRET`: valida só quando definida |
| AUT-6 | alto | `/webhook/evolution` sem autenticação (o filtro por integração entrou na rc14, 07b78a80) | Muda o contrato do canal Evolution | Header com segredo compartilhado, opcional por env |
| AUT-7 | alto | Pusher publica em canais públicos com o nome da instância | Muda o contrato dos consumidores; Pusher não é usado | Canais `private-` com endpoint de auth |
| AUT-8 | médio | `apikey` da instância em todo payload de evento (com `EXPOSE_IN_FETCH_INSTANCES=true`) | Consumidores podem depender do campo | Env opcional para tirar o campo; nunca mandar a destinos globais |
| AUT-9 | médio | Lista de IPs liberados do `/metrics` nunca vale (`filter(...) === 0`) | Corrigir passaria a bloquear quem hoje acessa | Corrigir junto com revisão da config de métricas |
| BOT-9 | médio | n8n/Flowise/EvoAI recebem `sessionId = remoteJid`: memória dividida entre instâncias no mesmo fluxo | Mudar o id zera a memória dos fluxos atuais | `${instanceId}:${remoteJid}` só para sessões novas |
| BOT-10 | médio | `getSession` sem filtro por tipo de bot | Muda qual bot responde | Filtrar por `type` |
| BOT-11 | baixo | Fallback do Dify/n8n lê a coluna errada e nunca dispara | Ligar o fallback muda comportamento | Corrigir quando alguém usar |
| CW-12 | baixo | Nome de instância sem validação (glob no Redis, nomes reservados) | Instâncias existentes podem ter nomes que não passariam | Escapar o glob no `deleteAll`; validar só em criação nova |

### Exigem desenho maior

| ID | Grav. | Problema | Caminho sugerido |
|---|---|---|---|
| CW-5 | médio | Fila do webhook do Chatwoot sem reserva atômica: dois processos no mesmo Redis podem enviar a mesma mensagem. A rc14 reconfere se o job já foi concluído antes de processar, mas uma queda entre o envio e a marca de concluído ainda reenvia no boot | `SET NX` com TTL por job; checagem "já enviada" pelo banco só com índice `(instanceId, chatwootMessageId)` (migration). **Operacional até lá:** atualização do serviço em modo stop-first (padrão do Swarm), uma réplica só |
| CW-9 | baixo-médio | `MESSAGE_READ` marca como lida uma mensagem qualquer da instância (sem conversa nem ordem) | Filtrar pela conversa e ordenar exige índice (`chatwootConversationId`) e passaria a mandar recibos de leitura que hoje não saem: decidir junto |
| CW-15 | baixo | Importação de histórico compara os `source_id` existentes (com prefixo `WAID:`) com `key.id` sem prefixo: o filtro de duplicados nunca casa | Comparar sem o prefixo |
| CW-11 | baixo | Isolamento por chamada (ALS) frágil: escopo reaproveitado e fallback `lastProvider` | Um ALS por objeto, guardando o nome da instância; sem fallback no singleton |
| CW-13 | baixo | Id de job `message_updated-<id>` descarta atualizações seguintes da mesma mensagem por 24h | Incluir `deleted`/`updated_at` no id |
| CW-14 | baixo | Dois deploys no mesmo Redis e `PREFIX_KEY` processam os jobs um do outro | **Operacional:** produção e teste nunca dividem Redis/prefixo |
| CH-2 | alto | `Instance.number` não é único; webhook da Meta com `phone_number_id` repetido vai para qualquer uma | Consulta de duplicados antes de corrigir (`select number, count(*) from "Instance" where integration='WHATSAPP_BUSINESS' group by 1 having count(*)>1`); depois índice único parcial |
| CH-4 | médio | Instância apagada durante o backoff continua reconectando e derruba nova instância de mesmo nome | Cancelar timer e encerrar socket no `remove.instance`; eventos com instanceId |
| CH-5 | médio | Limpeza do delete não aguardada e por nome: apagar e recriar rápido apaga a sessão da nova | Resolver o id uma vez e aguardar a limpeza |
| CH-14 | baixo | Corrida em dois creates com o mesmo nome | Não engolir o erro do `saveInstance` |
| CH-16 | médio | `let baileys_connection_state` no módulo do Wavoip | Estado por instância |
| CH-17 | médio | Só `changes[0]`/`messages[0]` do webhook da Meta são processados; o ramo de status de template olha só `entry[0]` | Iterar todos |

### Baixo risco ou integrações não usadas

| ID | Problema |
|---|---|
| AUT-10 | `/store` estático sem autenticação |
| BOT-7 | `fallbackId`/`openaiCredsId` de outra instância aceitos |
| BOT-8 | `speechToText` da Meta com argumentos invertidos (sempre falha; a proteção do BOT-3 impede o uso de chave alheia; com OpenAI ligado na Cloud o texto vira `[audio] null`) |
| BOT-12 | Typebot `startBot` com `startSession=false` não envia |
| BOT-13 | Checagem de apiKey OpenAI duplicada revela uso por outro cliente |
| BOT-14 | Reject dentro de `setTimeout` trava a fila de envio do bot |
| CH-7 | Canal Evolution: `chat.updateMany` sem `instanceId` e `chat.create` sempre |
| CH-10 | Chave `protocol_<id>` sem instância |
| CH-12 | `TemplateService` guarda `businessId`/`token` em campo do singleton (seguro hoje; um `await` novo traz o bug) |
| CH-13 | `phoneNumber` do serviço da Meta sobrescrito por webhooks simultâneos |
| CH-15 | S3 `getMedia`/`getMediaUrl` listam mídia de todas as instâncias (S3 não usado) |
| CH-18 | Nomes de tópico/subject/exchange sem escape (instância `global`, `.`, `*`) |
| CH-19 | Pusher altera o objeto do evento (Kafka perde o QR) |
| CH-20 | Telemetria envia o path com nome da instância |
| CH-21 | `processAudio` do Baileys: `.on('error')` depois do `.pipe(...)` fica no stream de saída e não no comando do ffmpeg; o erro tardio "Output stream closed" (sob carga) vira uncaughtException (registrada, não derruba). Mover o `.on('error')` para antes do `.pipe` |
| WS-1 | Websocket: token de instância conectado no namespace `/` com `GLOBAL_EVENTS` deixa de receber os eventos da própria instância (só o global recebe); `findFirst({token})` com tokens repetidos entre instâncias |

### Incidente de 26/10

- Rota pela qual a instância da Uasy recebeu eventos de outras caixas: falta consultar `webhooks` e `agent_bots` do Chatwoot de produção e o log do Traefik (ver [incidente](superpowers/research/2026-10-26-incidente-templates-cloud.md)).

## Resolvidas

| ID | Commit | Release |
|---|---|---|
| Eco pelo `messages[0]` | 671276f6 | rc14 |
| Evento de outra caixa | 9c706c70 | rc14 |
| Disputa pelo `provider` do ChatwootService | c572d688 | rc14 |
| AUT-1, AUT-11 (query trocava a instância do path) | 79d80b38, 2c2dee0c | rc14 |
| AUT-2 (token de instância passava como chave global) | 3f383ef8 | rc14 |
| AUT-4 (websocket entre instâncias) | 710862d2 | rc14 |
| CH-1 (webhook da Meta com vários entries) e filtro de integração do AUT-6 | 07b78a80 | rc14 |
| CW-2, CW-3, CW-10 (caixa da instância; sem caixa não envia) | 22a2238f | rc14 |
| CW-1, CW-6, CW-7, CW-8 (Chatwoot desligado, instanceId ausente, conversa em cache, assinatura) | 0f78309e | rc14 |
| CW-4 e parte do CW-5 (importação com conta/caixa; fila reconfere job concluído) | 37f5cac0 | rc14 |
| BOT-1 a BOT-6 (OpenAI, debounce, Typebot, changeStatus, fetchBot) | e9f041a6 | rc14 |
| CH-3, CH-6, CH-8, CH-9, CH-11 (não lidas, contatos, caches, onWhatsapp) | bd7309a3 | rc14 |
