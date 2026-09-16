# Gerente da Codxis — Bot de Check-in/saida

## Visão geral

Bot de IA externo que faz entrada/saida diário de tarefas com colaboradores, registrando
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
  ├── src/bot/CheckInBot.ts              → máquina de estados entrada/saida + aderência + alertas + sugestões
  ├── src/store/CheckInStore.ts          → persistência PostgreSQL (pg)
  ├── src/report/gestao.ts               → agregação de dados de gestão (capacidade/aderência/recorrentes + CSV/JSON)
  ├── src/ai/LLMProvider.ts              → provedor LLM configurável (OpenAI-compatible) — opcional
  ├── src/ai/Sugestoes.ts                → gerador de sugestões inteligentes (LLM + fallback por regras)
  ├── src/ai/Dialogo.ts                  → redator de perguntas guiadas via LLM (entrada/saida)
  ├── src/agendar/Scheduler.ts           → agendador de turnos automáticos (lembretes/cobranças)
  ├── src/agendar/turnos.ts              → definição dos turnos a partir de variáveis de ambiente
  ├── src/agendar/iniciar.ts             → bootstrap do agendador
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

- **Check-in (manhã)**: `/entrada` → "Quais são suas tarefas para hoje?" → registra lista + timestamp.
- **Check-out (tarde)**: `/saida` → "O que você concluiu?" → "O que ficou pendente?" → "Por quê?"
- **Adendo**: compara check-out (concluídas/pendentes) com check-in (planejadas) → taxa de aderência
  e pendências fora do planejamento.
- **Pendência recorrente**: mesma tarefa pendente por 3+ check-outs seguidos sem justificativa →
  alerta de gestão.
- **Relatório**: `/relatorio` agrega por colaborador (capacidade em tarefas + aderência do período +
  pendências recorrentes).
- **Sugestões inteligentes**: `/sugestoes` analisa dados agregados e propõe próximos passos
  (visão de empresa para gestão, visão individual para colaborador).
- **Turnos automáticos**: agendador dispara lembretes/cobranças de check-in e check-out nos
  horários configurados, sem depender de comando.
- **Outros comandos**: `/hoje` (resumo), `cancelar` (aborta fluxo em andamento).

## Subir o banco (PostgreSQL)

O repositório traz um `docker-compose.yml` com PostgreSQL 16 mapeado para a
porta **5433** do host (evita conflito com outros bancos na 5432):

```powershell
docker compose up -d   # http://localhost:5433, usuário/senha/banco: codxis
```

O schema é criado automaticamente pelo `CheckInStore.connect()`.

## Modelo de dados

Tabela `checkins_diarios` no PostgreSQL (banco definido por `DATABASE_URL`,
criado com schema automático na conexão):

- `tenant_id` (default `"codxis"`), `colaborador_id` (id do remetente no canal), `data` (date)
- `tipo`: `check_in` | `check_out`
- `tarefas` (jsonb): no check_in = planejadas; no check_out = concluídas
- `pendentes` (jsonb, só check_out), `justificativa_pendencia` (text, só check_out)
- `criado_em` (timestamptz)

Aderência calculada por agrupamento `(tenant_id, colaborador_id, data)`, comparando check_out vs check_in.

## Comandos

| Comando | Ação |
|---|---|
| `npm run dev` | Inicia o bot no WhatsApp (mostra QR no terminal) |
| `npm run dev:console` | Inicia o bot no terminal (teste sem WhatsApp) |
| `npm run dev:dashboard` | Sobe o painel web da gestão (http://127.0.0.1:3111/) |
| `npm run typecheck` | Verifica tipos (tsc --noEmit) |
| `npm run test` | Roda os testes (node:test — aderência, store, fluxo, pendência, dashboard, sugestões e agendador) |
| `npm run build` | Compila para `dist/` |
| `npm start` | Roda o build compilado |

> Os testes usam PostgreSQL: suba o container com `docker compose up -d` antes de `npm run test`.
> Cada arquivo de teste usa um banco isolado (`codxis_test_*`) criado automaticamente.

## Rodar e testar no WhatsApp

1. `npm install` (dependências de produção: `whatsapp-web.js`, `qrcode-terminal`, `pg`)
2. `npm run dev` → escaneia o QR com o celular (WhatsApp → Aparelhos conectados → Conectar aparelho)
3. Envie mensagens para si mesmo: `/entrada`, depois `/saida`, depois `/hoje`

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
| `/entrada` | todos | Registra as tarefas planejadas do dia (múltiplos check-ins acumulam novas tarefas) |
| `/saida` | todos | Fecha o dia: concluídas, pendentes, justificativa |
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

## Turnos automáticos (agendador)

O gerente **não depende de o usuário digitar comando**: um agendador dispara mensagens
automaticamente nos horários configurados (`Scheduler` em `src/agendar/`). As mensagens vão
somente para os IDs **fixos** de `FUNCIONARIOS_IDS` (não faz descoberta no banco) e para a gestão.

- **Manhã** (`HORA_CHECKIN`, padrão 10:00): lembrete de check-in para todos da lista fixa.
- **Início da tarde** (`HORA_COBRANCA_CHECKIN`, padrão 14:30): cobrança de check-in para quem ainda
  não registrou hoje.
- **Fim do expediente** (`HORA_CHECKOUT`, padrão 16:30): cobrança de check-out para quem ainda não
  fechou o dia + sugestões (visão empresa) para a gestão.
- Desligável com `AGENDADOR_ATIVO=false`. Dispara uma única vez por dia por turno.

## Conversa guiada com LLM

O `CheckInBot` conduz o entrada/saida seguindo um **roteiro fixo de tópicos** (ordem sempre
a mesma), mas o **LLM (ChatGPT) redige cada pergunta** de forma natural (`src/ai/Dialogo.ts`).
- Ordem fixa: check-in pergunta as tarefas; check-out pergunta o que foi concluído, depois as
  pendências, depois o motivo/justificativa.
- **Uma pergunta por vez**: o gerente nunca envia duas mensagens seguidas — sempre aguarda a
  resposta do colaborador (impossível criar loop de perguntas).
- **Fallback offline**: se o LLM falhar ou não houver chave, usa perguntas prontas daquele tópico
  (mesma ordem) — o fluxo nunca trava.

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
| `HORA_CHECKOUT` | `16:30` | Hora do check-out + sugestões para a gestão (fim do expediente) |
| `AGENDADOR_ATIVO` | `true` | Liga/desliga o agendador de turnos automáticos |
| `OPENAI_API_KEY` | vazio | Chave do provedor LLM (OpenAI-compatible). Sem ela, sugestões usam fallback por regras |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | URL base da API (OpenAI-compatible: Groq, Together, Ollama, etc.) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Modelo usado nas sugestões |
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

## ArmadilhA conhecida (lock do Chrome)

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
  (check-out sem check-in, check-out duplicado no dia). Múltiplos check-ins no mesmo dia são
  permitidos e **acumulam** tarefas no plano (aderência considera a soma de todos).
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
- ✅ **Turnos automáticos** (`src/agendar/Scheduler.ts`): dispara lembretes/cobranças de check-in e
  check-out nos horários configurados, sem depender de comando, para a lista fixa `FUNCIONARIOS_IDS`
  + sugestões para a gestão no fim do expediente.
- ✅ **Conversa guiada com LLM** (`src/ai/Dialogo.ts`): o gerente redige cada pergunta do
  entrada/saida via ChatGPT, seguindo um roteiro fixo de tópicos (uma pergunta por vez, com
  fallback offline por perguntas prontas — nunca gera loop).

**Infra / arquitetura**
- ✅ **Multi-tenant** (`TENANT_ID` configurável, padrão `codxis`).
- ✅ **Dashboard da gestão** — painel web local "GERENTE CODXIS" (azul-marinho/branco/preto) com
  cards de estatísticas, tabela por colaborador, ranking de aderência e alertas
  (`npm run dev:dashboard` → http://127.0.0.1:3111/).
- ✅ **Relatório de gestão reutilizável** (`src/report/gestao.ts`) compartilhado entre chat e dashboard.
- ✅ Conector de **console** para testar sem WhatsApp (`npm run dev:console`).
- ✅ **Testes automatizados** (`node:test`): 52 testes cobrindo aderência, store, fluxo, pendência
  recorrente, permissão/exportação/alerta proativo, dashboard, sugestões, agendador de turnos e
  conversa guiada (`npm test`).

### ⏳ Pendente

- **Migrar o conector WhatsApp para provedor pago (Z-API/Twilio) na produção.** A rota gratuita por
  QR (`whatsapp-web.js@1.34.7`) está incompatível com o WhatsApp Web atual (ver seção
  "Incompatibilidade atual do whatsapp-web.js"). Para produção, trocar o `WhatsAppConnector` por um
  conector de provedor pago — **sem reescrever** a lógica do bot, graças à camada `ChannelConnector`.

### 💡 Próximas ideias (não comprometidas)

- Autenticação no dashboard web antes de expô-lo em rede (hoje roda só em `127.0.0.1`, sem login).
- Editar/remover tarefas registradas no check-in.
- Resumo diário semanal por e-mail/relatório consolidado.
- Notificações/lembretes de entrada/saida para quem ainda não registrou.
