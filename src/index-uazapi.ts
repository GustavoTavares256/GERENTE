import "dotenv/config";
import { UazapiConnector } from "./channel/UazapiConnector.js";
import { CheckInBot } from "./bot/CheckInBot.js";
import { CheckInStore } from "./store/CheckInStore.js";
import { LLMProvider } from "./ai/LLMProvider.js";
import { iniciarAgendador } from "./agendar/iniciar.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://codxis:codxis@localhost:5433/codxis";

const ids = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const gestaoIds = ids(process.env.GESTAO_IDS);
const funcionariosIds = ids(process.env.FUNCIONARIOS_IDS);

const store = await CheckInStore.connect(databaseUrl);
const bot = new CheckInBot(store, {
  gestaoIds,
  funcionariosIds,
  tenantId: process.env.TENANT_ID ?? "codxis",
  llm: new LLMProvider(),
});

const connector: UazapiConnector = new UazapiConnector();
bot.onConnect(connector);
iniciarAgendador(bot, connector);

console.log("[Gerente da Codxis] Iniciando via UAZAPI...");
await connector.start();

// Mantém o processo vivo enquanto o SSE estiver ativo.
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
