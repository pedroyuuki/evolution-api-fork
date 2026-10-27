# Spec: isolamento entre instâncias na rc14

Base: [auditoria de 27/10](../research/2026-10-27-auditoria-isolamento-instancias.md) e [incidente de 26/10](../research/2026-10-26-incidente-templates-cloud.md). Os IDs (AUT-1, CW-1...) são os da auditoria.

## Objetivo

Nenhuma instância envia, lê ou grava dados de outra, nem reenvia o que não devia. A atualização em produção é limpa: trocar a imagem e continuar funcionando.

## Decisões do usuário (27/10)

- O webhook do Chatwoot continua sem token (AUT-3). Exigir token quebraria as caixas existentes na atualização.
- O webhook da Meta continua sem validar assinatura (AUT-5). Precisaria de env nova e de configuração.
- Produção usa Baileys, Cloud API, webhook por instância, Chatwoot e RabbitMQ. Os demais (OpenAI, Typebot, n8n, websocket, Pusher, S3...) não são usados. As correções simples deles entram, com teste unitário. As que mudam comportamento ficam pendentes.
- O que não entrar vai para [pendencias.md](../../pendencias.md).

## Escopo

### Autenticação

| ID | Correção | Teste |
|---|---|---|
| AUT-1 | Em `dataValidate`, o `instanceName` vem só do path. A query continua sendo lida para os outros campos (`{...query, ...params}`), sem nunca sobrescrever `instanceName`. | Unitário: query com `instanceName` não troca a instância. |
| AUT-2 | Guards comparam o caminho exato (`req.baseUrl + req.path` / `req.route.path`), não `originalUrl.includes`. Vale para `auth.guard.ts` e `instance.guard.ts`. | Unitário: `?x=/instance/fetchInstances` não passa como global; `fetchInstances` com token de instância continua funcionando. |
| AUT-11 | Pela mesma regra, a junção do body nos params só vale na rota `/instance/create` de verdade. | Unitário. |
| AUT-4 | Websocket: o namespace `/<instância>` só aceita o token da própria instância ou o global. Eventos globais vão só para quem conectou com o token global. `sendNode` só com o token global ou com o da própria instância. | Unitário com socket.io (servidor e cliente locais). |
| AUT-6 (parcial) | `/webhook/evolution` só considera instâncias com `integration = EVOLUTION`. A autenticação fica pendente. | Unitário da consulta. |

### Chatwoot

| ID | Correção | Teste |
|---|---|---|
| CW-1 | `receiveWebhook` ignora o evento, com aviso, quando o Chatwoot da instância está desligado. `clearCacheChatwoot` limpa sempre, não só quando `enabled`. | Unitário + VPS (desligar e mandar mensagem pelo Chatwoot). |
| CW-2 + CW-3 | `getInbox` prefere a caixa cujo `webhook_url` aponta para esta instância (`/chatwoot/webhook/<nome>`). Só sem ela usa o nome, como hoje, com erro no log quando há mais de uma caixa com o mesmo nome. Nos caminhos que enviam ao WhatsApp, se a caixa da instância não for encontrada de jeito nenhum, o envio é bloqueado com erro no log e nota ao atendente. | Unitário (escolha da caixa, bloqueio) + VPS. |
| CW-4 | `updateMessageSourceID` e `getExistingSourceIds` filtram por conta e caixa. | Unitário (SQL gerado). |
| CW-5 (parcial) | Antes de enviar uma mensagem de saída, confere se já existe mensagem desta instância com aquele `chatwootMessageId`. Se existe, não envia de novo. O `runNext` reconfere `isDone`. A reserva atômica fica pendente. | Unitário. |
| CW-6 | Sem `instanceId` resolvido, nenhuma consulta do webhook roda. | Unitário. |
| CW-7 | A conversa em cache só vale se for da caixa da instância. | Unitário. |
| CW-8 | A assinatura usa `body.sender` (quem escreveu a mensagem do evento). | Unitário. |
| CW-9 | `MESSAGE_READ` marca a última mensagem recebida da conversa do evento. | Unitário. |
| CW-10 | `notifyUnsentMessage` não escreve em conversa de outra caixa. | Unitário. |

### Chatbots

As correções são simples, e produção não usa esses chatbots.

| ID | Correção |
|---|---|
| BOT-1 | O cliente OpenAI vira variável local passada como parâmetro; sai o campo `this.client`. |
| BOT-2 | A chave do debounce passa a ser `${instanceId}:${remoteJid}`. |
| BOT-3 | O Typebot passa `{ instanceId }` a `speechToText`, que se recusa a rodar sem `instanceId`. Isso também neutraliza o risco do BOT-8. |
| BOT-4 | O Typebot manda o token da instância, não a chave global, como já fazem os outros bots. |
| BOT-5 | `changeStatus` filtra por `instanceId` nos três ramos, e `getSession` recebe o `instanceId` resolvido. |
| BOT-6 | `fetchBot` confere se o bot é da instância. |

### Canais

| ID | Correção | Teste |
|---|---|---|
| CH-1 | O webhook da Meta passa a cada instância só o próprio entry (`{...data, entry: [entry]}`). | Unitário: payload com dois entries de números diferentes. |
| CH-3 | `updateChatUnreadMessages` filtra por `instanceId`. | Revisão. |
| CH-6 | `contact.updateMany` da Meta filtra por `instanceId`. | Revisão. |
| CH-8 | A chave de dedup de leitura leva o `instanceId`. | Revisão. |
| CH-9 | O `groupMetadataCache` usa a chave `${instanceId}:${groupJid}`. | Revisão. |
| CH-11 | `saveOnWhatsappCache` confere a correspondência exata depois do `contains`, como `saveLidPnMappings` já faz. | Unitário. |

## Fora de escopo (vai para pendências)

- **Mudam comportamento ou configuração:**
  - AUT-3 e AUT-5 (decisão do usuário);
  - autenticação do AUT-6;
  - AUT-7 e AUT-8 (consumidores dependem do formato atual);
  - AUT-9 (passaria a aplicar a lista de IPs liberados que hoje nunca vale);
  - BOT-9 (perde a memória dos fluxos atuais);
  - BOT-10 e BOT-11 (mudam qual bot responde);
  - CW-12 (nomes de instância existentes podem não passar na validação).
- **Exigem desenho maior:**
  - a reserva atômica do CW-5;
  - CW-11, CW-13 e CW-14;
  - CH-2, CH-4 e CH-5;
  - CH-14, CH-16 e CH-17.
- **Baixo risco, não usados em produção:** AUT-10, BOT-7, BOT-8 (exceto a proteção do BOT-3), BOT-12 a BOT-14, CH-7, CH-10, CH-12, CH-13, CH-15 (S3), CH-18 a CH-20.

## Compatibilidade com produção

- **Nenhuma env nova.** Nenhuma reconfiguração de Chatwoot, Meta, webhooks ou instâncias. Nenhuma migration.
- **AUT-1, AUT-2, AUT-11:**
  - só deixa de funcionar o que era acesso indevido: o token de uma instância agindo em outra, ou passando por global;
  - o manager e as integrações usam o nome no path;
  - `fetchInstances` com token de instância continua funcionando.
- **CW-1:** uma instância com o Chatwoot desligado deixa de enviar as mensagens que chegarem do Chatwoot. Esse é o comportamento esperado de "desligado". Se alguma instância de produção estiver desligada no Evolution, mas atendendo pelo Chatwoot, ela para de enviar. Por isso a rc14 registra um aviso no log em cada evento ignorado, e o deploy confere esse aviso.
- **CW-2/CW-3:**
  - a busca nova pela URL do webhook só acrescenta: onde o nome já funcionava, a caixa encontrada é a mesma, a menos que outra caixa aponte para a instância;
  - o bloqueio quando não há caixa nenhuma afeta só instâncias cuja caixa não existe mais. Essas já não recebiam mensagens no Chatwoot.
- **CW-4:** só tem efeito com `CHATWOOT_IMPORT_DATABASE_CONNECTION_URI` configurado. O filtro usa a conta e a caixa da própria instância, então as mensagens dela continuam sendo atualizadas.
- **CW-5:** a conferência pelo `chatwootMessageId` só pula o que já foi enviado.
- **Chatbots e websocket:** não usados em produção.
- **CH-1:**
  - payload com um entry só (o caso normal) fica idêntico;
  - **CH-3, CH-6, CH-8, CH-9:** só restringem à própria instância;
  - **CH-9:** a chave nova do cache de grupo só causa uma busca a mais na primeira vez;
  - **CH-11:** só deixa de juntar números diferentes.
- **Rollback:** voltar para a rc13 ou para a rc14-test2 funciona, porque nada muda no banco ou no Redis. As chaves antigas do cache de grupo expiram sozinhas.

## Verificação

- Testes unitários novos e os existentes; `npm run build` e lint.
- **VPS de teste:**
  - smoke;
  - dedup em 3 rodadas;
  - eco e caixa alheia;
  - áudio da Cloud;
  - cenários novos:
    - AUT-1: `?instanceName=` com o token de outra instância devolve 401 ou age só na própria instância;
    - AUT-2: `?x=/instance/fetchInstances` devolve 401;
    - CW-1: o Chatwoot desligado não envia;
    - CH-1: webhook da Meta com dois entries.
- Report em `docs/superpowers/reports/`, e release note em `docs/superpowers/releases/v2.3.7-sphot-rc14.md`.
