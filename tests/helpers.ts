import { Pool } from "pg";
import { CheckInStore } from "../src/store/CheckInStore.js";

/**
 * URL base do PostgreSQL (definido pelo DATABASE_URL ou padrão local do
 * projeto). Cada arquivo de teste usa um banco dedicado para isolar os
 * dados entre arquivos que rodam em processos paralelos (node:test).
 */
export const BASE_URL = (): string =>
  process.env.DATABASE_URL ?? "postgres://codxis:codxis@localhost:5433/codxis";

function adminUrl(): string {
  const u = new URL(BASE_URL());
  u.pathname = "/postgres";
  return u.toString();
}

/** Cria o banco de teste se ainda não existir. */
async function ensureTestDatabase(dbName: string): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl() });
  try {
    const res = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );
    if ((res.rowCount ?? 0) === 0) {
      // CREATE DATABASE não aceita parâmetro; sanitiza o nome (vem do caller)
      const safe = dbName.replace(/[^a-zA-Z0-9_]/g, "_");
      await admin.query(`CREATE DATABASE "${safe}"`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Conecta um CheckInStore a um banco de teste isolado.
 * `suffix` identifica o arquivo de teste (ex.: "fluxo", "pendencia").
 * Cada chamada limpa a tabela, isolando os testes dentro do arquivo.
 */
export async function connectTestStore(suffix: string): Promise<CheckInStore> {
  const safe = suffix.replace(/[^a-zA-Z0-9_]/g, "_");
  const dbName = `codxis_test_${safe}`;
  await ensureTestDatabase(dbName);
  const u = new URL(BASE_URL());
  u.pathname = `/${dbName}`;
  const store = await CheckInStore.connect(u.toString());
  await store.reset();
  return store;
}
