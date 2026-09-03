# Gerente da Codxis — Bot de Check-in/Check-out

## Visão geral

Bot de IA externo que faz check-in/check-out diário de tarefas com colaboradores, registrando
o histórico e calculando aderência (planejado vs. realizado). Não substitui o CRM — complementa,
evitando que o colaborador digite a mesma tarefa duas vezes.

**Decisões-chave (fechadas):**
- MVP **autônomo, sem CRM**: o colaborador informa as tarefas na hora do check-in. Não depende
  de Edge Functions do Lovable/CRM. (Leitura anterior integrava ao CRM; foi descartada para
  desbloquear o MVP.)
- Canal de conversa: **WhatsApp**. Para teste rápido usa `whatsapp-web.js` (QR code, gratuito).
  Em produção troca-se o conector por provedor pago (Z-API/Twilio) sem reescrever a lógica.

## Arquitetura

```text
Bot externo (Node + TypeScript)
  ├── src/channel/ChannelConnector.ts    → interface de canal (agente independente do canal)
  ├── src/channel/WhatsAppConnector.ts   → conector WhatsApp (whatsapp-web.js, QR code)
  ├── src/channel/ConsoleConnector.ts    → conector de terminal (teste sem WhatsApp)
  ├── src/bot/CheckInBot.ts              → máquina de estados check-in/check-out + aderência + alertas + sugestões
  ├── src/store/CheckInStore.ts          → persistência PostgreSQL (pg)
  ├── src/report/gestao.ts               → agregação de dados de gestão (capacidade/aderência/recorrentes + CSV/JSON)
  ├── src/ai/LLMProvider.ts              → provedor LLM configurável (OpenAI-compatible) — opcional
  ├── src/ai/Dialogo.ts                  → redige cada pergunta da conversa guiada (LLM + fallback por tópico)
  ├── src/ai/Sugestoes.ts                → gerador de sugestões inteligentes (LLM + fallback por regras)
  ├── src/agendar/Scheduler.ts           → agendador de turnos (dispara nos horários, uma vez por dia por turno)
  ├── src/agendar/turnos.ts              → monta os 3 turnos a partir das env vars (manhã/tarde/fim do dia)
  ├── src/agendar/iniciar.ts             → `iniciarAgendador(bot, connector)` — liga os turnos nos entrypoints
  ├── src/dashboard/server.ts            → servidor HTTP do painel web de gestão
  ├── src/dashboard/start-dashboard.ts   → entrypoint do dashboard
  ├── src/index.ts                       → entrypoint WhatsApp
  └── src/index-console.ts               → entrypoint console (teste)
```

**Camada de abstração de canal** (`ChannelConnector`): a lógica do bot só conhece esta interface.
Trocar de canal (WhatsApp → Telegram, etc.) = criar novo conector, sem tocar no `CheckInBot`.

**Gerente com sugestões inteligentes** (`src/ai/Sugestoes.ts`): o bot analisa os dados agregados
(aderência, pendências recorrentes, quem não fez check-in) e propõe **próximos passos** para a
empresa. Com `OPENAI_API_KEY` configurada, usa um LLM; sem ela, cai numa heurística determinística
por regras. Há duas visões: **empresa** (gestão) e **individual** (colaborador).

**Relatório de gestão reutilizável** (`src/report/gestao.ts`): agrega capacidade (planejadas vs.
concluídas em tarefas), aderência do período e pendências recorrentes. É usado tanto pelo `CheckInBot`
(`/relatorio`, `/exportar-*`, alerta proativo) quanto pelo dashboard web — sem duplicar lógica.

## Fluxos

- **Check-in (manhã)**: `/check-in` → "Quais são suas tarefas para hoje?" → registra lista + timestamp.
- **Check-out (tarde)**: `/check-out` → "O que você concluiu?" → "O que ficou pendente?" → "Por quê?"
- **Adendo**: compara check-out (concluídas/pendentes) com check-in (planejadas) → taxa de aderência
  e pendências fora do planejamento.
- **Pendência recorrente**: mesma tarefa pendente por 3+ check-outs seguidos sem justificativa →
  alerta de gestão.
- **Relatório**: `/relatorio` agrega por colaborador (capacidade em tarefas + aderência do período +
  pendências recorrentes).
- **Outros comandos**: `/hoje` (resumo), `cancelar` (aborta fluxo em andamento).

## Turnos automáticos (agendador)

O gerente **não depende de o usuário digitar comando**: um agendador dispara mensagens
automaticamente nos horários configurados (`Scheduler` em `src/agendar/`). As mensagens vão
somente para os IDs **fixos** de `FUNCIONARIOS_IDS` (não faz descoberta no banco) e para a gestão.

- **Manhã** (`HORA_CHECKIN`, padrão 10:00): inicia a **conversa guiada de check-in**
  automaticamente para quem ainda não registrou (pergunta "Quais são suas tarefas?" e o
  colaborador responde — sem precisar digitar `/check-in`).
- **Início da tarde** (`HORA_COBRANCA_CHECKIN`, padrão 14:30): cobrança de check-in para quem ainda
  não registrou hoje.
- **Fim do expediente** (`HORA_CHECKOUT`, padrão 16:30): inicia a **conversa guiada de check-out**
  (concluídas → pendentes → justificativa) para quem fez check-in mas ainda não fechou o dia
  (sem precisar digitar `/check-out`), enviando as **sugestões individuais do colaborador**
  junto com a pergunta inicial.
- Desligável com `AGENDADOR_ATIVO=false`. Dispara uma única vez por dia por turno.

## Conversa guiada com LLM

O `CheckInBot` conduz o check-in/check-out seguindo um **roteiro fixo de tópicos** (ordem sempre
a mesma), mas o **LLM (ChatGPT) redige cada pergunta** de forma natural (`src/ai/Dialogo.ts`).
- Ordem fixa: check-in pergunta as tarefas; check-out pergunta o que foi concluído, depois as
  pendências, depois o motivo/justificativa.
- **Uma pergunta por vez**: o gerente nunca envia duas mensagens seguidas — sempre aguarda a
  resposta do colaborador (impossível criar loop de perguntas).
- **Fallback offline**: se o LLM falhar ou não houver chave, usa perguntas prontas daquele tópico
  (mesma ordem) — o fluxo nunca trava.

## Modelo de dados

Tabela `checkins_diarios` no PostgreSQL (banco definido por `DATABASE_URL`,
criado com schema automático na conexão):

- `tenant_id` (default `"codxis"`), `colaborador_id` (id do remetente no canal), `data` (date)
- `tipo`: `check_in` | `check_out`
- `tarefas` (jsonb): no check_in = planejadas; no check_out = concluídas
- `pendentes` (jsonb, só check_out), `justificativa_pendencia` (text, só check_out)
- `criado_em` (timestamptz)

Aderência calculada por agrupamento `(tenant_id, colaborador_id, data)`, comparando check_out vs check_in.

## Subir o banco (PostgreSQL)

O repositório traz um `docker-compose.yml` com PostgreSQL 16 mapeado para a
porta **5433** do host (evita conflito com outros bancos na 5432):

```powershell
docker compose up -d   # http://localhost:5433, usuário/senha/banco: codxis
```

O schema é criado automaticamente pelo `CheckInStore.connect()`.

## Comandos

| Comando | Ação |
|---|---|
| `npm run dev` | Inicia o bot no WhatsApp (mostra QR no terminal) |
| `npm run dev:console` | Inicia o bot no terminal (teste sem WhatsApp) |
| `npm run dev:dashboard` | Sobe o painel web da gestão (http://127.0.0.1:3111/) |
| `npm run typecheck` | Verifica tipos (tsc --noEmit) |
| `npm run test` | Roda os testes (node:test — 8 arquivos: aderência, store, fluxo, pendência, dashboard, sugestões, agendador) |
| `npm run build` | Compila para `dist/` |
| `npm start` | Roda o build compilado |

> Os testes usam PostgreSQL: suba o container com `docker compose up -d` antes de `npm run test`.
> Cada arquivo de teste usa um banco isolado (`codxis_test_*`) criado automaticamente.

## Rodar e testar no WhatsApp

1. `npm install` (dependências de produção: `whatsapp-web.js`, `qrcode-terminal`, `pg`)
2. `npm run dev` → escaneia o QR com o celular (WhatsApp → Aparelhos conectados → Conectar aparelho)
3. Envie mensagens para si mesmo: `/check-in`, depois `/check-out`, depois `/hoje`

## Testar sem WhatsApp (console)

Para validar toda a lógica do agente sem depender do WhatsApp, use o conector de console:

```powershell
npm run dev:console
```

O bot conversa pelo terminal (mesma máquina de estados e store PostgreSQL). Digite os mesmos comandos. Para sair, escreva `sair`.

> Atenção: como usa o mesmo banco (`DATABASE_URL`), registros criados no console aparecem no WhatsApp e vice-versa. Use `DATABASE_URL` para isolar (ex.: apontar para um banco de teste).

## Comandos do chat

| Comando | Quem | Ação |
|---|---|---|
| `/check-in` (`/checkin`) | todos | Registra as tarefas planejadas do dia |
| `/check-out` (`/checkout`) | todos | Fecha o dia: concluídas, pendentes, justificativa |
| `/hoje` (`/resumo`) | todos | Resumo de hoje (planejadas + aderência) |
| `/sugestoes` | todos | Próximos passos: visão de empresa (gestão) ou individual (colaborador) |
| `/relatorio` | **gestão** | Relatório agregado da gestão (capacidade, aderência, pendências recorrentes, últimos 7 dias) |
| `/exportar-csv` | **gestão** | Exporta os dados de gestão em CSV |
| `/exportar-json` | **gestão** | Exporta os dados de gestão em JSON |
| `cancelar` | todos | Aborta o fluxo em andamento |

**Restrição de gestão (`GESTAO_IDS`)**: quem pode ver `/relatorio` e os `/exportar-*`, e quem recebe o
**alerta proativo** de pendência recorrente. Se `GESTAO_IDS` estiver vazio, `/relatorio`/export ficam
bloqueados para todos e nenhum alerta é enviado.

**Alerta proativo de pendência recorrente**: após cada check-out, o bot verifica todos os colaboradores
e, se houver pendência recorrente (3+ dias seguidos sem justificativa), avisa automaticamente cada ID
de gestão configurado — sem depender de ninguém rodar `/relatorio`.

**Sugestões inteligentes do gerente**: analisa os dados agregados e propõe **próximos passos** para a
empresa ou para o colaborador. Com `OPENAI_API_KEY`, um LLM formula as sugestões; sem ela, um fallback
por regras (determinístico) assume. São enviadas proativamente após o check-out e o `/hoje`, com foco
conforme o remetente (gestão → visão de empresa; colaborador → visão individual), e sob demanda via `/sugestoes`.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `DATABASE_URL` | `postgres://codxis:codxis@localhost:5433/codxis` | String de conexão do PostgreSQL |
| `GESTAO_IDS` | vazio | IDs (ex.: número do WhatsApp) da gestão, separados por vírgula |
| `FUNCIONARIOS_IDS` | vazio | Lista fixa de colaboradores que recebem os envios automáticos dos turnos, separados por vírgula |
| `TENANT_ID` | `codxis` | Identificador do tenant (multi-tenant) |
| `PORT` | `3111` | Porta do dashboard (painel web da gestão) |
| `HOST` | `127.0.0.1` | Endereço de escuta do dashboard |
| `HORA_CHECKIN` | `10:00` | Hora do lembrete de check-in (manhã) no agendador |
| `HORA_COBRANCA_CHECKIN` | `14:30` | Hora da cobrança de check-in para quem não registrou (início da tarde) |
| `HORA_CHECKOUT` | `16:30` | Hora do check-out + sugestões individuais do colaborador (fim do expediente) |
| `AGENDADOR_ATIVO` | `true` | Liga/desliga o agendador de turnos automáticos |
| `OPENAI_API_KEY` | vazio | Chave do provedor LLM (OpenAI-compatible). Usada tanto na **conversa guiada** (`Dialogo`, perguntas) quanto nas **sugestões inteligentes**. Sem ela, ambos usam fallback |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | URL base da API (OpenAI-compatible: Groq, Together, Ollama, etc.) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modelo usado nos diálogos e nas sugestões |
| `SUGESTOES_ATIVAS` | `true` | Se as sugestões proativas são enviadas após check-out/`/hoje` |

Exemplo com gestão configurada no console:

```powershell
$env:DATABASE_URL="postgres://codxis:codxis@localhost:5433/codxis"; $env:GESTAO_IDS="5511999999999@c.us"; npm run dev:console
```


## Dashboard da gestão (painel web)

Painel local com o visual "GERENTE CODXIS" (azul-marinho/branco/preto) para a gestão visualizar
capacidade, aderência e pendências recorrentes — sem depender do chat.

```powershell
npm run dev:dashboard   # http://127.0.0.1:3111/
```

- Página principal: `http://127.0.0.1:3111/` (cards de estatísticas, tabela por colaborador,
  ranking de aderência e alertas de gestão).
- JSON cru: `http://127.0.0.1:3111/api/relatorio.json`.
- Usa o mesmo banco do bot (`DATABASE_URL`) e o tenant `TENANT_ID`. Enumera `PORT` e `HOST`.

> Ele roda em `127.0.0.1` (só a máquina local) por padrão, sem autenticação. Não exponha na rede
> sem adicionar login/segurança.

## Armadilha conhecida (lock do Chrome)

Se fechar o bot com `Ctrl+C` forçado, o Chrome do whatsapp-web.js pode ficar preso e a próxima
execução falha com:

```
Error: The browser is already running for ...\.wwebjs_auth\session-gerente-codxis
```

Solução: derrubar os processos presos antes de rodar (no PowerShell):

```powershell
Get-Process node,chrome -ErrorAction SilentlyContinue | Stop-Process -Force
npm run dev
```

## Incompatibilidade atual do whatsapp-web.js

A versão `whatsapp-web.js@1.34.7` está desatualizada frente às mudanças recentes do WhatsApp Web.
Sintomas já encontrados:

- `canCheckStatusRankingPosterGating is not a function` ao tentar responder mensagens (especialmente
  para o chat "Eu"). Correção manual já aplicada no `node_modules`: `cannotBeRanked: false` em
  `src/util/Injected/Utils.js`.
- `Protocol error (Runtime.callFunctionOn): Execution context was destroyed` no `initialize`, causado
  por **sessão `.wwebjs_auth` corrompida** ou pelo Chrome do sistema (151) ser novo demais para o
  puppeteer. Correções: apagar `.wwebjs_auth`/`.wwebjs_cache` e fixar `executablePath` no
  `WhatsAppConnector` para o Chrome for Testing (146) que o puppeteer baixa
  (`~\.cache\puppeteer`), em vez do Chrome do sistema.

A rota gratuita por QR é frágil. Para produção prefere-se provedor pago (Z-API/Twilio), já previsto
na seção de andamento. Para validar a lógica do bot sem depender do WhatsApp, use `npm run dev:console`.

## Andamento do projeto (roadmap)

### ✅ Já implementado

**Agente / fluxo**
- ✅ Check-in e check-out diários com máquina de estados, comando `cancelar` e bloqueios
  (check-out sem check-in, check-in/check-out duplicados no dia).
- ✅ **Adendo/aderência**: compara check-out (concluídas/pendentes) com check-in (planejadas);
  calcula taxa de aderência e pendências fora do planejamento.
- ✅ **`/hoje`**: resumo do dia para o colaborador.

**Gestão (além do chat)**
- ✅ Regra de **pendência recorrente**: mesma tarefa pendente por 3+ check-outs seguidos sem
  justificativa → alerta de gestão (`detectarPendenciasRecorrentes` no `CheckInBot`).
- ✅ Métrica de **capacidade** (em tarefas): planejadas vs. concluídas + aderência do período.
- ✅ Comando **`/relatorio`**: relatório agregado da gestão (capacidade, aderência e pendências
  recorrentes, últimos 7 dias).
- ✅ **Restrição de gestão** (`GESTAO_IDS`): `/relatorio` e `/exportar-*` bloqueados para não-gestão.
- ✅ **Alerta proativo**: após cada check-out, avisa automaticamente a gestão sobre pendências recorrentes.
- ✅ **Exportação** `/exportar-csv` e `/exportar-json` dos dados de gestão.
- ✅ **Sugestões inteligentes do gerente** (`src/ai/Sugestoes.ts`): analisa os dados e propõe
  próximos passos para a empresa ou para o colaborador — com LLM (`OPENAI_API_KEY`) ou fallback
  por regras; proativas após check-out/`/hoje` e sob demanda via `/sugestoes`.
- ✅ **Turnos automáticos** (`src/agendar/Scheduler.ts`): dispara nos horários configurados e
  **inicia a conversa guiada de check-in/check-out** automaticamente (sem digitar comando), para a
  lista fixa `FUNCIONARIOS_IDS`, com a cobrança da tarde e as **sugestões individuais** enviadas
  ao próprio colaborador junto com o check-out no fim do expediente.
- ✅ **Conversa guiada com LLM** (`src/ai/Dialogo.ts`): o gerente redige cada pergunta do
  check-in/check-out via ChatGPT, seguindo um roteiro fixo de tópicos (uma pergunta por vez, com
  fallback offline por perguntas prontas — nunca gera loop).

**Infra / arquitetura**
- ✅ **Multi-tenant** (`TENANT_ID` configurável, padrão `codxis`).
- ✅ **Dashboard da gestão** — painel web local "GERENTE CODXIS" (azul-marinho/branco/preto) com
  cards de estatísticas, tabela por colaborador, ranking de aderência e alertas
  (`npm run dev:dashboard` → http://127.0.0.1:3111/).
- ✅ **Relatório de gestão reutilizável** (`src/report/gestao.ts`) compartilhado entre chat e dashboard.
- ✅ Conector de **console** para testar sem WhatsApp (`npm run dev:console`).
- ✅ **Testes automatizados** (`node:test`): 56 testes cobrindo aderência, store, fluxo, pendência
  recorrente, permissão/exportação/alerta proativo, dashboard, sugestões, agendador de turnos e
  conversa guiada (`npm test`).

### ⏳ Pendente (próximos passos, por prioridade)

1. **P1 — Migrar o conector WhatsApp para provedor pago (Z-API/Twilio) na produção.** A rota gratuita
   por QR (`whatsapp-web.js@1.34.7`) está incompatível com o WhatsApp Web atual (ver seção
   "Incompatibilidade atual do whatsapp-web.js"). Para produção, trocar o `WhatsAppConnector` por um
   conector de provedor pago — **sem reescrever** a lógica do bot, graças à camada `ChannelConnector`.
2. **P1 — Validar o fluxo real no WhatsApp** com a chave da OpenAI configurada (ver "Cenários de
   teste"): turno da manhã iniciando check-in guiado, cobrança da tarde e check-out guiado no fim do
   dia, com as perguntas redigidas pelo ChatGPT.
3. **P2 — Endpoint HTTP para disparar os turnos sob demanda** (ex.: um webhook que chama
   `lembrarCheckinTodos`/`fecharDia` fora do horário, útil para testes e integrações externas).
4. **P2 — Autenticação no dashboard web** (login/senha ou token) antes de qualquer exposição em rede.
5. **P3 — Editar/remover tarefas** registradas no check-in.
6. **P3 — Resumo diário semanal** consolidado por e-mail/relatório.

### 💡 Próximas ideias (não comprometidas)

- Notificações/lembretes de check-in/check-out para quem ainda não registrou (fora dos turnos fixos).
- Integração futura com o CRM (ler/exportar tarefas) sem duplicar digitação.
- Novo conector de canal além do WhatsApp (ex.: Telegram) via camada `ChannelConnector`.

## Cenários de teste (validação manual / smoke)

Além dos **56 testes automatizados** (`npm test`), vale validar manualmente o fluxo completo via
`npm run dev:console` (ou WhatsApp). Cenários principais:

**Check-in guiado (turno da manhã)**
1. Com `FUNCIONARIOS_IDS` preenchido, rodar `lembrarCheckinTodos` (ou atingir `HORA_CHECKIN`) →
   o colaborador **recebe a pergunta** sobre as tarefas, sem digitar `/check-in`.
2. Responder com tarefas → aparece a confirmação "✅ Check-in registrado!" e o `/hoje` mostra as planejadas.
3. Quem já fez check-in no dia **não recebe** a pergunta de novo.

**Check-out guiado (turno do fim do dia)**
1. Quem fez check-in mas não fez check-out recebe a pergunta "O que você concluiu hoje?" com as
   **sugestões individuais** do colaborador junto.
2. Fluxo segue concluídas → pendentes → justificativa e registra.
3. Quem **não fez check-in** e quem **já fez check-out** não recebe a pergunta.

**Cobrança da tarde**
1. Quem não fez check-in até `HORA_COBRANCA_CHECKIN` recebe a cobrança.

**Conversa guiada com LLM**
1. Com `OPENAI_API_KEY` preenchida → cada pergunta vem redigida pelo ChatGPT (natural, uma por vez).
2. Sem chave (ou LLM falhando) → cai no **fallback** de perguntas prontas, sem travar nem gerar loop.

**Bloqueios e regras**
- Check-out sem check-in → mensagem de erro.
- Check-in/check-out duplicado no dia → bloqueado com aviso.
- `cancelar` → aborta o fluxo em andamento.
- `GESTAO_IDS` vazio → `/relatorio` e `/exportar-*` bloqueados para todos; sem alertas proativos.
- Pendência recorrente (3+ check-outs seguidos sem justificativa) → alerta proativo para cada gestor.
