import { CheckInStore } from "../store/CheckInStore.js";
import { startDashboard } from "./server.js";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://codxis:codxis@localhost:5432/codxis";

const store = await CheckInStore.connect(databaseUrl);
const tenantId = process.env.TENANT_ID ?? "codxis";
const port = Number(process.env.PORT ?? "3111");
const host = process.env.HOST ?? "127.0.0.1";

startDashboard(store, tenantId, { port, host });
