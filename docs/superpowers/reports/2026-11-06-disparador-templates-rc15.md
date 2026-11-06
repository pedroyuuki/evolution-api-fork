# Report: disparador de templates (rc15)

- **Spec:** [disparador-templates-rc15](../specs/2026-11-06-disparador-templates-rc15-design.md)
- **Plano:** [plano](../plans/2026-11-06-disparador-templates-rc15.md)
- **Pedido:** NX-CWDash `07-evolution-ajustes-disparador.md`

## O que mudou (commits 6d4d9491..89b26594)

| # | Item | Commit |
|---|---|---|
| 1 | Colunas `dispatch*` e `MessageUpdate.errors`, migrations, env opcional `CHATWOOT_DISPATCH_CONTEXT_HOURS`, senha do banco fora do log | 6d4d9491 |
| 2 | Status da Cloud: busca indexada por `key->>'id'`; um status por vez (o lote não é mais descartado); A2 (`errors`, `timestamp`, `conversation`, `pricing`) | 3ba91cfd |
| 3 | A5: `emitWebhook` e `chatwoot` no `sendTemplate`; `remoteJid` pelo `wa_id` nos disparos | 909658b0 |
| 4 | A5b: template antes da resposta (reserva atômica e espera por contato) | cdd147f5 |
| 5 | A4: `POST /business/uploadMedia/{instance}` | 0702b438 |
| 6 | A8: com número duplicado, status vão para a dona e o resto para a mais antiga | 1378d9af |
| 7 | Mídia enviada por link aparece no Chatwoot | 330d0797 |
| — | Segurança: bloqueio de rede interna cobre IPv6 com IPv4 embutido e DNS rebinding | ca91f907 |
| — | Revisão final: migrations separadas com `CONCURRENTLY`, reserva devolvida quando o Chatwoot falha, `detectMime` só com marcas de MP4/3GPP | 89b26594 |

## Revisão independente

| Grav. | Achado | O que foi feito |
|---|---|---|
| Crítico | SSRF pelo IPv6 mapeado (`[::ffff:127.0.0.1]` vira `::ffff:7f00:1`). Alcançável também pelo `getBase64FromMediaMessage` (ramo novo do link). | Corrigido (ca91f907) |
| Importante | Uma migration só: o `ALTER` travava `Message`, inclusive leitura, durante os dois índices, e o índice parcial não podia ser criado antes. | Três migrations, índices com `CONCURRENTLY`. Testado num Postgres 14 do zero e com os índices já existentes (no-op). |
| Importante | O `eventWhatsapp` engole erro, então a reserva do A5b não voltava. | `syncSucceeded`: sem id, a reserva volta |
| Importante | `detectMime` aceitava HEIC, M4A e QuickTime como MP4. | Só marcas de MP4/3GPP |

Os menores foram para [pendencias.md](../../pendencias.md) (M1 a M10).

## Testes

- **Unitários:** 20 arquivos `test/*.test.ts`, todos passando. `npm run build` ok.
- **Migrations:** Postgres 14 local, do zero e como no-op.
- **VPS de teste**, imagem `rc15-test2` (`sha256:b0ffdb6a…`, commit 89b26594), Chatwoot v4.13:
  - Antes da troca de imagem, o roteiro do release na tabela `Message` de 845 MB: as colunas entraram na hora e os dois índices com `CONCURRENTLY` levaram 8 s. As migrations viraram no-op no start, e o log não mostra mais a URL do banco.
  - `EXPLAIN`: as duas consultas usam os índices novos.

| Verificação | Resultado |
|---|---|
| Template **sem** opções: `SEND_MESSAGE` no webhook da instância (como hoje) | ok |
| Disparo `emitWebhook:false, chatwoot:false` para `44999780180` (sem o 55): `remoteJid` gravado `554499780180@s.whatsapp.net` | ok |
| Disparo: `webhookUrl` recebe os status; o webhook da instância não recebe nada; não vai ao Chatwoot | ok |
| Resposta da DEMO-1 (citando o disparo) e mais uma logo depois: template no Chatwoot **uma vez, antes das duas**; ids do Chatwoot gravados | ok |
| Número inexistente: `FAILED` com `errors[0].code = 131026` no `webhookUrl` e em `MessageUpdate.errors` | ok |
| Lote de status forjado (desconhecido antes do conhecido): o conhecido é processado | ok |
| Upload: MP4 de 15 MB volta com id; 17 MB dá 400 com motivo; `url` `[::ffff:127.0.0.1]` dá 400; instância Baileys dá 400 | ok |
| Imagem por link pela Cloud aparece no Chatwoot com anexo | ok |
| Número duplicado (instância fictícia mais nova): resposta vai para a original, status para a dona, aviso no log | ok |
| Smoke (Baileys + Chatwoot) | 33/33 |
| Logs | só os ERROR provocados pelo smoke; nenhuma exceção não tratada |

## Não testado

- **Template com vídeo no cabeçalho usando o id do upload:** a conta de teste não tem template de vídeo, e ele não pode ser criado pela API da Evolution (exige o handle da API de upload do app da Meta). O upload devolveu o id; falta criar `teste_video_rc15` pelo WhatsApp Manager e enviar com `{"type":"video","video":{"id":"..."}}`.
- **Chatwoot 3.15.8 (o de produção) com a mensagem do disparo criada antes da resposta:** testado só no Chatwoot v4.13.
- **MySQL:** só schema e migration. A produção é Postgres.
- **Dedup, eco e caixa alheia (scripts da rc14):** os scripts se perderam com a limpeza do scratchpad. A rc15 não mexe nesses caminhos, e o smoke cobriu o Chatwoot com Baileys.
