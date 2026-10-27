# Report: isolamento entre instâncias (rc14)

Spec: [isolamento-instancias-rc14](../specs/2026-10-27-isolamento-instancias-rc14-design.md). Plano: [plano](../plans/2026-10-27-isolamento-instancias-rc14.md).

## O que mudou

Commits `79d80b38`..`2c2dee0c` na branch `v2.3.7-sphot-rc13`: 9 tarefas do plano e um passe de correção depois da revisão independente.

- **Autenticação.**
  - AUT-1 e AUT-11: o nome da instância vem só do path.
  - AUT-2: os guards comparam a rota exata.
  - AUT-4: o websocket isola cada instância.
  - AUT-6 (parcial): `/webhook/evolution` só considera instâncias EVOLUTION.
- **Chatwoot.**
  - CW-1: com o Chatwoot desligado, nada é enviado.
  - CW-2/3: a caixa da instância é achada pelo nome, com desempate pela URL do webhook; sem caixa, nada é enviado.
  - CW-4: a importação filtra conta e caixa.
  - CW-5 (parcial): a fila reconfere se o job já foi concluído.
  - CW-6: sem `instanceId`, a exclusão não consulta o banco.
  - CW-7: a conversa em cache de outra caixa é descartada.
  - CW-8: a assinatura usa o autor da mensagem.
  - CW-10: o aviso de não enviada não escreve em outra caixa.
- **Chatbots (BOT-1 a BOT-6).**
  - O cliente OpenAI é criado por chamada.
  - O debounce é identificado por instância.
  - O Typebot usa o `instanceId` na transcrição e o token da instância.
  - `changeStatus` e `fetchBot` ficam restritos à instância.
- **Canais.**
  - CH-1: o webhook da Meta é processado entry por entry.
  - CH-3: a contagem de não lidas é por instância.
  - CH-6: o contato da Meta é atualizado por instância.
  - CH-8 e CH-9: os caches de leitura e de grupo levam a instância.
  - CH-11: o `onWhatsappCache` só aceita correspondência exata.

## Revisão independente (fim da branch)

| Grav. | Achado | O que foi feito |
|---|---|---|
| Crítico | AUT-1 apagava `?instanceId=` também no `fetchInstances`. O manager abriria a instância errada. | Corrigido: a query só perde a identidade quando o path tem `:instanceName`. Teste unitário e cenário no smoke. |
| Importante | A checagem "já enviada" pelo banco pode colidir com ids de outro Chatwoot. Além disso, `Message` só tem índice por `instanceId`, então a consulta varreria as mensagens a cada envio. | Removida. Fica como pendência, porque precisa de índice (migration). |
| Importante | Sem a caixa da instância, a mensagem é bloqueada sem nota ao atendente. | Mantido assim: escrever numa conversa de dono desconhecido poderia vazar para outra caixa. O erro fica no log. |
| — | CW-9 (MESSAGE_READ pela conversa) passaria a mandar recibos de leitura que hoje não saem, e varreria as mensagens. | Revertido ao comportamento atual. Fica como pendência. |

Ficaram de fora quatro itens menores, registrados em [pendencias.md](../../pendencias.md): BOT-8 vira `[audio] null`, um comentário fora de lugar, WS-1 e a nota sobre o Typebot.

## Ambiente

- Unitários: 15 arquivos `test/*.test.ts`, todos passando. `npm run build` ok.
- VPS de teste (Portainer, Evolution, Chatwoot v4.13), instâncias Nexa-AI-Bussines, Nexa-DEMO-1 e NexaAI-Cloud.
- Imagens: rc14-test3 `sha256:bea518b4…` (antes da revisão) e **rc14-test4 `sha256:689f5045…`** (commit `2c2dee0c`, candidata).

## Testes na VPS

| Teste | rc14-test2 (antes) | rc14-test3 | rc14-test4 |
|---|---|---|---|
| Smoke | 29/32 (os 3 cenários de isolamento falharam: ataque reproduzido) | 32/32 | **33/33** (com o cenário do manager) |
| `?instanceName=` com token de outra instância | respondeu pela outra | só a própria | só a própria |
| `create?x=/instance/fetchInstances` com token de instância | **criou instância** (201) | 401 | 401 |
| `verify-creds?x=` com token de instância | 200 | 401 | 401 |
| `fetchInstances?instanceId=` (manager) | — | — | só a pedida |
| Eco do template (incidente) | — | não vazou | não vazou |
| Evento de outra caixa | — | ignorado | ignorado |
| Áudio da Cloud pelo Chatwoot | — | ptt + waveform | ptt + waveform |
| Chatwoot desligado não envia / religado envia | — | ok / ok | ok / ok |
| Meta com dois entries (só o próprio) | — | ok | ok |
| Dedup 3 rodadas | — | 24/24 | 23/24, depois 24/24 (ver abaixo) |

**Falha isolada na dedup (rc14-test4, rodada 2).** A resposta do atendente na conversa #164 saiu 97 s depois, e o script espera 90 s. A Evolution ficou 90 s sem nenhum registro e, quando o processamento começou, enviou em 6 s. Durante esse tempo, as automações do Chatwoot estavam atribuindo a conversa. A conclusão é que o atraso foi na entrega do webhook pelo Chatwoot. A repetição das 3 rodadas passou 24/24, e nada nesta rc toca no caminho de tempo da entrega.

**Logs da rc14-test4.** Os ERROR foram todos esperados:

- a edição recusada e o `getBase64` inválido, provocados pelo smoke;
- o número inexistente do teste da Meta.

Houve também uma `uncaughtException` do ffmpeg ("Output stream closed"). É um bug anterior a esta rc, no `processAudio` do Baileys: o `.on('error')` fica depois do `.pipe`. Foi registrado e não derruba o processo. Está em pendências como CH-21.

## Não testado

- Websocket, OpenAI, Typebot, n8n e Flowise não são usados em produção.
  - O websocket tem teste de integração com socket.io real (1/5 no código antigo, 5/5 agora).
  - Os chatbots só passaram por tsc e revisão.
- RabbitMQ: nenhuma mudança nesta rc toca nele.
