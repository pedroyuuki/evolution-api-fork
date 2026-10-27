# Incidente 26/10: cópia de templates da Cloud enviada por outro número

## O que aconteceu

Em 26/10, 7 de 307 templates disparados pela Cloud API (caixas "GG - SUPORTE GRATUITO_API" e "GP - API_SUPORTE") chegaram também como texto literal (`▶️<template>◀️`) aos clientes. O texto foi enviado pela instância Baileys `UasyCRTL…_Whatsapp_IdCW_11` (554998030732). Essa instância não enviou mais nada naquele dia. A Meta confirmou a entrega dos templates; os textos vazados tiveram DELIVERY_ACK.

Todos os 7 casos foram em conversas NOVAS no Chatwoot. Na instalação de produção, o único lugar com a URL do webhook da instância da Uasy é o channel 120 (caixa "GG - Andrei").

## Causas encontradas

1. **Detecção de eco olhava a mensagem errada.** O webhook `message_created` do Chatwoot traz a mensagem do evento na raiz (`source_id`, anexos). `conversation.messages[0]` é a ÚLTIMA mensagem da conversa, montada de forma assíncrona. Numa conversa recém-criada costuma ser outra mensagem. A Evolution grava a cópia do template com `source_id: WAID:<id>`; o guard checava só `messages[0].source_id` e deixava a cópia passar, e a instância reenviava o texto. Reproduzido na VPS de teste com rc13 (vazou) e corrigido em 671276f6 (não vazou).
2. **Nenhuma checagem de que o evento era da caixa da instância.** A instância da Uasy recebeu eventos de conversas de outras caixas e os enviou. Corrigido em 9c706c70 (`isFromAnotherInbox`).
3. **Disputa pelo `provider` no ChatwootService.** O serviço é um objeto só para todas as instâncias e guardava a configuração da instância em uso num campo. Com instâncias processando ao mesmo tempo, um `await` deixava outra trocar o campo no meio. Na VPS, o cache `getInbox` da NexaAI-Cloud ficou com a caixa da Nexa-DEMO-1 por 7 dias. A correção 2 passou então a bloquear mensagens legítimas da própria Cloud. Corrigido em c572d688 (AsyncLocalStorage por chamada, e o cache da caixa é conferido pelo nome).

## Em aberto

Por qual rota a instância da Uasy recebeu eventos de caixas que não são dela. Inbox webhook só dispara para a própria caixa. Falta consultar no Chatwoot de produção:

- `select id, url, subscriptions from webhooks where account_id = 11;` (webhooks da conta)
- `select id, name, outgoing_url from agent_bots;` (agentes-robô)
- log do Traefik de `POST /chatwoot/webhook/UasyCRTL…` por volta de 26/10 10:01:54

Hipóteses levantadas pela auditoria de 27/10 (ver [auditoria](2026-10-27-auditoria-isolamento-instancias.md)): CW-1 (Chatwoot desligado na instância, mas os webhooks ainda processados) e CW-3 (caixa encontrada só pelo nome).

## Validação

rc14-test2 (`sha256:e8b020ae…`, commit c572d688) na VPS de teste:

| Teste | Resultado |
|---|---|
| reenvio do eco | não vazou |
| evento de outra caixa | ignorado, com aviso no log |
| áudio da Cloud pelo Chatwoot | ok, ptt e waveform |
| cache errado da caixa | corrigido sozinho, com aviso no log |
| smoke | 28/28 |
| dedup | 24/24 em 3 rodadas |
