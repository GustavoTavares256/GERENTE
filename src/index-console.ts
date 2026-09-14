import "dotenv/config";
import { CheckInBot } from "./bot/CheckInBot.js";
import { CheckInStore } from "./store/CheckInStore.js";
import { ConsoleConnector } from "./channel/ConsoleConnector.js";
import { LLMProvider } from "./ai/LLMProvider.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://codxis:codxis@localhost:5433/codxis";

const ids = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const gestaoIds = [...ids(process.env.GESTAO_IDS), "console-local"];
const funcionariosIds = [...ids(process.env.FUNCIONARIOS_IDS), "console-local"];

const store = await CheckInStore.connect(databaseUrl);
const bot = new CheckInBot(store, {
  gestaoIds,
  funcionariosIds,
  tenantId: process.env.TENANT_ID ?? "codxis",
  llm: new LLMProvider(),
});

const connector = new ConsoleConnector();
bot.onConnect(connector);

console.log("[Gerente da Codxis] Modo console (sem WhatsApp, sem agendador)...");
await connector.start();
