# Spec: disparador de templates pela Evolution (rc15)

Base: [research de 06/11](../research/2026-11-06-disparador-templates-cloud.md), pedido do NX-CWDash ([07-evolution-ajustes-disparador.md](../../../../NX-CWDash/docs/07-evolution-ajustes-disparador.md)). Os IDs (A2, A5...) são os do pedido.

## Objetivo

O NX-CWDash dispara campanhas de templates (de 10 a 20 mil contatos, com picos de 200 mil) pela **instância Cloud original**, sem inundar o n8n nem o Chatwoot, sem instância duplicada e com o motivo de cada falha registrado. Tudo o que já usa a Evolution hoje continua igual.

## Decisões (06/11)

- Duas fases. Esta spec cobre a **rc15**. A1, A3, A6 (`strictErrors`, como opção) e A7 ficam para a rc16.
- A5b: o atendente vê o rótulo `▶️nome_do_template◀️`.
- Produção não define `WA_BUSINESS_VERSION` (vale a v18.0 do código). A versão não muda na rc15.
- Campanha em massa sempre com `chatwoot:false` e `emitWebhook:false`, aplicado pelo NX-CWDash. O padrão da Evolution continua `true`.

## Escopo

### 1. Índice da mensagem pelo id do WhatsApp
- Índice `Message ("instanceId", ("key"->>'id'))` no Postgres. No MySQL, índice funcional equivalente (MySQL 8.0.13 ou mais novo).
- A busca da mensagem a cada status da Cloud passa a usar SQL com a mesma expressão do índice.
- **Criar o índice antes da troca de imagem**, com `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, como passo do release. A migration usa `IF NOT EXISTS`. Na VPS, testar se o `prisma migrate deploy` aceita um arquivo só com `CONCURRENTLY`. Se aceitar, o passo manual vira opcional.

### 2. Lote de status
- No laço de `received.statuses`, "mensagem não encontrada", "grupo ignorado" e "deleted" passam a usar `continue` em vez de `return`, para não descartar os status seguintes do mesmo POST.

### 3. A2: motivo da falha
- O payload de status (`MESSAGES_UPDATE` e `webhookUrl` da mensagem) ganha:
  - `errors`: o array da Meta, como veio;
  - `timestamp`;
  - `conversation` e `pricing`, quando vierem.
- O `error` atual continua igual.
- Coluna nova `MessageUpdate.errors Json?` (Postgres e MySQL), gravada com o mesmo `errors`.

### 4. A5: opções de envio
- `SendTemplateDto` e `templateMessageSchema` ganham `emitWebhook?: boolean` e `chatwoot?: boolean`, com padrão `true`.
- Coluna nova `Message.dispatch Json?`. Só é preenchida quando alguma das opções vem `false`: `{ emitWebhook, chatwoot, chatwootSyncedAt: null }`.
- **No envio:**
  - `emitWebhook:false` não emite `SEND_MESSAGE`, em nenhum evento: webhook, RabbitMQ e demais;
  - `chatwoot:false` não chama `chatwootService.eventWhatsapp`.
- **Nos status dessa mensagem:**
  - `emitWebhook:false` não emite `MESSAGES_UPDATE`;
  - `chatwoot:false` não chama o Chatwoot;
  - o `webhookUrl` da mensagem recebe sempre.
- **Número normalizado:** quando há `dispatch`, o `remoteJid` gravado vem do `contacts[0].wa_id` devolvido pela Meta. Se não vier, usa o número informado, como hoje. Envios sem `dispatch` não mudam.

### 5. A5b: template antes da resposta
- Ao receber uma mensagem (Cloud), antes de mandá-la ao Chatwoot, a Evolution procura a mensagem enviada mais recente para o mesmo `remoteJid` que atenda a todas as condições abaixo:
  - tem `dispatch.chatwoot = false`;
  - `chatwootSyncedAt` é nulo;
  - o status não é `FAILED`;
  - está dentro da janela.
- A janela é a env **opcional** `CHATWOOT_DISPATCH_CONTEXT_HOURS`, com padrão 72.
- **Reserva atômica:** `updateMany` que só marca `chatwootSyncedAt` se ainda estiver nulo. Só sincroniza quem afetar a linha.
- **Sincroniza** com `eventWhatsapp(SEND_MESSAGE)` (o rótulo `▶️nome◀️`) e grava `chatwootMessageId`, `chatwootConversationId` e `chatwootInboxId` na linha do disparo. Assim a citação de uma resposta por botão funciona.
- Os disparos mais antigos e ainda não sincronizados do mesmo contato são marcados como tratados, sem sincronizar.
- **Ordem:** enquanto a sincronização de um contato está em andamento, as próximas mensagens dele esperam ela terminar (espera em memória por `instância:remoteJid`, com tempo limite). Só depois vão ao Chatwoot.
- Índice parcial para essa busca, só das linhas com `dispatch` (Postgres). No MySQL, índice composto comum.
- Se a sincronização falhar, a resposta do cliente vai ao Chatwoot assim mesmo, com erro no log. A resposta nunca se perde.

### 6. A4: upload de mídia
- Rota `POST /business/uploadMedia/{instance}`, só para `WHATSAPP-BUSINESS` (as outras integrações recebem 400).
- Aceita `multipart` com `file`, ou JSON com `url`.
- Devolve `{ id, mimeType, size }`.
- **Validações:**
  - tipo identificado pelo conteúdo (assinatura), não só pelo informado;
  - imagem JPEG/PNG até 5 MB, vídeo MP4/3GPP até 16 MB, documento até 100 MB;
  - fora disso, responde 400 com o motivo.
- **Limites:**
  - `multer` com `limits.fileSize` de 100 MB na rota;
  - no modo `url`: só `http`/`https`, download em stream que **para ao passar do máximo**, tempo limite de 60 s, e nada de endereços de rede interna (localhost, faixas privadas, metadados de nuvem).
- Erro da Meta repassado com `code`, `title`, `message`, `error_data` e `fbtrace_id`.

### 7. A8: número duplicado no webhook da Meta
- Busca por `findMany`, filtrando `number` e `integration = WHATSAPP-BUSINESS`.
- **Status:** vão para a instância **dona da mensagem** (a que tem o `wamid`, entre as candidatas). Se nenhuma tiver, vão para a principal.
- **Mensagens recebidas e o resto:** vão para a principal, que é a mais antiga por `createdAt` (com desempate por `id`).
- Com mais de uma candidata, registra um aviso no log com os nomes, no máximo 1 vez a cada 10 min por número.
- Recusar número duplicado no `instance/create` **fica fora**: quebraria o fluxo atual de instância de disparo.

### 8. Senha do banco no log do start
- `Docker/scripts/deploy_database.sh` deixa de imprimir o `DATABASE_URL`. Imprime só o provider.

## Fora de escopo (rc16 ou pendências)

- A1 (paginação de templates, junto com a refatoração do `TemplateService`).
- A3 (saúde do número, exige Graph v24 ou mais nova).
- A6 (`strictErrors`: 400 para erro permanente, 429 para limite de vazão, 502/503 para Meta indisponível).
- A7 (versão da Graph).
- Keep-alive no `post()` da Graph (achado 4 do research).
- Recusar número duplicado na criação de instância.

## Compatibilidade com produção

- **Env nova:** só `CHATWOOT_DISPATCH_CONTEXT_HOURS`, opcional (padrão 72), que só tem efeito em mensagens com `dispatch`.
- **Migrations aditivas:**
  - `Message.dispatch Json?` e `MessageUpdate.errors Json?`, anuláveis;
  - dois índices;
  - o rollback para a rc14 funciona, porque a imagem antiga ignora as colunas novas.
- **Índice:** criado antes da troca de imagem para não travar a tabela (ver item 1).
- **Quem não manda as opções novas** (n8n, sistema de agente):
  - envio, eventos e Chatwoot iguais;
  - `MESSAGES_UPDATE` ganha campos novos, e o `error` atual continua;
  - status que hoje se perdiam num lote passam a ser entregues.
- **Instância duplicada ("Disparo em Massa"):** continua funcionando.
  - Os status voltam para a instância que enviou.
  - As respostas dos clientes passam a ir para a original, a mais antiga, que tem Chatwoot. Era o comportamento esperado; hoje, sem ordem definida, iam para qualquer uma.
- **A5b:** só age em mensagens com `dispatch`. Nas demais, nada muda.
- **Graph API:** a versão não muda.

## Verificação

- **Unitários (funções puras):**
  - escolha da instância (A8);
  - montagem do payload de status (A2);
  - aplicação das opções (A5);
  - reserva e seleção do A5b;
  - validação de tipo e tamanho e bloqueio de rede interna (A4);
  - SQL do índice.
- **VPS de teste**, com NexaAI-Cloud e Chatwoot v4:
  - template com `emitWebhook:false, chatwoot:false`: não aparece no webhook da instância nem no Chatwoot, mas o `webhookUrl` recebe sent, delivered e read;
  - a resposta do cliente traz o template antes dela no Chatwoot;
  - duas respostas rápidas chegam em ordem e sem duplicar;
  - o template que falhou não é sincronizado;
  - envio para número inválido: `MESSAGES_UPDATE` com `errors[0].code` e a linha de `MessageUpdate` com `errors`;
  - upload de MP4 de 15 MB devolve o id, o template com vídeo `{id}` chega no celular, e um arquivo de 17 MB volta 400;
  - instância duplicada com o mesmo número: os status vão para a dona e as respostas para a original;
  - índice criado com `CONCURRENTLY` e plano de consulta (`EXPLAIN`) usando o índice;
  - smoke, dedup em 3 rodadas, eco e caixa alheia, como na rc14.
- Report e release note, com o passo do índice antes da troca.
