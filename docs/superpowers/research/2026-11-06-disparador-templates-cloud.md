# Disparador de templates pela Evolution (pedido do NX-CWDash)

Data: 06/11/2026. Base: branch `v2.3.7-sphot-rc14` @ 6e240df0. Pedido: [NX-CWDash/docs/07-evolution-ajustes-disparador.md](../../../../NX-CWDash/docs/07-evolution-ajustes-disparador.md). A escala prevista é de 10 a 20 mil contatos por campanha, com picos de 200 mil, sempre por instâncias `WHATSAPP-BUSINESS`.

Abaixo, para cada item do pedido: o que o código faz hoje (conferido), o que muda e os riscos.

## Achados que não estavam no pedido e pesam na escala

1. **A busca da mensagem a cada status não tem índice.** Toda notificação de status da Meta (enviado, entregue, lido, falhou) chama `message.findFirst({ instanceId, key.id })` (`whatsapp.business.service.ts:902`). A tabela `Message` só tem índice em `instanceId`, então cada status varre as mensagens da instância inteira. Um disparo de 200 mil gera cerca de 600 a 800 mil notificações, e cada uma faz essa varredura numa tabela que cresce com o próprio disparo. Este é o maior gargalo e precisa de um índice de expressão em `key->>'id'`, por instância.
   - O índice entra numa migração aditiva, nos dois bancos.
   - No Postgres, ele precisa ser criado sem travar a tabela (`CONCURRENTLY`), e é preciso conferir se o `prisma migrate deploy` aceita isso fora de transação.
   - Também é preciso conferir que o SQL gerado pelo Prisma para `path: ['id']` usa a mesma expressão do índice. Se não usar, a busca passa a ser SQL próprio.
2. **Um status desconhecido descarta os demais do mesmo lote.** No laço de `received.statuses`, os casos "mensagem não encontrada", "grupo ignorado" e "deleted" usam `return` (linhas 899, 913 e 949), e isso encerra o laço inteiro. Quando a Meta agrupa status num POST, os que vêm depois se perdem. O certo é `continue`.
3. **`TemplateService` guarda estado da chamada no objeto compartilhado** (CH-12 das pendências): `this.businessId` e `this.token` ficam num serviço que é um só para todas as instâncias. Hoje é seguro só porque não há `await` entre gravar e usar. A paginação do A1 coloca `await` no meio e traria de volta o bug do incidente de 26/10: a lista de templates de uma conta sairia com o token de outra. É pré-requisito do A1 passar esses valores como parâmetro.
4. **O `post()` à Graph API abre uma conexão nova a cada envio** (axios sem agente keep-alive). Em 20 envios por segundo ainda funciona, mas um agente HTTPS com keep-alive economiza o handshake TLS de cada mensagem.

## Itens do pedido

### A1 · Templates com paginação
- **Hoje:** `TemplateService.find` faz um único `GET /{businessId}/message_templates` e devolve só a primeira página. A descrição do pedido confere.
- **Fazer:**
  - pedir os campos e `limit=100`, seguir `paging.next` até no máximo 20 páginas e aceitar os filtros `status`, `name` e `language`;
  - manter o formato `{ data }`;
  - antes disso, refatorar o achado 3.
- **Risco:** baixo, porque só muda o resultado de uma consulta.

### A2 · Motivo da falha nos status
- **Hoje:** a descrição do pedido está **desatualizada em parte**.
  - Desde a rc anterior, quando a mensagem falha, o primeiro erro já vai como `message.error = { code, title, message, details, href }` (linhas 965 a 978), tanto no `MESSAGES_UPDATE` quanto no `webhookUrl`.
  - Falta o array `errors` completo, como a Meta mandou.
  - Faltam `timestamp`, `conversation` e `pricing`.
  - A linha gravada em `MessageUpdate` não guarda nada do erro, porque a tabela não tem coluna para isso.
- **Fazer:**
  - acrescentar `errors`, `timestamp`, `conversation` e `pricing` ao payload, mantendo o `error` atual para não quebrar quem já lê esse campo;
  - criar a coluna `MessageUpdate.errors Json?` nos dois schemas;
  - corrigir o achado 2.
- **Dúvida 3 do pedido:** `MessageUpdate` só é lido em `fetchStatusMessage` (`channel.service.ts:708`) e apagado quando a instância é removida (`monitor.service.ts:209`). Não há rotina de limpeza nem de exportação. Uma coluna anulável não atrasa nada.

### A3 · Saúde do número
- **Hoje:** não existe rota para isso.
- **Fazer:** criar `GET /business/numberInfo/{instance}`, só para `WHATSAPP-BUSINESS` (Baileys responde 400).
  - Pedir os campos `display_phone_number`, `verified_name`, `quality_rating`, `throughput`, `name_status` e `whatsapp_business_manager_messaging_limit`.
- **Dúvida 2 do pedido:** pela documentação atual da Meta, o campo `messaging_limit_tier` está descontinuado.
  - O substituto é `whatsapp_business_manager_messaging_limit`, disponível a partir da **v24.0**.
  - Ele pode ser pedido no próprio número e devolve o limite do portfólio (por exemplo `TIER_250`).
  - É preciso converter para número: 250, 2000, 10000, 100000, e `-1` para ilimitado.
- **Depende do A7:** com uma versão da Graph anterior à v24, esse campo não existe.

### A4 · Upload de mídia para a Meta
- **Hoje:** já existe `getIdMedia` (privado, linha 1393), que faz `POST /{phone_number_id}/media`, mas ele só é usado nos envios de mídia comuns.
- **Fazer:** criar `POST /business/uploadMedia/{instance}`, aceitando `multipart` com `file` ou JSON com `url`.
  - Validar tipo e tamanho antes de mandar à Meta: imagem até 5 MB, vídeo até 16 MB, documento até 100 MB.
  - Devolver `{ id, mimeType, size }`, reaproveitando o `getIdMedia`.
- **Risco: o modo `url` faz a Evolution baixar o endereço que o cliente informa (SSRF).**
  - O download precisa aceitar só `http`/`https`.
  - Precisa ter tempo limite.
  - Precisa abortar quando passar do tamanho máximo, em vez de baixar tudo para a memória como o `getIdMedia` faz hoje.

### A5 · Opções de envio para disparo em massa
- **Hoje:** confere com o pedido.
  - Todo envio emite `SEND_MESSAGE` em todos os eventos da instância: webhook, **RabbitMQ** e os demais.
  - Todo envio chama `chatwootService.eventWhatsapp(SEND_MESSAGE)`, que cria contato e conversa.
  - Cada status emite `MESSAGES_UPDATE` e também chama o Chatwoot.
- **Fazer:**
  - acrescentar `emitWebhook` e `chatwoot` em `SendTemplateDto` e `templateMessageSchema`, com padrão `true`;
  - no envio, aplicar as duas opções;
  - nos status, ler as opções gravadas na mensagem;
  - o `webhookUrl` da mensagem continua recebendo os status em todos os casos.
- **Dúvida 1 do pedido (onde guardar):** a recomendação é uma coluna nova e anulável `Message.dispatch Json?`, no formato `{ emitWebhook, chatwoot, chatwootSyncedAt }`.
  - É aditiva e só fica preenchida nos envios que usam as opções. Os demais seguem com `null`, ou seja, o comportamento de hoje.
  - Reaproveitar `source` ou `contextInfo` mistura significados e complica as consultas.

### A5b · Contexto do template quando o cliente responde
- **Hoje:** a mensagem recebida vai direto para `eventWhatsapp(MESSAGES_UPSERT)` (linha 821).
- **Fazer:**
  - antes disso, procurar a última mensagem enviada a esse contato com `dispatch.chatwoot = false`, ainda não sincronizada, dentro de N horas (env opcional, padrão 72);
  - **reservar de forma atômica** (`updateMany` com a condição "não sincronizada", seguindo só se afetar uma linha), para duas respostas seguidas não duplicarem a mensagem;
  - sincronizar a mensagem do disparo e só depois a resposta do cliente.
- **Escala:** essa busca roda a cada mensagem recebida, então precisa de índice para não varrer a tabela. Pode ser um índice parcial só das linhas com `dispatch`.
- **Decidir:** o que aparece para o atendente. Pode ser o rótulo `▶️nome◀️`, como hoje, ou o texto do template com as variáveis preenchidas, que exige ter o corpo do template (vem do A1).

### A8 · Número duplicado no webhook da Meta
- **Hoje:** é o CH-2 das pendências. Confere com o pedido: `findFirst({ number })` sem ordem.
- **Fazer:**
  - buscar com `findMany` filtrando `integration = WHATSAPP-BUSINESS`;
  - quando houver mais de uma, registrar um aviso com os nomes e usar a mais antiga por `createdAt` (o campo existe e pode ser nulo em linhas antigas: desempatar por `id`);
  - opcionalmente, recusar `number` repetido em `instance/create`, a não ser com `allowDuplicateNumber: true`.
- O A5 elimina a causa: a instância duplicada de disparo deixa de existir.

### A6 · Erro síncrono do envio
- **Hoje:** confere. O `post()` devolve `e.response.data.error`, e o `sendMessageWithTyping` devolve isso com HTTP 201.
- **Fazer, se aprovado:** criar `strictErrors: true`, opcional, que responde 400 com o erro da Meta (`code`, `title`, `message`, `error_data`, `fbtrace_id`). Sem a opção, nada muda.

### A7 · Versão da Graph API
- O padrão no código é `v18.0` (`env.config.ts:730`), e o `.env.example` traz `v20.0`.
- Pelo changelog da Meta, a versão mais recente é a **v26.0** (julho de 2026). A **v25.0** fica disponível até julho de 2028.
- O A3 exige **v24.0 ou mais nova**.
- **Fazer:**
  - descobrir qual `WA_BUSINESS_VERSION` está em produção (é uma pergunta para o usuário);
  - na VPS de teste, testar template com mídia, carrossel e botões na v25.0;
  - atualizar o padrão do código.
- Mudar o padrão só afeta quem não define a variável. Em produção, a troca é decidida pela env.

## Dúvidas do pedido, respondidas

| # | Resposta |
|---|---|
| 1 | Na coluna anulável `Message.dispatch Json?`, numa migração aditiva. |
| 2 | `whatsapp_business_manager_messaging_limit`, a partir da v24.0. |
| 3 | Não. `MessageUpdate` não tem rotina de limpeza nem de exportação. |
| 4 | A Evolution não tem limite de taxa interno, e o Traefik não limita por padrão. O que segura é: o throughput do número na Meta (80 mensagens por segundo no padrão), a busca sem índice a cada status (achado 1) e uma conexão nova por envio (achado 4). Com o índice e o keep-alive, 20 por segundo por instância é tranquilo. |
| 5 | Sairia na `v2.3.7-sphot-rc15`. O NX-CWDash pode conferir pela tag da imagem, ou por um campo de versão do fork no `GET /`. |

## Fontes

- [Messaging limits (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits)
- [WhatsApp changelog (Meta)](https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog)
- [Graph API changelog (Meta)](https://developers.facebook.com/docs/graph-api/changelog?locale=pt_BR)
- [Media (Meta)](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/media)
