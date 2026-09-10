import "dotenv/config";
import { CheckInStore } from "../store/CheckInStore.js";
import { startDashboard } from "./server.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://codxis:codxis@localhost:5433/codxis";

const store = await CheckInStore.connect(databaseUrl);
const tenantId = process.env.TENANT_ID ?? "codxis";
const port = Number(process.env.PORT ?? "3111");
const host = process.env.HOST ?? "127.0.0.1";

const metaAderencia = Number(process.env.META_ADERENCIA ?? "90");
const jornadaSemanalHoras = Number(process.env.JORNADA_SEMANAL_HORAS ?? "40");

const funcionariosIds = (process.env.FUNCIONARIOS_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

startDashboard(store, tenantId, {
  port,
  host,
  metaAderencia: Number.isFinite(metaAderencia) ? metaAderencia : 90,
  jornadaSemanalHoras: Number.isFinite(jornadaSemanalHoras)
    ? jornadaSemanalHoras
    : 40,
  horaCheckin: process.env.HORA_CHECKIN ?? "10:00",
  horaCheckout: process.env.HORA_CHECKOUT ?? "16:30",
  funcionariosIds,
});