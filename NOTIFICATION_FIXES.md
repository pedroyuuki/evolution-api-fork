# Evolution API - Correções de Notificações e Multi-Device

> **Versão Base**: v2.3.7  
> **Data**: Janeiro 2026  
> **Issues Relacionados**: #1734, #512, #2270, #2061

## 📋 Sumário Executivo

Este documento descreve três correções críticas implementadas para resolver bugs intermitentes que causavam perda de notificações em dispositivos móveis quando conectados à Evolution API. As correções abordam problemas fundamentais na arquitetura de sincronização de mensagens e no suporte ao WhatsApp Multi-Device.

### Problemas Resolvidos

1. **Multi-Device Disconnect**: Conflitos de sessão quando WhatsApp Android está ativo
2. **Race Condition**: Settings carregadas após início do processamento de mensagens
3. **Auto-Read Status**: Mensagens marcadas como lidas no banco independente de configuração

### Impacto

- ✅ Celulares voltam a receber notificações normalmente
- ✅ Suporte nativo ao WhatsApp Multi-Device sem conflitos
- ✅ Respeito às configurações `readMessages` e `alwaysOnline`
- ✅ Eliminação de race conditions no carregamento de configurações

---

## 🔧 Correção #1: Multi-Device Fix (PR #2332)

### Problema Identificado

**Sintoma**: Instâncias desconectavam automaticamente quando o WhatsApp Android estava ativo, exigindo reconexão via QR Code.

**Causa Raiz**: Evolution API identificava-se como navegador (Chrome) através de `WABrowserDescription`, fazendo o WhatsApp tratá-la como "WhatsApp Web" ao invés de usar o modo Multi-Device nativo do Baileys 7.x.

**Comportamento Observado**:
- WhatsApp detectava conflito entre "WhatsApp Web" (API) e WhatsApp Android
- Forçava desconexão da API para manter Android ativo
- Usuário precisava reconectar via QR Code frequentemente

### Solução Implementada

Remover completamente a identificação de navegador, permitindo que o Baileys use seu modo Multi-Device nativo.

#### Arquivos Modificados

**`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`**

#### Mudanças no Código

##### 1. Remoção de Imports Desnecessários

```typescript
// ❌ ANTES
import {
  AudioConverter,
  CacheConf,
  Chatwoot,
  ConfigService,
  configService,
  ConfigSessionPhone,  // ← Removido
  Database,
  Log,
  Openai,
  ProviderSession,
  QrCode,
  S3,
} from '@config/env.config';
import makeWASocket, {
  // ...
  UserFacingSocketConfig,
  WABrowserDescription,  // ← Removido
  WAMediaUpload,
  // ...
} from 'baileys';
import { release } from 'os';  // ← Removido

// ✅ DEPOIS
import {
  AudioConverter,
  CacheConf,
  Chatwoot,
  ConfigService,
  configService,
  Database,
  Log,
  Openai,
  ProviderSession,
  QrCode,
  S3,
} from '@config/env.config';
import makeWASocket, {
  // ...
  UserFacingSocketConfig,
  WAMediaUpload,
  // ...
} from 'baileys';
import { join } from 'path';
```

##### 2. Refatoração do Método `createClient()`

```typescript
// ❌ ANTES (linhas ~573-592)
private async createClient(number?: string): Promise<WASocket> {
  this.instance.authState = await this.defineAuthState();

  const session = this.configService.get<ConfigSessionPhone>('CONFIG_SESSION_PHONE');

  let browserOptions = {};

  if (number || this.phoneNumber) {
    this.phoneNumber = number;
    this.logger.info(`Phone number: ${number}`);
  } else {
    const browser: WABrowserDescription = [session.CLIENT, session.NAME, release()];
    browserOptions = { browser };
    this.logger.info(`Browser: ${browser}`);
  }

  // ... resto do código
}

// ✅ DEPOIS
private async createClient(number?: string): Promise<WASocket> {
  this.instance.authState = await this.defineAuthState();

  if (number || this.phoneNumber) {
    this.phoneNumber = number;
    this.logger.info(`Phone number: ${number}`);
  }

  // Multi-Device mode: não definimos browser para evitar ser tratado como WebClient
  // Isso faz o Baileys usar o modo MD nativo, que não conflita com outras sessões
  this.logger.info('Using Multi-Device native mode (no browser identification)');

  // ... resto do código
}
```

##### 3. Atualização do `socketConfig`

```typescript
// ❌ ANTES (linha ~650)
const socketConfig: UserFacingSocketConfig = {
  // ...
  getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
  ...browserOptions,  // ← Removido
  markOnlineOnConnect: this.localSettings.alwaysOnline,
  // ...
};

// ✅ DEPOIS
const socketConfig: UserFacingSocketConfig = {
  // ...
  getMessage: async (key) => (await this.getMessage(key)) as Promise<proto.IMessage>,
  markOnlineOnConnect: this.localSettings.alwaysOnline,
  // ...
};
```

### Resultado

- ✅ Sessões permanecem conectadas mesmo com WhatsApp Android ativo
- ✅ Modo Multi-Device nativo funciona corretamente
- ✅ Sem necessidade de reconexão frequente via QR Code
- ✅ Compatível com Baileys 7.x

---

## 🔧 Correção #2: Race Condition e Valores Padrão

### Problema Identificado

**Sintoma**: Mesmo com `readMessages: false` e `alwaysOnline: false`, algumas instâncias específicas paravam de receber notificações.

**Causa Raiz**: Race condition crítica onde mensagens eram processadas **antes** das configurações serem carregadas do banco de dados.

**Fluxo do Bug**:
1. `connectToWhatsapp()` chamava `loadSettings()` **sem await**
2. Socket WhatsApp era criado imediatamente
3. Mensagens começavam a chegar
4. Handler `messages.upsert` executava com `localSettings` ainda `undefined`
5. Comportamento imprevisível (às vezes marcava como lida, às vezes não)

### Análise de Código

```typescript
// ❌ CÓDIGO PROBLEMÁTICO
public async connectToWhatsapp(number?: string): Promise<WASocket> {
  try {
    this.loadChatwoot();      // SEM await
    this.loadSettings();       // SEM await - RACE CONDITION!
    this.loadWebhook();        // SEM await
    this.loadProxy();          // SEM await
    return await this.createClient(number);
  } catch (error) {
    this.logger.error(error);
    throw new InternalServerErrorException(error?.toString());
  }
}
```

**Problema adicional**: Se o registro de settings não existisse no banco, `localSettings` ficava com valores `undefined`:

```typescript
// ❌ CÓDIGO PROBLEMÁTICO
public async loadSettings() {
  const data = await this.prismaRepository.setting.findUnique({
    where: { instanceId: this.instanceId }
  });

  this.localSettings.readMessages = data?.readMessages;  // undefined se data for null
  this.localSettings.alwaysOnline = data?.alwaysOnline;  // undefined se data for null
}
```

### Solução Implementada

#### Arquivos Modificados

1. **`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`**
2. **`src/api/services/channel.service.ts`**

#### Mudanças no Código

##### 1. Corrigir Race Condition em `connectToWhatsapp()`

**Arquivo**: `whatsapp.baileys.service.ts` (linhas 714-736)

```typescript
// ✅ CORREÇÃO
public async connectToWhatsapp(number?: string): Promise<WASocket> {
  try {
    this.logger.info(`Connecting instance ${this.instanceName}...`);

    await this.loadChatwoot();
    await this.loadSettings();

    // Log de verificação pós-carregamento
    this.logger.info(
      `Instance ${this.instanceName} settings loaded: ` +
        `readMessages=${this.localSettings.readMessages}, ` +
        `alwaysOnline=${this.localSettings.alwaysOnline}`,
    );

    await this.loadWebhook();
    await this.loadProxy();

    // Remontar o messageProcessor para garantir que está funcionando após reconexão
    this.messageProcessor.mount({
      onMessageReceive: this.messageHandle['messages.upsert'].bind(this),
    });

    return await this.createClient(number);
  } catch (error) {
    this.logger.error(error);
    throw new InternalServerErrorException(error?.toString());
  }
}
```

**Mudanças**:
- ✅ Adiciona `await` em todas as funções de carregamento
- ✅ Adiciona log de verificação após carregamento
- ✅ Garante que settings estão prontas antes de criar socket

##### 2. Implementar Valores Padrão Seguros em `loadSettings()`

**Arquivo**: `channel.service.ts` (linhas 142-165)

```typescript
// ❌ ANTES
public async loadSettings() {
  const data = await this.prismaRepository.setting.findUnique({
    where: {
      instanceId: this.instanceId,
    },
  });

  this.localSettings.rejectCall = data?.rejectCall;
  this.localSettings.msgCall = data?.msgCall;
  this.localSettings.groupsIgnore = data?.groupsIgnore;
  this.localSettings.alwaysOnline = data?.alwaysOnline;
  this.localSettings.readMessages = data?.readMessages;
  this.localSettings.readStatus = data?.readStatus;
  this.localSettings.syncFullHistory = data?.syncFullHistory;
  this.localSettings.wavoipToken = data?.wavoipToken;
}

// ✅ DEPOIS
public async loadSettings() {
  const data = await this.prismaRepository.setting.findUnique({
    where: {
      instanceId: this.instanceId,
    },
  });

  // Valores padrão seguros (nunca marca como lida automaticamente)
  this.localSettings.rejectCall = data?.rejectCall ?? false;
  this.localSettings.msgCall = data?.msgCall ?? '';
  this.localSettings.groupsIgnore = data?.groupsIgnore ?? false;
  this.localSettings.alwaysOnline = data?.alwaysOnline ?? false;
  this.localSettings.readMessages = data?.readMessages ?? false;
  this.localSettings.readStatus = data?.readStatus ?? false;
  this.localSettings.syncFullHistory = data?.syncFullHistory ?? false;
  this.localSettings.wavoipToken = data?.wavoipToken ?? '';

  // Log para debug
  this.logger.verbose(
    `Settings loaded for ${this.instanceName}: ` +
      `readMessages=${this.localSettings.readMessages}, ` +
      `alwaysOnline=${this.localSettings.alwaysOnline}`,
  );
}
```

**Mudanças**:
- ✅ Usa operador nullish coalescing (`??`) para valores padrão
- ✅ `readMessages` default: `false` (nunca marca como lida)
- ✅ `alwaysOnline` default: `false` (nunca fica sempre online)
- ✅ Adiciona log verbose para rastreamento

##### 3. Validação Defensiva em `messages.upsert`

**Arquivo**: `whatsapp.baileys.service.ts` (linhas 1319-1340)

```typescript
// ❌ ANTES
if (this.localSettings.readMessages && received.key.id !== 'status@broadcast') {
  await this.client.readMessages([received.key]);
}

if (this.localSettings.readStatus && received.key.id === 'status@broadcast') {
  await this.client.readMessages([received.key]);
}

// ✅ DEPOIS
// Validação defensiva ANTES de marcar como lida
if (
  this.localSettings.readMessages === true &&
  received.key.id !== 'status@broadcast'
) {
  this.logger.verbose(`Marking message as read: ${received.key.id}`);
  await this.client.readMessages([received.key]);
} else if (this.localSettings.readMessages === undefined) {
  // Log de ALERTA se settings não foram carregadas
  this.logger.warn(
    `readMessages is undefined for instance ${this.instanceName}. ` +
      'Message NOT marked as read (safe default).',
  );
}

if (
  this.localSettings.readStatus === true &&
  received.key.id === 'status@broadcast'
) {
  this.logger.verbose(`Marking status as read: ${received.key.id}`);
  await this.client.readMessages([received.key]);
}
```

**Mudanças**:
- ✅ Validação estrita: `readMessages === true` (não apenas truthy)
- ✅ Log de WARNING se settings estiverem `undefined`
- ✅ Safe default: NÃO marca como lida se houver problema
- ✅ Logs verbose para debug

### Resultado

- ✅ Settings sempre carregadas antes de processar mensagens
- ✅ Valores seguros mesmo se banco falhar
- ✅ Logs detalhados para rastreamento
- ✅ Previne marcação acidental de mensagens como lidas

---

## 🔧 Correção #3: Marcação Automática no Banco de Dados

### Problema Identificado

**Sintoma**: Após implementar as correções anteriores, o problema **persistiu** em algumas instâncias. Logs mostravam:
```
[ChannelStartupService] Update not read messages 112807349645529@lid
[ChannelStartupService] Update as read in message.update 112807349645529@lid - 1767913251
```

**Causa Raiz**: Descoberta através de análise dos logs do Portainer e dos issues #1734 e #512 do repositório oficial.

A API estava marcando mensagens como `READ` **diretamente no banco de dados** através da função `updateMessagesReadedByTimestamp()`, independente da configuração `readMessages`.

**Dois pontos de marcação automática**:
1. **ACK de Leitura**: `client.readMessages()` enviado ao WhatsApp (✅ corrigido na Correção #2)
2. **Status no Banco**: SQL UPDATE marcando mensagens como `READ` (❌ NÃO corrigido)

### Análise Detalhada

#### Fluxo do Bug

1. Mensagem chega do WhatsApp com status `DELIVERY_ACK`
2. API salva mensagem no banco via `messages.upsert`
3. **Se `msg.status === status[4]`**, chama `updateMessagesReadedByTimestamp()`
4. SQL UPDATE marca mensagem como `READ` no banco
5. WhatsApp Multi-Device sincroniza status entre dispositivos
6. Celular recebe "mensagem já lida" → **NÃO notifica**

#### Código Problemático #1: `messages.upsert` Handler

**Arquivo**: `whatsapp.baileys.service.ts` (linhas 1377-1390)

```typescript
// ❌ CÓDIGO PROBLEMÁTICO
if (!cachedTimestamp) {
  if (!received.key.fromMe) {
    if (msg.status === status[3]) {
      this.logger.log(`Update not read messages ${remoteJid}`);
      await this.updateChatUnreadMessages(remoteJid);
    } else if (msg.status === status[4]) {
      this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
      await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);  // ← SEM VALIDAÇÃO!
    }
  } else {
    // is send message by me
    this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
    await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);  // ← SEM VALIDAÇÃO!
  }
}
```

#### Código Problemático #2: `messages.update` Handler

**Arquivo**: `whatsapp.baileys.service.ts` (linhas 1694-1696)

```typescript
// ❌ CÓDIGO PROBLEMÁTICO
if (status[update.status] === status[4]) {
  this.logger.log(`Update as read in message.update ${remoteJid} - ${timestamp}`);
  await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);  // ← SEM VALIDAÇÃO!
}
```

#### O que `updateMessagesReadedByTimestamp()` faz

**Arquivo**: `whatsapp.baileys.service.ts` (linhas 4744-4756)

```typescript
private async updateMessagesReadedByTimestamp(remoteJid: string, timestamp?: number): Promise<number> {
  if (timestamp === undefined || timestamp === null) return 0;

  // Use raw SQL to avoid JSON path issues
  const result = await this.prismaRepository.$executeRaw`
    UPDATE "Message"
    SET "status" = ${status[4]}  // ← MARCA COMO LIDA!
    WHERE "instanceId" = ${this.instanceId}
    AND "key"->>'remoteJid' = ${remoteJid}
    AND ("key"->>'fromMe')::boolean = false
    AND "messageTimestamp" <= ${timestamp}
    AND ("status" IS NULL OR "status" = ${status[3]})
  `;

  if (result) {
    if (result > 0) {
      this.updateChatUnreadMessages(remoteJid);
    }
    return result;
  }

  return 0;
}
```

**Impacto**: Este SQL UPDATE marca **todas** as mensagens como `READ` no banco, e o WhatsApp sincroniza esse status, impedindo notificações no celular.

### Solução Implementada

#### Arquivos Modificados

**`src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`**

#### Mudanças no Código

##### 1. Condicionar `updateMessagesReadedByTimestamp()` em `messages.upsert`

**Linhas 1377-1397**

```typescript
// ✅ CORREÇÃO
if (!cachedTimestamp) {
  if (!received.key.fromMe) {
    if (msg.status === status[3]) {
      this.logger.log(`Update not read messages ${remoteJid}`);
      await this.updateChatUnreadMessages(remoteJid);
    } else if (msg.status === status[4]) {
      // CORREÇÃO: Só marca como lida no banco se readMessages estiver explicitamente true
      if (this.localSettings.readMessages === true) {
        this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
        await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
      } else {
        this.logger.verbose(
          `Message with status READ not marked in DB (readMessages=${this.localSettings.readMessages}) - ${remoteJid}`,
        );
      }
    }
  } else {
    // is send message by me - SEMPRE marca como lida (mensagens enviadas pelo usuário)
    this.logger.log(`Update readed messages ${remoteJid} - ${timestamp}`);
    await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
  }

  await this.baileysCache.set(messageKey, true, this.MESSAGE_CACHE_TTL_SECONDS);
}
```

**Mudanças**:
- ✅ Adiciona validação `if (this.localSettings.readMessages === true)`
- ✅ Só marca como lida no banco se configuração explícita
- ✅ Mantém marcação para mensagens **enviadas** pelo usuário (`fromMe`)
- ✅ Log verbose quando mensagem NÃO é marcada

##### 2. Condicionar `updateMessagesReadedByTimestamp()` em `messages.update`

**Linhas 1700-1712**

```typescript
// ✅ CORREÇÃO
if (!cachedTimestamp) {
  if (status[update.status] === status[4]) {
    // CORREÇÃO: Só marca como lida no banco se readMessages estiver explicitamente true
    if (this.localSettings.readMessages === true) {
      this.logger.log(`Update as read in message.update ${remoteJid} - ${timestamp}`);
      await this.updateMessagesReadedByTimestamp(remoteJid, timestamp);
      await this.baileysCache.set(messageKey, true, this.MESSAGE_CACHE_TTL_SECONDS);
    } else {
      this.logger.verbose(
        `Message update to READ not applied to DB (readMessages=${this.localSettings.readMessages}) - ${remoteJid}`,
      );
    }
  }

  await this.prismaRepository.message.update({
    where: { id: findMessage.id },
    data: { status: status[update.status] },
  });
}
```

**Mudanças**:
- ✅ Adiciona mesma validação `if (this.localSettings.readMessages === true)`
- ✅ Previne marcação automática em atualizações de status
- ✅ Log verbose para rastreamento

### Resultado

- ✅ Mensagens permanecem como `DELIVERY_ACK` quando `readMessages=false`
- ✅ Banco de dados respeita configuração `readMessages`
- ✅ Celular recebe notificações normalmente
- ✅ Quando `readMessages=true`, comportamento permanece igual

---

## 📊 Comparação: Antes vs Depois

### Comportamento Anterior (Bugado)

| Ação | Resultado | Notificação no Celular |
|------|-----------|------------------------|
| Mensagem chega | Marcada como `READ` no banco | ❌ Não notifica |
| WhatsApp sincroniza | Celular vê "já lida" | ❌ Sem som/vibração |
| Config `readMessages=false` | **Ignorada** | ❌ Bug persiste |

### Comportamento Atual (Corrigido)

| Config | Resultado no Banco | ACK WhatsApp | Notificação |
|--------|-------------------|--------------|-------------|
| `readMessages=false` | `DELIVERY_ACK` | Não envia | ✅ Notifica |
| `readMessages=true` | `READ` | Envia | ❌ Não notifica |
| Settings undefined | `DELIVERY_ACK` (safe) | Não envia | ✅ Notifica |

---

## 🧪 Testes Realizados

### Ambiente de Teste

- **Infraestrutura**: 90 números conectados via Evolution API
- **Casos problemáticos**: 2 instâncias específicas com bug
- **Configuração**: `readMessages: false`, `alwaysOnline: false`
- **Dispositivos**: Android e iPhone

### Cenários Testados

#### 1. Conexão Nova via QR Code
- ✅ Celular recebe notificações após conexão
- ✅ Som de notificação funciona
- ✅ Logs confirmam `readMessages=false`

#### 2. Recebimento de Mensagens
- ✅ Mensagens ficam como `DELIVERY_ACK` no banco
- ✅ Logs: `"Message with status READ not marked in DB (readMessages=false)"`
- ✅ Celular notifica com som e vibração

#### 3. Reconexão após Desconexão
- ✅ Settings carregadas antes de processar mensagens
- ✅ Logs: `"Instance teste settings loaded: readMessages=false, alwaysOnline=false"`
- ✅ Comportamento consistente

#### 4. WhatsApp Android Ativo
- ✅ API permanece conectada (Multi-Device)
- ✅ Sem desconexões forçadas
- ✅ Ambos dispositivos funcionam simultaneamente

### Logs de Diagnóstico

```
[Evolution API] v2.3.7 - INFO [ChannelStartupService] Connecting instance teste...
[Evolution API] v2.3.7 - INFO [ChannelStartupService] Instance teste settings loaded: readMessages=false, alwaysOnline=false
[Evolution API] v2.3.7 - VERBOSE [ChannelStartupService] Settings loaded for teste: readMessages=false, alwaysOnline=false
[Evolution API] v2.3.7 - INFO [ChatwootService] [messages.upsert] New message received - Instance: {...}
[Evolution API] v2.3.7 - VERBOSE [ChannelStartupService] Message with status READ not marked in DB (readMessages=false) - 112807349645529@lid
```

---

## 📝 Issues Relacionados

### Resolvidos

- ✅ **#1734**: Phone push notifications stop receiving when evolution API connected
- ✅ **#512**: [PT][BUG] - SOM DE NOTIFICAÇÕES NÃO FUNCIONAM APÓS CONECTAR SESSÃO
- ✅ **#2270**: Mensagens recebidas no WhatsApp são lidas pela API, mas não chegam no webhook
- ✅ **#2061**: [BUG] Error to receive messages

### Workaround Anterior (Issue #512)

**Antes das correções**, usuários reportavam que precisavam:
1. Ir no Manager → Sessão → Comportamento
2. **Marcar** "Sempre Online" → Salvar
3. **Desmarcar** "Sempre Online" → Salvar
4. Som de notificações voltava temporariamente

**Após correções**: Workaround não é mais necessário.

---

## 🚀 Instruções de Deploy

### Pré-requisitos

- Evolution API v2.3.7 ou superior
- Baileys 7.x
- Node.js 18+
- Docker (opcional)

### Instalação

#### Via Git

```bash
git clone https://github.com/seu-usuario/evolution-api-fork.git
cd evolution-api-fork
git checkout multi-device
npm install
npm run db:generate
npm run build
npm start
```

#### Via Docker

```bash
docker pull sphott/evolution-api:v2.3.7-notification-fix-v2
docker run -d \
  --name evolution-api \
  -p 8080:8080 \
  -e DATABASE_PROVIDER=postgresql \
  sphott/evolution-api:v2.3.7-notification-fix-v2
```

#### Via Docker Compose

```yaml
services:
  api:
    container_name: evolution_api
    image: sphott/evolution-api:v2.3.7-notification-fix-v2
    restart: always
    ports:
      - "8080:8080"
    environment:
      - DATABASE_PROVIDER=postgresql
```

### Verificação

Após deploy, verificar nos logs:

```bash
# Log de conexão
[INFO] Connecting instance teste...

# Log de settings carregadas
[INFO] Instance teste settings loaded: readMessages=false, alwaysOnline=false

# Log de mensagem NÃO marcada como lida
[VERBOSE] Message with status READ not marked in DB (readMessages=false) - ...
```

---

## 📈 Métricas de Impacto

### Antes das Correções

- ❌ 2 de 90 instâncias (2.2%) com bug de notificação
- ❌ Desconexões frequentes (Multi-Device)
- ❌ Workarounds manuais necessários
- ❌ Race conditions intermitentes

### Depois das Correções

- ✅ 0 de 90 instâncias com bug (0%)
- ✅ Conexões estáveis (Multi-Device nativo)
- ✅ Sem necessidade de workarounds
- ✅ Settings sempre carregadas corretamente

---

## 🔍 Detalhes Técnicos Adicionais

### Arquitetura de Sincronização

#### WhatsApp Multi-Device Protocol

O WhatsApp Multi-Device usa um protocolo de sincronização bidirecional:

1. **Device Principal** (celular): Fonte de verdade
2. **Devices Secundários** (API, WhatsApp Web): Sincronizam estado

**Problema**: Se um device secundário marca mensagem como lida, **todos** sincronizam, incluindo o celular.

**Solução**: API só deve marcar como lida se o usuário **explicitamente** configurar.

### Race Conditions em JavaScript/Node.js

```javascript
// PROBLEMA: Event Loop do Node.js não garante ordem
async function connectToWhatsapp() {
  this.loadSettings();        // Entra na fila de microtasks
  this.createClient();        // Executado imediatamente
  // createClient pode executar ANTES de loadSettings completar!
}

// SOLUÇÃO: await força ordenação
async function connectToWhatsapp() {
  await this.loadSettings();  // Espera completar
  await this.createClient();  // Só executa depois
}
```

### Nullish Coalescing vs OR Operator

```javascript
// PROBLEMA com || (falsy values)
const value = data?.readMessages || false;
// Se readMessages for false (válido), retorna false ✅
// Se readMessages for undefined, retorna false ✅
// MAS se readMessages for 0 ou '' (válido), retorna false ❌

// SOLUÇÃO com ?? (null/undefined only)
const value = data?.readMessages ?? false;
// Se readMessages for false, retorna false ✅
// Se readMessages for undefined, retorna false ✅
// Se readMessages for 0, retorna 0 ✅
```

---

## 🎯 Recomendações para o Repositório Original

### Prioridade Alta

1. **Merge das 3 correções**: Todas são críticas e interdependentes
2. **Testes adicionais**: Ambiente com múltiplas instâncias simultâneas
3. **Documentação**: Atualizar docs sobre comportamento de `readMessages`

### Prioridade Média

1. **Telemetria**: Adicionar métricas de race conditions detectadas
2. **Health Check**: Validar que settings foram carregadas antes de marcar como "ready"
3. **Testes unitários**: Cobrir cenários de race condition

### Prioridade Baixa

1. **Refatoração**: Extrair lógica de marcação de leitura para método dedicado
2. **Config**: Permitir override de defaults via env vars
3. **Logs estruturados**: JSON logs para melhor parseamento

---

## 📚 Referências

### Pull Requests

- **#2332**: Multi-Device Fix (base para Correção #1)

### Issues

- **#1734**: Phone push notifications stop receiving when evolution API connected
- **#512**: [PT][BUG] - SOM DE NOTIFICAÇÕES NÃO FUNCIONAM APÓS CONECTAR SESSÃO
- **#2270**: Mensagens lidas pela API mas não chegam no webhook
- **#2061**: Error to receive messages

### Documentação Técnica

- [Baileys Multi-Device Documentation](https://github.com/WhiskeySockets/Baileys)
- [WhatsApp Multi-Device Protocol](https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/)
- [JavaScript Event Loop](https://developer.mozilla.org/en-US/docs/Web/JavaScript/EventLoop)

---

## 👥 Contribuidores

- **Análise e Implementação**: [Seu Nome/Username]
- **Testes**: Ambiente de produção com 90 instâncias
- **Base**: PR #2332 do repositório original

---

## 📄 Licença

Mesma licença do projeto Evolution API original (Apache 2.0)

---

## ✅ Checklist para Pull Request

- [x] Todas as 3 correções implementadas
- [x] Build TypeScript passa sem erros
- [x] Testes em ambiente de produção (90 instâncias)
- [x] Logs de diagnóstico adicionados
- [x] Documentação completa (este arquivo)
- [x] Backwards compatible (não quebra API existente)
- [x] Commits seguem Conventional Commits
- [x] Issues relacionados documentados

---

**Data de Criação**: 08 de Janeiro de 2026  
**Última Atualização**: 08 de Janeiro de 2026  
**Versão do Documento**: 1.0
