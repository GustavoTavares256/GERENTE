import { Pool, PoolClient } from "pg";

export interface CheckInRecord {
  id: number;
  tenantId: string;
  colaboradorId: string;
  data: string;
  tipo: "check_in" | "check_out";
  tarefas: string;
  pendentes: string | null;
  justificativa_pendencia: string | null;
  criadoEm: string;
}

interface CheckInRow {
  id: string;
  tenant_id: string;
  colaborador_id: string;
  data: string;
  tipo: "check_in" | "check_out";
  tarefas: unknown;
  pendentes: unknown;
  justificativa_pendencia: string | null;
  criado_em: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkins_diarios (
  id BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  colaborador_id TEXT NOT NULL,
  data DATE NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('check_in', 'check_out')),
  tarefas JSONB NOT NULL,
  pendentes JSONB,
  justificativa_pendencia TEXT,
  criado_em TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkins_colaborador_data
  ON checkins_diarios (tenant_id, colaborador_id, data);
`;

function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v ?? null);
}

function toRecord(row: CheckInRow): CheckInRecord {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    colaboradorId: row.colaborador_id,
    data: row.data.slice(0, 10),
    tipo: row.tipo,
    tarefas: jsonText(row.tarefas ?? "[]"),
    pendentes: row.pendentes == null ? null : jsonText(row.pendentes),
    justificativa_pendencia: row.justificativa_pendencia,
    criadoEm: row.criado_em,
  };
}

export class CheckInStore {
  private pool: Pool;

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static async connect(connectionString: string): Promise<CheckInStore> {
    const pool = new Pool({
      connectionString,
      max: 10,
    });
    // valida a conexão antes de prosseguir
    await pool.query("SELECT 1");
    await pool.query(SCHEMA);
    return new CheckInStore(pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  async hasCheckIn(tenantId: string, colaboradorId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND data = $3 AND tipo = 'check_in'
       LIMIT 1`,
      [tenantId, colaboradorId, this.today()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async recordCheckIn(
    tenantId: string,
    colaboradorId: string,
    tarefas: string[]
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkins_diarios
        (tenant_id, colaborador_id, data, tipo, tarefas, criado_em)
       VALUES ($1, $2, $3, 'check_in', $4, $5)`,
      [
        tenantId,
        colaboradorId,
        this.today(),
        JSON.stringify(tarefas),
        new Date().toISOString(),
      ]
    );
  }

  async hasCheckOut(tenantId: string, colaboradorId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND data = $3 AND tipo = 'check_out'
       LIMIT 1`,
      [tenantId, colaboradorId, this.today()]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getCheckIn(
    tenantId: string,
    colaboradorId: string
  ): Promise<CheckInRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND data = $3 AND tipo = 'check_in'
       LIMIT 1`,
      [tenantId, colaboradorId, this.today()]
    );
    const row = res.rows[0] as CheckInRow | undefined;
    return row ? toRecord(row) : null;
  }

  async getCheckOut(
    tenantId: string,
    colaboradorId: string
  ): Promise<CheckInRecord | null> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND data = $3 AND tipo = 'check_out'
       LIMIT 1`,
      [tenantId, colaboradorId, this.today()]
    );
    const row = res.rows[0] as CheckInRow | undefined;
    return row ? toRecord(row) : null;
  }

  async recordCheckOut(
    tenantId: string,
    colaboradorId: string,
    tarefasConcluidas: string[],
    pendentes: string[],
    justificativa: string | null
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkins_diarios
        (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
       VALUES ($1, $2, $3, 'check_out', $4, $5, $6, $7)`,
      [
        tenantId,
        colaboradorId,
        this.today(),
        JSON.stringify(tarefasConcluidas),
        JSON.stringify(pendentes),
        justificativa,
        new Date().toISOString(),
      ]
    );
  }

  async listCheckOuts(
    tenantId: string,
    colaboradorId: string,
    desde: string
  ): Promise<CheckInRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND tipo = 'check_out' AND data >= $3
       ORDER BY data ASC`,
      [tenantId, colaboradorId, desde]
    );
    return (res.rows as CheckInRow[]).map(toRecord);
  }

  async listCheckIns(
    tenantId: string,
    colaboradorId: string,
    desde: string
  ): Promise<CheckInRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND tipo = 'check_in' AND data >= $3
       ORDER BY data ASC`,
      [tenantId, colaboradorId, desde]
    );
    return (res.rows as CheckInRow[]).map(toRecord);
  }

  async listColaboradores(tenantId: string): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT colaborador_id FROM checkins_diarios
       WHERE tenant_id = $1 ORDER BY colaborador_id`,
      [tenantId]
    );
    return (res.rows as Array<{ colaborador_id: string }>).map(
      (r) => r.colaborador_id
    );
  }
}

export type { Pool, PoolClient };
