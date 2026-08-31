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
  ├── src/bot/CheckInBot.ts              → máquina de estados check-in/check-out + aderência + alertas
  ├── src/store/CheckInStore.ts          → persistência SQLite (better-sqlite3)
  ├── src/report/gestao.ts               → agregação de dados de gestão (capacidade/aderência/recorrentes + CSV/JSON)
  ├── src/dashboard/server.ts            → servidor HTTP do painel web de gestão
  ├── src/dashboard/start-dashboard.ts   → entrypoint do dashboard
  ├── src/index.ts                       → entrypoint WhatsApp
  └── src/index-console.ts               → entrypoint console (teste)
```

**Camada de abstração de canal** (`ChannelConnector`): a lógica do bot só conhece esta interface.
Trocar de canal (WhatsApp → Telegram, etc.) = criar novo conector, sem tocar no `CheckInBot`.

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

## Modelo de dados

Tabela `checkins_diarios` no SQLite (`data/checkins.db`), espelhando o schema original para o
PostgreSQL da especificação:

- `tenant_id` (default `"codxis"`), `colaborador_id` (id do remetente no canal), `data` (date)
- `tipo`: `check_in` | `check_out`
- `tarefas` (jsonb): no check_in = planejadas; no check_out = concluídas
- `pendentes` (jsonb, só check_out), `justificativa_pendencia` (text, só check_out)
- `criado_em` (timestamp)

Aderência calculada por agrupamento `(tenant_id, colaborador_id, data)`, comparando check_out vs check_in.

## Comandos

| Comando | Ação |
|---|---|
| `npm run dev` | Inicia o bot no WhatsApp (mostra QR no terminal) |
| `npm run dev:console` | Inicia o bot no terminal (teste sem WhatsApp) |
| `npm run dev:dashboard` | Sobe o painel web da gestão (http://127.0.0.1:3111/) |
| `npm run typecheck` | Verifica tipos (tsc --noEmit) |
| `npm run test` | Roda os testes (node:test — aderência, store, fluxo, pendência e dashboard) |
| `npm run build` | Compila para `dist/` |
| `npm start` | Roda o build compilado |

## Rodar e testar no WhatsApp

1. `npm install` (dependências de produção: `whatsapp-web.js`, `qrcode-terminal`, `better-sqlite3`)
2. `npm run dev` → escaneia o QR com o celular (WhatsApp → Aparelhos conectados → Conectar aparelho)
3. Envie mensagens para si mesmo: `/check-in`, depois `/check-out`, depois `/hoje`

## Testar sem WhatsApp (console)

Para validar toda a lógica do agente sem depender do WhatsApp, use o conector de console:

```powershell
npm run dev:console
```

O bot conversa pelo terminal (mesma máquina de estados e store SQLite). Digite os mesmos comandos. Para sair, escreva `sair`.

> Atenção: como usa o mesmo DB (`data/checkins.db`), registros criados no console aparecem no WhatsApp e vice-versa. Use `DATA_PATH` para isolar: `$env:DATA_PATH="./data/teste.db"; npm run dev:console`.

## Comandos do chat

| Comando | Quem | Ação |
|---|---|---|
| `/check-in` (`/checkin`) | todos | Registra as tarefas planejadas do dia |
| `/check-out` (`/checkout`) | todos | Fecha o dia: concluídas, pendentes, justificativa |
| `/hoje` (`/resumo`) | todos | Resumo de hoje (planejadas + aderência) |
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

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `DATA_PATH` | `./data/checkins.db` | Caminho do banco SQLite |
| `GESTAO_IDS` | vazio | IDs (ex.: número do WhatsApp) da gestão, separados por vírgula |
| `TENANT_ID` | `codxis` | Identificador do tenant (multi-tenant) |
| `PORT` | `3111` | Porta do dashboard (painel web da gestão) |
| `HOST` | `127.0.0.1` | Endereço de escuta do dashboard |

Exemplo com gestão configurada no console:

```powershell
$env:DATA_PATH="./data/teste.db"; $env:GESTAO_IDS="5511999999999@c.us"; npm run dev:console
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
- Usa o mesmo banco do bot (`DATA_PATH`) e o tenant `TENANT_ID`. Enumera `PORT`, `HOST` e `DATA_PATH`.

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

**Infra / arquitetura**
- ✅ **Multi-tenant** (`TENANT_ID` configurável, padrão `codxis`).
- ✅ **Dashboard da gestão** — painel web local "GERENTE CODXIS" (azul-marinho/branco/preto) com
  cards de estatísticas, tabela por colaborador, ranking de aderência e alertas
  (`npm run dev:dashboard` → http://127.0.0.1:3111/).
- ✅ **Relatório de gestão reutilizável** (`src/report/gestao.ts`) compartilhado entre chat e dashboard.
- ✅ Conector de **console** para testar sem WhatsApp (`npm run dev:console`).
- ✅ **Testes automatizados** (`node:test`): 30 testes cobrindo aderência, store, fluxo, pendência
  recorrente, permissão/exportação/alerta proativo e dashboard (`npm test`).

### ⏳ Pendente

- **Migrar o conector WhatsApp para provedor pago (Z-API/Twilio) na produção.** A rota gratuita por
  QR (`whatsapp-web.js@1.34.7`) está incompatível com o WhatsApp Web atual (ver seção
  "Incompatibilidade atual do whatsapp-web.js"). Para produção, trocar o `WhatsAppConnector` por um
  conector de provedor pago — **sem reescrever** a lógica do bot, graças à camada `ChannelConnector`.

### 💡 Próximas ideias (não comprometidas)

- Autenticação no dashboard web antes de expô-lo em rede (hoje roda só em `127.0.0.1`, sem login).
- Editar/remover tarefas registradas no check-in.
- Resumo diário semanal por e-mail/relatório consolidado.
- Notificações/lembretes de check-in/check-out para quem ainda não registrou.
