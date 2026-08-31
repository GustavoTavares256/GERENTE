import { CheckInBot } from "./bot/CheckInBot.js";
import { CheckInStore } from "./store/CheckInStore.js";
import { ConsoleConnector } from "./channel/ConsoleConnector.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://codxis:codxis@localhost:5432/codxis";

const gestaoIds = (process.env.GESTAO_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const store = await CheckInStore.connect(databaseUrl);
const bot = new CheckInBot(store, {
  gestaoIds,
  tenantId: process.env.TENANT_ID ?? "codxis",
});

const connector = new ConsoleConnector();
bot.onConnect(connector);

console.log("[Gerente da Codxis] Modo console (sem WhatsApp)...");
await connector.start();
