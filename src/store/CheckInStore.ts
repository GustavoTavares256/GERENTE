import { Pool, PoolClient } from "pg";

/** Retorna a data local no formato YYYY-MM-DD (compatível com o agendador). */
export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

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
  /** Mapa "tarefa (texto) → horas estimadas" registrado no check-in (opcional). */
  estimativas: string | null;
}

interface CheckInRow {
  id: string;
  tenant_id: string;
  colaborador_id: string;
  data: Date | string;
  tipo: "check_in" | "check_out";
  tarefas: unknown;
  pendentes: unknown;
  justificativa_pendencia: string | null;
  criado_em: unknown;
  estimativas_horas: unknown;
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
  estimativas_horas JSONB,
  criado_em TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checkins_colaborador_data
  ON checkins_diarios (tenant_id, colaborador_id, data);
`;

function jsonText(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v ?? null);
}

function isoDate(v: unknown): string {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const day = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  return String(v ?? "").slice(0, 10);
}

function isoDateTime(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? "");
}

function toRecord(row: CheckInRow): CheckInRecord {
  return {
    id: Number(row.id),
    tenantId: row.tenant_id,
    colaboradorId: row.colaborador_id,
    data: isoDate(row.data),
    tipo: row.tipo,
    tarefas: jsonText(row.tarefas ?? "[]"),
    pendentes: row.pendentes == null ? null : jsonText(row.pendentes),
    justificativa_pendencia: row.justificativa_pendencia,
    criadoEm: isoDateTime(row.criado_em),
    estimativas:
      row.estimativas_horas == null
        ? null
        : jsonText(row.estimativas_horas ?? "{}"),
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
    await CheckInStore.ensureColumns(pool);
    return new CheckInStore(pool);
  }

  /** Garante colunas adicionadas em versões posteriores (migrações idempotentes). */
  private static async ensureColumns(pool: Pool): Promise<void> {
    const colunas = [
      { nome: "estimativas_horas", ddl: "JSONB" },
    ];
    for (const c of colunas) {
      const res = await pool.query(
        `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'checkins_diarios' AND column_name = $1`,
        [c.nome]
      );
      if ((res.rowCount ?? 0) === 0) {
        await pool.query(`ALTER TABLE checkins_diarios ADD COLUMN ${c.nome} ${c.ddl}`);
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Apaga todos os registros (usado pelos testes para isolar cenários). */
  async reset(): Promise<void> {
    await this.pool.query("TRUNCATE checkins_diarios");
  }

  /** Insere um registro arbitrário (usado pelos testes para semear históricos). */
  async seedRecord(input: {
    tenantId: string;
    colaboradorId: string;
    data: string;
    tipo: "check_in" | "check_out";
    tarefas: string[];
    pendentes?: string[];
    justificativa?: string | null;
    estimativas?: Record<string, number>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkins_diarios
        (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, estimativas_horas, criado_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.tenantId,
        input.colaboradorId,
        input.data,
        input.tipo,
        JSON.stringify(input.tarefas),
        input.pendentes ? JSON.stringify(input.pendentes) : null,
        input.justificativa ?? null,
        input.estimativas ? JSON.stringify(input.estimativas) : null,
        input.data + "T18:00:00.000Z",
      ]
    );
  }

  private today(): string {
    return todayLocal();
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
    tarefas: string[],
    estimativas?: Record<string, number>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkins_diarios
        (tenant_id, colaborador_id, data, tipo, tarefas, estimativas_horas, criado_em)
       VALUES ($1, $2, $3, 'check_in', $4, $5, $6)`,
      [
        tenantId,
        colaboradorId,
        this.today(),
        JSON.stringify(tarefas),
        estimativas ? JSON.stringify(estimativas) : null,
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
    const todos = await this.getCheckIns(tenantId, colaboradorId);
    return todos[todos.length - 1] ?? null;
  }

  /** Todos os check-ins de hoje, em ordem de registro (permite múltiplos check-ins acumulados). */
  async getCheckIns(
    tenantId: string,
    colaboradorId: string
  ): Promise<CheckInRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND colaborador_id = $2 AND data = $3 AND tipo = 'check_in'
       ORDER BY id ASC`,
      [tenantId, colaboradorId, this.today()]
    );
    return (res.rows as CheckInRow[]).map(toRecord);
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

  /** Colaboradores que já fizeram check-in na data informada. */
  async listarColaboradoresComCheckinNaData(
    tenantId: string,
    data: string
  ): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT colaborador_id FROM checkins_diarios
       WHERE tenant_id = $1 AND tipo = 'check_in' AND data = $2`,
      [tenantId, data]
    );
    return (res.rows as Array<{ colaborador_id: string }>).map(
      (r) => r.colaborador_id
    );
  }

  /** Colaboradores que já fizeram check-out na data informada. */
  async listarColaboradoresComCheckoutNaData(
    tenantId: string,
    data: string
  ): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT DISTINCT colaborador_id FROM checkins_diarios
       WHERE tenant_id = $1 AND tipo = 'check_out' AND data = $2`,
      [tenantId, data]
    );
    return (res.rows as Array<{ colaborador_id: string }>).map(
      (r) => r.colaborador_id
    );
  }

  /** Datas e horários dos check-ins de hoje (timeline de participação). */
  async listarCheckinsHoje(tenantId: string): Promise<Array<{ colaboradorId: string; criadoEm: string }>> {
    const res = await this.pool.query(
      `SELECT colaborador_id, criado_em FROM checkins_diarios
       WHERE tenant_id = $1 AND tipo = 'check_in' AND data = $2
       ORDER BY id ASC`,
      [tenantId, this.today()]
    );
    return (res.rows as Array<{ colaborador_id: string; criado_em: Date }>).map(
      (r) => ({
        colaboradorId: r.colaborador_id,
        criadoEm: isoDateTime(r.criado_em),
      })
    );
  }

  /** Datas e horários dos check-outs de hoje (timeline de participação). */
  async listarCheckoutsHoje(tenantId: string): Promise<Array<{ colaboradorId: string; criadoEm: string }>> {
    const res = await this.pool.query(
      `SELECT colaborador_id, criado_em FROM checkins_diarios
       WHERE tenant_id = $1 AND tipo = 'check_out' AND data = $2
       ORDER BY id ASC`,
      [tenantId, this.today()]
    );
    return (res.rows as Array<{ colaborador_id: string; criado_em: Date }>).map(
      (r) => ({
        colaboradorId: r.colaborador_id,
        criadoEm: isoDateTime(r.criado_em),
      })
    );
  }

  /** Todos os check-ins do tenant num período (série temporal agregada). */
  async listarCheckInsPorPeriodo(
    tenantId: string,
    desde: string,
    ate?: string
  ): Promise<CheckInRecord[]> {
    return this.listarPorPeriodo(tenantId, "check_in", desde, ate);
  }

  /** Todos os check-outs do tenant num período (série temporal agregada). */
  async listarCheckOutsPorPeriodo(
    tenantId: string,
    desde: string,
    ate?: string
  ): Promise<CheckInRecord[]> {
    return this.listarPorPeriodo(tenantId, "check_out", desde, ate);
  }

  private async listarPorPeriodo(
    tenantId: string,
    tipo: "check_in" | "check_out",
    desde: string,
    ate?: string
  ): Promise<CheckInRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM checkins_diarios
       WHERE tenant_id = $1 AND tipo = $2 AND data >= $3
         AND ($4::date IS NULL OR data <= $4::date)
       ORDER BY data ASC, id ASC`,
      [tenantId, tipo, desde, ate ?? null]
    );
    return (res.rows as CheckInRow[]).map(toRecord);
  }
}

export type { Pool, PoolClient };
