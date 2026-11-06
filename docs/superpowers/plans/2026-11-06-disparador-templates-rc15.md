# Disparador de templates (rc15): plano de implementação

> **Para agentes:** SUB-SKILL OBRIGATÓRIA: superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans. Passos com checkbox (`- [ ]`).

**Objetivo:** o NX-CWDash dispara campanhas de template pela instância Cloud original, sem inundar o n8n, o RabbitMQ e o Chatwoot, com o motivo de cada falha registrado e sem mudar nada para quem não usa as opções novas.

**Arquitetura:** cada decisão vira uma função pura num arquivo pequeno (testável com `npx tsx`, sem config nem Prisma). `whatsapp.business.service.ts`, `meta.controller.ts` e as rotas só chamam essas funções. Colunas novas e anuláveis em `Message` e `MessageUpdate`; índices por SQL na migration.

**Stack:** TypeScript, Express 4, Prisma 6 (Postgres; MySQL com paridade de schema), multer 2, testes em `test/*.test.ts` com `node:assert/strict`.

**Spec:** [docs/superpowers/specs/2026-11-06-disparador-templates-rc15-design.md](../specs/2026-11-06-disparador-templates-rc15-design.md)

## Restrições globais

- Padrão = comportamento atual. Só `CHATWOOT_DISPATCH_CONTEXT_HOURS` é env nova (opcional, padrão 72).
- Migrations só aditivas, nos dois providers (`prisma/postgresql-migrations`, `prisma/mysql-migrations`) e nos três schemas (`postgresql`, `mysql`, `psql_bouncer`).
- **Ajuste em relação à spec (registrado):** em vez de um JSON `Message.dispatch`, usar três colunas anuláveis em `Message`:
  - `dispatchEmitWebhook Boolean?`
  - `dispatchChatwoot Boolean?`
  - `dispatchSyncedAt DateTime?`

  Motivo: a reserva atômica fica um `updateMany` simples e o índice parcial fica direto.
- SQL bruto só com Postgres (o fork já depende disso). Com `DATABASE_PROVIDER=mysql`, o mesmo efeito por consulta Prisma.
- Logs e comentários em português, no estilo do arquivo vizinho. Um commit por tarefa, com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Todo `where` com `instanceId` definido.
- Ao fim de cada tarefa: `npx tsc --noEmit`, `npx eslint <src tocados>` e todos os `test/*.test.ts`.

## Foco da revisão

1. **Envio de template sem as opções novas (n8n de hoje):** a mesma gravação, o mesmo `SEND_MESSAGE`, a mesma sincronização com o Chatwoot e o mesmo `remoteJid` de antes. Teste na Tarefa 3.
2. **Número sem DDI (`44997091885`) com `dispatch`:** o `remoteJid` gravado vem do `wa_id` devolvido pela Meta (`554497091885`). Sem `contacts[0].wa_id` na resposta, fica o número informado. Teste na Tarefa 3.
3. **Lote de status com um id desconhecido antes de um conhecido:** o conhecido é processado. Teste na Tarefa 2 (função do laço) e na VPS (Tarefa 8).
4. **Duas mensagens do mesmo cliente quase juntas logo após o disparo:** o template entra no Chatwoot uma vez só, antes das duas. Teste na Tarefa 4 (mutex e seleção) e na VPS.
5. **Upload por `url` apontando para `http://127.0.0.1`, `169.254.169.254` ou um host que resolve para rede interna:** 400, sem baixar nada. Teste na Tarefa 5.

---

### Tarefa 1: schema, migrations, env e senha do banco fora do log

**Arquivos:**
- Modificar: `prisma/postgresql-schema.prisma`, `prisma/psql_bouncer-schema.prisma`, `prisma/mysql-schema.prisma`, `src/config/env.config.ts` (tipo `Chatwoot` e leitura da env), `Docker/scripts/deploy_database.sh`, `.env.example`
- Criar: `prisma/postgresql-migrations/20261106120000_disparador_rc15/migration.sql` e `prisma/mysql-migrations/20261106120000_disparador_rc15/migration.sql`

**Interfaces:**
- Produz:
  - colunas `Message.dispatchEmitWebhook`, `Message.dispatchChatwoot`, `Message.dispatchSyncedAt` e `MessageUpdate.errors Json?`;
  - `configService.get<Chatwoot>('CHATWOOT').DISPATCH_CONTEXT_HOURS: number` (padrão 72).

- [ ] **Passo 1:** acrescentar as colunas aos três schemas. No MySQL: `Boolean?`, `DateTime? @db.Timestamp` e `Json?`.
- [ ] **Passo 2:** migration do Postgres:
  - `ALTER TABLE "Message" ADD COLUMN ...` (três colunas) e `ALTER TABLE "MessageUpdate" ADD COLUMN "errors" JSONB;`;
  - `CREATE INDEX IF NOT EXISTS "Message_instanceId_keyId_idx" ON "Message" ("instanceId", ("key"->>'id'));`;
  - `CREATE INDEX IF NOT EXISTS "Message_dispatch_pending_idx" ON "Message" ("instanceId", ("key"->>'remoteJid'), "messageTimestamp") WHERE "dispatchChatwoot" = false AND "dispatchSyncedAt" IS NULL;`.
- [ ] **Passo 3:** migration do MySQL com as mesmas colunas, sem os índices de expressão (registrado como decisão: no MySQL as consultas usam o Prisma).
- [ ] **Passo 4:** `deploy_database.sh` deixa de imprimir o `DATABASE_URL` (fica só `Deploying migrations for $DATABASE_PROVIDER`). Acrescentar `CHATWOOT_DISPATCH_CONTEXT_HOURS=72` comentado no `.env.example`.
- [ ] **Passo 5:** `DATABASE_PROVIDER=postgresql npx prisma validate --schema prisma/postgresql-schema.prisma`, o mesmo para `mysql` e `psql_bouncer`, depois `npm run db:generate` e `npx tsc --noEmit`. Esperado: tudo sem erro.
- [ ] **Passo 6:** commit `feat(db): colunas do disparo, erros do status e indices por id do WhatsApp`.

### Tarefa 2: status da Cloud (índice, lote e A2)

**Arquivos:**
- Criar: `src/api/integrations/channel/meta/status-update.ts`
- Modificar: `whatsapp.business.service.ts` (laço `received.statuses` ~888-1014)
- Teste: `test/cloud-status-update.test.ts`

**Interfaces:**
- Produz:
  - `buildStatusUpdate(base: Record<string, any>, item: any): Record<string, any>`: devolve `{ ...base, status, error?, errors?, timestamp?, conversation?, pricing? }`. O `error` mantém o formato atual (`code, title, message, details, href`, do primeiro erro, só em `FAILED`); `errors` é o array da Meta como veio; `timestamp` é número (`Number(item.timestamp)`). Campos ausentes não aparecem.
  - método privado `findMessageByKeyId(keyId: string)`: no Postgres, `$queryRaw` com `"instanceId" = ${this.instanceId} AND "key"->>'id' = ${keyId} LIMIT 1`; no MySQL, o `findFirst` atual.
  - método privado `handleStatusItem(item, received, settings): Promise<void>`: o corpo atual de uma iteração. O laço chama esse método para cada item, com try/catch por item. Os `return` de dentro passam a encerrar só aquele item.

- [ ] **Passo 1: testes que falham** em `test/cloud-status-update.test.ts`:
  - `falhaLevaErrorsCompletoEErrorLegado`: item `{status:'failed', timestamp:'1793540339', errors:[{code:131053,title:'Media upload error',message:'Media upload error',error_data:{details:'Video file has size 97917424 bytes'}}]}`. Esperado: `status:'FAILED'`, `error.code===131053`, `error.details` com o texto, `errors` igual ao array e `timestamp===1793540339`.
  - `entregueLevaConversationEPricing`: item `{status:'delivered', conversation:{id:'c1'}, pricing:{category:'utility'}}`. Esperado: `conversation.id==='c1'`, `pricing.category==='utility'`, sem `error` e sem `errors`.
  - `semCamposOpcionaisNaoInventa`: item `{status:'read'}`. Esperado: `Object.keys` igual a base mais `status`.
- [ ] **Passo 2:** `npx tsx test/cloud-status-update.test.ts`. Esperado: falha (módulo não existe).
- [ ] **Passo 3:** implementar `buildStatusUpdate`. No serviço:
  - extrair `handleStatusItem`;
  - trocar a busca por `findMessageByKeyId`;
  - montar o evento com `buildStatusUpdate`;
  - gravar `errors: item.errors ?? undefined` no `messageUpdate.create`.
- [ ] **Passo 4:** teste passa; `npx tsc --noEmit`; `npx eslint` nos arquivos.
- [ ] **Passo 5:** commit `feat(cloud): status com o motivo completo da falha e busca indexada`.

### Tarefa 3: opções de envio (A5) e número normalizado

**Arquivos:**
- Criar: `src/api/integrations/channel/meta/dispatch-options.ts`
- Modificar: `src/api/dto/sendMessage.dto.ts` (`SendTemplateDto` e `Options`), `src/validate/message.schema.ts` (`templateMessageSchema`), `whatsapp.business.service.ts` (`templateMessage`, `sendMessageWithTyping`, `handleStatusItem`)
- Teste: `test/cloud-dispatch-options.test.ts`

**Interfaces:**
- Consome: `handleStatusItem` (Tarefa 2) e as colunas da Tarefa 1.
- Produz:
  - `type DispatchOptions = { emitWebhook: boolean; chatwoot: boolean }`;
  - `dispatchOptions(data: { emitWebhook?: boolean; chatwoot?: boolean }): DispatchOptions | null`: `null` quando nenhum dos dois vem `false`;
  - `dispatchColumns(opts: DispatchOptions | null)`: `{}` ou `{ dispatchEmitWebhook, dispatchChatwoot }`;
  - `optionsFromRow(row: { dispatchEmitWebhook?: boolean | null; dispatchChatwoot?: boolean | null }): DispatchOptions` (`null` na coluna vale `true`);
  - `resolveRecipientNumber(input: string, metaResponse: any, opts: DispatchOptions | null): string`: com `opts` e `metaResponse.contacts[0].wa_id`, devolve o `wa_id`; senão, o `input`;
  - `Options.dispatch?: DispatchOptions | null`, repassado por `templateMessage`.

- [ ] **Passo 1: testes que falham:**
  - `padraoNaoMudaNada`: `dispatchOptions({})===null`, `dispatchOptions({emitWebhook:true, chatwoot:true})===null`, `dispatchColumns(null)` deep-equal `{}`;
  - `opcoesFalsasSaoGravadas`: `dispatchOptions({chatwoot:false})` deep-equal `{emitWebhook:true, chatwoot:false}`;
  - `linhaAntigaValeComoPadrao`: `optionsFromRow({})` deep-equal `{emitWebhook:true, chatwoot:true}`;
  - `numeroSemDdiUsaWaIdSoComDispatch`: `resolveRecipientNumber('44997091885', {contacts:[{input:'44997091885', wa_id:'554497091885'}]}, {emitWebhook:false, chatwoot:false})==='554497091885'`; o mesmo com `opts=null` devolve `'44997091885'`; sem `contacts`, devolve o `input`.
- [ ] **Passo 2:** rodar o teste. Esperado: falha.
- [ ] **Passo 3:** implementar e aplicar:
  - schema com `emitWebhook: { type: 'boolean' }` e `chatwoot: { type: 'boolean' }`;
  - `templateMessage` passa `dispatch: dispatchOptions(data)`;
  - em `sendMessageWithTyping`:
    - `remoteJid: createJid(resolveRecipientNumber(number, messageSent, options?.dispatch))`;
    - `...dispatchColumns(options?.dispatch)` no `message.create`;
    - `SEND_MESSAGE` só se `options?.dispatch?.emitWebhook !== false`;
    - Chatwoot só se `options?.dispatch?.chatwoot !== false`;
    - os campos de coluna não entram no payload do webhook nem na resposta;
  - em `handleStatusItem`:
    - `const opts = optionsFromRow(findMessage)`;
    - `MESSAGES_UPDATE` só com `opts.emitWebhook`;
    - Chatwoot (update e delete) só com `opts.chatwoot`;
    - o `webhookUrl` sempre.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `feat(cloud): sendTemplate com emitWebhook e chatwoot opcionais`.

### Tarefa 4: template antes da resposta (A5b)

**Arquivos:**
- Criar: `src/utils/keyedMutex.ts`, `src/api/integrations/channel/meta/dispatch-context.ts`
- Modificar: `whatsapp.business.service.ts` (antes do `eventWhatsapp(MESSAGES_UPSERT)`, ~linha 821)
- Teste: `test/cloud-dispatch-context.test.ts`

**Interfaces:**
- Consome: as colunas da Tarefa 1, `optionsFromRow` da Tarefa 3 e `DISPATCH_CONTEXT_HOURS`.
- Produz:
  - `class KeyedMutex { runExclusive<T>(key: string, fn: () => Promise<T>, timeoutMs: number): Promise<T> }`: serializa por chave. Se a vez não chega em `timeoutMs`, roda assim mesmo (nunca trava a mensagem). Remove a chave quando a fila fica vazia.
  - `pickDispatchForSync(rows: Array<{ id: string; messageTimestamp: number; status: string | null }>, nowSec: number, windowHours: number): { sync: string | null; skip: string[] }`:
    - descarta `FAILED` e o que está fora da janela;
    - escolhe o mais recente;
    - os demais elegíveis vão para `skip`.

- [ ] **Passo 1: testes que falham:**
  - `mutexSerializaPorChave`: duas tarefas na mesma chave, com a 1ª esperando 50 ms. A ordem de término é `['a1','a2']`. Chaves diferentes rodam juntas (tempo total < 90 ms).
  - `mutexNaoTravaNoTimeout`: a 1ª tarefa nunca resolve; a 2ª, com `timeoutMs=30`, termina.
  - `escolheOMaisRecenteEPulaOsDemais`: rows `[{id:'v',ts: now-100h}, {id:'f',ts: now-1h,status:'FAILED'}, {id:'a',ts: now-10h,status:'DELIVERED'}, {id:'b',ts: now-2h,status:'READ'}]` com janela de 72. Esperado: `{sync:'b', skip:['a']}`.
  - `nadaElegivel`: `[]` dá `{sync:null, skip:[]}`.
- [ ] **Passo 2:** rodar o teste. Esperado: falha.
- [ ] **Passo 3:** implementar e integrar. Na mensagem recebida (Cloud), com Chatwoot ligado e `!key.fromMe`:
  - dentro de `mutex.runExclusive(`${instanceId}:${remoteJid}`, ..., 15000)`:
    - buscar candidatas (Postgres: `$queryRaw` sobre o índice parcial, `"key"->>'remoteJid' = ${remoteJid}`, `"key"->>'fromMe' = 'true'`; MySQL: Prisma);
    - `pickDispatchForSync`;
    - reservar `sync` com `message.updateMany({ where: { id, dispatchSyncedAt: null }, data: { dispatchSyncedAt: new Date() } })`;
    - se `count === 1`: `chatwootService.eventWhatsapp(Events.SEND_MESSAGE, ..., rawDaLinha)` e gravar `chatwootMessageId`, `chatwootConversationId` e `chatwootInboxId` devolvidos;
    - marcar `skip` com `dispatchSyncedAt`;
    - qualquer erro vai para `logger.error` e segue;
  - depois, o fluxo normal da mensagem recebida;
  - o `rawDaLinha` remonta `{ key, message, messageType, messageTimestamp, instanceId, source }` da linha.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `feat(cloud): template do disparo entra no Chatwoot antes da resposta`.

### Tarefa 5: upload de mídia para a Meta (A4)

**Arquivos:**
- Criar: `src/utils/metaMedia.ts`
- Modificar: `src/api/routes/business.router.ts`, `src/api/controllers/business.controller.ts`, `whatsapp.business.service.ts` (método público `uploadMediaToMeta`, reaproveitando a montagem do `getIdMedia`)
- Teste: `test/meta-media.test.ts`

**Interfaces:**
- Produz:
  - `detectMime(buf: Buffer): string | null`: jpeg (`FF D8 FF`), png (`89 50 4E 47`), mp4 (`ftyp` no byte 4, sem `3g`), 3gpp (`ftyp3g`), pdf (`%PDF`);
  - `META_MEDIA_LIMITS = { 'image/jpeg': 5MB, 'image/png': 5MB, 'video/mp4': 16MB, 'video/3gpp': 16MB, 'application/pdf': 100MB }` (MB = 1024², igual à Meta: 16777216);
  - `metaMediaError(mime: string | null, size: number): string | null`;
  - `isPrivateAddress(ip: string): boolean`: 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 100.64/10, ::1, fc00::/7, fe80::/10, IPv4 mapeado;
  - `assertPublicHttpUrl(url: string): Promise<void>`: só http/https; resolve todos os IPs (`dns.lookup all`); lança se algum for privado;
  - `downloadLimited(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer>`: stream que aborta ao passar de `maxBytes`, com `maxRedirects: 3` e checagem do host a cada redirect;
  - rota `POST /business/uploadMedia/:instanceName` (multer `memoryStorage`, `limits.fileSize = 100*1024*1024`), respondendo `{ id, mimeType, size }`; integração diferente de `WHATSAPP-BUSINESS` recebe 400.

- [ ] **Passo 1: testes que falham:**
  - `detectaTipos`: buffers mínimos de cada assinatura e um texto qualquer dão `null`;
  - `limitesDaMeta`: `metaMediaError('video/mp4', 16777216)===null`, `('video/mp4', 16777217)` contém `16`, `(null, 10)` contém `tipo`;
  - `redesInternas`: `isPrivateAddress` é verdadeiro para `127.0.0.1`, `169.254.169.254`, `10.1.2.3`, `172.20.0.1`, `192.168.0.10`, `::1` e `::ffff:10.0.0.1`, e falso para `8.8.8.8` e `2001:4860:4860::8888`;
  - `urlInternaRecusada`: `assertPublicHttpUrl('http://127.0.0.1/x')` e `('ftp://exemplo.com/a')` rejeitam.
- [ ] **Passo 2:** rodar o teste. Esperado: falha.
- [ ] **Passo 3:** implementar, com o fluxo:
  1. arquivo (`req.file`) ou `url` (`assertPublicHttpUrl` e depois `downloadLimited`);
  2. `detectMime`;
  3. `metaMediaError`; se houver erro, 400;
  4. upload à Meta;
  5. erro da Meta repassado com `code`, `title`, `message`, `error_data` e `fbtrace_id`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `feat(cloud): rota de upload de midia para a Meta com validacao`.

### Tarefa 6: webhook da Meta com número duplicado (A8)

**Arquivos:**
- Criar: `src/api/integrations/channel/meta/instance-routing.ts`
- Modificar: `src/api/integrations/channel/meta/meta.controller.ts`
- Teste: `test/meta-instance-routing.test.ts`

**Interfaces:**
- Produz:
  - `pickPrimaryInstance<T extends { id: string; createdAt: Date | null }>(candidates: T[]): T | null`: a mais antiga, com `createdAt` nulo antes de todas e desempate por `id`;
  - `shouldWarnDuplicate(number: string, nowMs: number, lastWarned: Map<string, number>): boolean`: no máximo uma vez a cada 10 min por número.

- [ ] **Passo 1: testes que falham:**
  - `maisAntigaVence`: candidatas `[{id:'b',createdAt:2026-10-01}, {id:'a',createdAt:2026-01-01}]` dão `'a'`;
  - `createdAtNuloEhMaisAntigo`;
  - `empateNoCreatedAtPeloId`;
  - `listaVaziaNull`;
  - `avisoNoMaximoACada10Min`: a 1ª chamada é verdadeira; outra 5 min depois é falsa; outra 11 min depois é verdadeira.
- [ ] **Passo 2:** rodar o teste. Esperado: falha.
- [ ] **Passo 3:** no controller, para cada entry:
  - `findMany({ where: { number, integration: 'WHATSAPP-BUSINESS' } })`;
  - se o change tem `statuses` e há mais de uma candidata, a dona é a que tem a mensagem `statuses[0].id` (consulta por `instanceId` + key id, igual à Tarefa 2);
  - senão, `pickPrimaryInstance`;
  - aviso de duplicidade via `shouldWarnDuplicate`.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(meta): numero duplicado roteia status para a dona e o resto para a mais antiga`.

### Tarefa 7: mídia enviada por link e Chatwoot

**Arquivos:**
- Modificar: `whatsapp.business.service.ts` (`downloadMediaMessage`, ~238)
- Teste: `test/meta-media.test.ts` (acrescentar)

**Interfaces:**
- Consome: `downloadLimited` (Tarefa 5).
- Produz: `isHttpUrl(value: unknown): boolean` em `src/utils/metaMedia.ts`.

- [ ] **Passo 1: teste que falha:** `linkNaoEhIdDaMeta`. `isHttpUrl('https://www.w3.org/Icons/w3c_home.png')===true`, `isHttpUrl('1338946308215377')===false`, `isHttpUrl(undefined)===false`.
- [ ] **Passo 2:** rodar o teste. Esperado: falha.
- [ ] **Passo 3:** em `downloadMediaMessage`, se `isHttpUrl(id)`, devolver `downloadLimited(id, 100*1024*1024, 60000)`, com as mesmas tentativas. Senão, o fluxo da Graph de hoje.
- [ ] **Passo 4:** teste, tsc, eslint.
- [ ] **Passo 5:** commit `fix(cloud): midia enviada por link e baixada do proprio link para o Chatwoot`.

### Tarefa 8: verificação, report e release

- [ ] **Passo 1:** todos os `test/*.test.ts` e `npm run build`.
- [ ] **Passo 2:** imagem `sphott/evolution-api:v2.3.7-sphot-rc15-test1`, só amd64. Recriar o builder `multiarch`.
- [ ] **Passo 3:** na VPS, antes do deploy:
  - criar o índice com `CREATE INDEX CONCURRENTLY IF NOT EXISTS` pelo postgres da VPS;
  - testar se o `prisma migrate deploy` passa (a migration encontra o índice e vira no-op);
  - registrar o resultado. Se a migration aceitar `CONCURRENTLY` sozinha num arquivo, decidir se vale trocar.
- [ ] **Passo 4:** deploy e VPS, com o template `teste_disparo_rc15` aprovado:
  - envio com `emitWebhook:false, chatwoot:false`: não aparece no webhook da instância nem no Chatwoot, mas o `webhookUrl` recebe sent, delivered e read;
  - resposta da DEMO-1 (texto e o botão "Quero saber mais"): o template entra antes, uma vez só, e a citação do botão funciona;
  - duas respostas rápidas;
  - número inválido: `errors[0].code` no evento e em `MessageUpdate.errors`;
  - número sem o 55 grava o `remoteJid` com o 55;
  - lote de status forjado (id desconhecido e depois conhecido);
  - instância duplicada com o mesmo número: status para a dona e resposta para a original;
  - upload de MP4 de 15 MB devolve id; de 17 MB, 400; `url` para `127.0.0.1`, 400; com o template de vídeo (se existir), o envio com `{id}` chega;
  - imagem por link pela Cloud aparece no Chatwoot com anexo;
  - `EXPLAIN` da busca por key id usando o índice;
  - smoke, dedup 3×, eco e caixa alheia.
- [ ] **Passo 5:** report, release note (com o passo do índice antes da troca de imagem) e `pendencias.md`. Commit `docs: report e release da rc15`.
