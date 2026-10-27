# Documentação de desenvolvimento do fork

Tudo o que é decidido, testado e publicado neste fork fica registrado aqui, para que a próxima pessoa (ou o próximo agente) saiba o que foi feito, por quê e como foi validado.

```
docs/
├── superpowers/
│   ├── research/   investigações, auditorias, análise de incidentes (evidências com arquivo:linha)
│   ├── specs/      o que vai ser feito e o que fica de fora (saída do superpowers:brainstorming)
│   ├── plans/      passo a passo da implementação (saída do superpowers:writing-plans)
│   ├── reports/    o que foi testado e o resultado (unitários, smoke, VPS, produção)
│   └── releases/   uma nota por imagem publicada (tag, digest, commit, envs, deploy e rollback)
├── pendencias.md   falhas conhecidas que ainda não foram corrigidas, com o motivo
├── assets/         logos e favicon do manager
└── private/        logs de produção, configs com senha: NUNCA versionado (.gitignore)
```

Nomes de arquivo: `AAAA-MM-DD-<tema>.md` (releases: `<tag>.md`, ex. `v2.3.7-sphot-rc14.md`).

## Fluxo

Toda mudança de comportamento passa por estas etapas. Correção trivial (typo, log, uma linha óbvia) pode pular spec e plan, mas não pula teste nem report.

1. **Research** — antes de mexer, entender. Reproduzir o problema, ler o código, juntar evidências (logs, payloads, arquivo:linha). Grava em `research/`. Incidente de produção sempre gera um research.
2. **Spec** — `superpowers:brainstorming`. Escopo, o que fica de fora, e a seção obrigatória **Compatibilidade com produção** (abaixo). Grava em `specs/`.
3. **Plan** — `superpowers:writing-plans`. Tarefas pequenas, cada uma com o teste que prova que funciona. Grava em `plans/`.
4. **Implementação** — `superpowers:test-driven-development`: o teste que reproduz o bug vem antes da correção (`test/*.test.ts`, rodados com `npx tsx`). Um commit por correção, mensagem em português explicando o porquê.
5. **Verificação** — `superpowers:verification-before-completion`: `npm run build`, lint, todos os `test/*.test.ts`, e para o que toca WhatsApp/Chatwoot, a VPS de teste (smoke `test/e2e/smoke.py`, dedup 3 rodadas, cenários do próprio bug). Grava o resultado em `reports/`.
6. **Release** — imagem `sphott/evolution-api:<tag>` só amd64, branch renomeada para a tag, `latest` só quando pedido. Nota em `releases/<tag>.md`.
7. **Pendências** — o que foi achado e não entrou vai para `pendencias.md` com gravidade e motivo.

### Compatibilidade com produção (obrigatória em toda spec)

A atualização em produção tem que ser limpa: trocar a imagem e continuar funcionando, sem ação manual.

- Nenhuma variável de ambiente nova obrigatória; variável nova só opcional e com padrão igual ao comportamento atual.
- Nenhuma mudança que exija reconfigurar Chatwoot, Meta, webhooks ou instâncias existentes.
- Migrations só aditivas e compatíveis com a imagem anterior (rollback precisa funcionar).
- Mudança de comportamento só para corrigir algo errado; se uma configuração legítima pode ser afetada, a spec diz qual e como fica.
- Produção usa: Baileys, Cloud API (Meta), webhook por instância, Chatwoot e RabbitMQ. Isso é testado com mais profundidade.

## Modelos

**Report** (`reports/`): o que mudou (commits) · ambiente (imagem/digest, VPS) · tabela de testes com resultado · problemas encontrados no teste e o que foi feito · o que não foi testado e por quê.

**Release** (`releases/<tag>.md`): imagem e digest · commit · lista de mudanças · variáveis de ambiente novas (ou "nenhuma") · passos de deploy · como fazer rollback (tag anterior) · link para o report.

## Segredos

Nada de tokens, senhas, apikeys ou logs de produção fora de `docs/private/`. Ao citar um log num research, copie só as linhas necessárias e troque tokens por `<token>`.
