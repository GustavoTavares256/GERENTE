import { CheckInStore, todayLocal } from "../store/CheckInStore.js";
import { detectarPendenciasRecorrentes, PendenciaRecorrente } from "../bot/CheckInBot.js";

export interface DadoGestao {
  colaborador: string;
  planejadas: number;
  concluidas: number;
  aderencia: number; // 0-100, -1 quando sem planejamento
  recorrentes: PendenciaRecorrente[];
  horasPlanejadas: number;
  horasConcluidas: number;
  horasPendentes: number;
}

const LIMITE_RECORRENCIA = 3;
const JANELA_DIAS = 7;

export function dataDesde(janelaDias: number = JANELA_DIAS): string {
  const d = new Date();
  d.setDate(d.getDate() - (janelaDias - 1));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Soma as datas dos dias entre `desde` e `ate` (inclusive), no formato YYYY-MM-DD. */
export function gerarDias(desde: string, ate: string): string[] {
  const dias: string[] = [];
  const d = new Date(desde + "T00:00:00Z");
  const fim = new Date(ate + "T00:00:00Z");
  if (Number.isNaN(d.getTime()) || Number.isNaN(fim.getTime())) return [];
  while (d <= fim) {
    dias.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dias;
}

function normalizar(t: string): string {
  return t.trim().toLowerCase();
}

/** Junta todos os mapas de estimativas (tarefa → horas) dos check-ins informados. */
function coletarEstimativas(checkIns: Array<{ tarefas: string; estimativas: string | null }>): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const ci of checkIns) {
    if (!ci.estimativas) continue;
    try {
      const est = JSON.parse(ci.estimativas) as Record<string, number>;
      for (const [tarefa, horas] of Object.entries(est)) {
        if (tarefa) mapa.set(normalizar(tarefa), horas);
      }
    } catch {
      // estimativas inválidas são ignoradas
    }
  }
  return mapa;
}

function horasDeTarefas(tarefas: string[], mapa: Map<string, number>): number {
  const vistos = new Set<string>();
  let total = 0;
  for (const t of tarefas) {
    const key = normalizar(t);
    if (vistos.has(key)) continue;
    vistos.add(key);
    const h = mapa.get(key);
    if (h != null && h > 0) total += h;
  }
  return total;
}

export async function listarColaboradores(
  store: CheckInStore,
  tenantId: string
): Promise<string[]> {
  return store.listColaboradores(tenantId);
}

export async function listarDadosGestao(
  store: CheckInStore,
  tenantId: string,
  desdeStr?: string
): Promise<DadoGestao[]> {
  const desde = desdeStr ?? dataDesde();
  const dados: DadoGestao[] = [];

  for (const colab of await store.listColaboradores(tenantId)) {
    const [checkIns, checkOuts] = await Promise.all([
      store.listCheckIns(tenantId, colab, desde),
      store.listCheckOuts(tenantId, colab, desde),
    ]);

    let planejadas = 0;
    let concluidas = 0;
    for (const ci of checkIns) {
      planejadas += (JSON.parse(ci.tarefas) as string[]).length;
    }
    for (const co of checkOuts) {
      concluidas += (JSON.parse(co.tarefas) as string[]).length;
    }

    const recorrentes = detectarPendenciasRecorrentes(checkOuts, LIMITE_RECORRENCIA);

    const estimativas = coletarEstimativas(checkIns);
    let horasPlanejadas = 0;
    for (const h of estimativas.values()) {
      if (h > 0) horasPlanejadas += h;
    }
    const tarefasConcluidas: string[] = [];
    const tarefasPendentes: string[] = [];
    for (const co of checkOuts) {
      tarefasConcluidas.push(...(JSON.parse(co.tarefas) as string[]));
      if (co.pendentes) {
        tarefasPendentes.push(...(JSON.parse(co.pendentes) as string[]));
      }
    }
    const horasConcluidas = horasDeTarefas(tarefasConcluidas, estimativas);
    const horasPendentes = horasDeTarefas(tarefasPendentes, estimativas);

    dados.push({
      colaborador: colab,
      planejadas,
      concluidas,
      aderencia:
        planejadas === 0 ? -1 : Math.round((concluidas / planejadas) * 100),
      recorrentes,
      horasPlanejadas,
      horasConcluidas,
      horasPendentes,
    });
  }
  return dados;
}

/** Aderência agregada por dia (toda a empresa), para gráfico de tendência. */
export async function listarSerieAderencia(
  store: CheckInStore,
  tenantId: string,
  desdeStr?: string,
  ateStr?: string
): Promise<Array<{ data: string; planejadas: number; concluidas: number; aderencia: number | null }>> {
  const desde = desdeStr ?? dataDesde();
  const ate = ateStr ?? todayLocal();
  const [checkIns, checkOuts] = await Promise.all([
    store.listarCheckInsPorPeriodo(tenantId, desde, ate),
    store.listarCheckOutsPorPeriodo(tenantId, desde, ate),
  ]);

  const porDia = new Map<string, { planejadas: number; concluidas: number }>();
  for (const ci of checkIns) {
    const d = porDia.get(ci.data) ?? { planejadas: 0, concluidas: 0 };
    d.planejadas += (JSON.parse(ci.tarefas) as string[]).length;
    porDia.set(ci.data, d);
  }
  for (const co of checkOuts) {
    const d = porDia.get(co.data) ?? { planejadas: 0, concluidas: 0 };
    d.concluidas += (JSON.parse(co.tarefas) as string[]).length;
    porDia.set(co.data, d);
  }

  return gerarDias(desde, ate).map((data) => {
    const d = porDia.get(data) ?? { planejadas: 0, concluidas: 0 };
    return {
      data,
      planejadas: d.planejadas,
      concluidas: d.concluidas,
      aderencia:
        d.planejadas === 0
          ? null
          : Math.round((d.concluidas / d.planejadas) * 100),
    };
  });
}

export async function listarPendenciasRecorrentes(
  store: CheckInStore,
  tenantId: string,
  desdeStr?: string
): Promise<PendenciaRecorrente[]> {
  const desde = desdeStr ?? dataDesde();
  const todas: PendenciaRecorrente[] = [];
  for (const colab of await store.listColaboradores(tenantId)) {
    const checkOuts = await store.listCheckOuts(tenantId, colab, desde);
    todas.push(
      ...detectarPendenciasRecorrentes(checkOuts, LIMITE_RECORRENCIA)
    );
  }
  return todas;
}

export function toCsv(dados: DadoGestao[]): string {
  const header =
    "colaborador,planejadas,concluidas,aderencia_pct,pendencia_recorrente,horas_planejadas,horas_concluidas,horas_pendentes";
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const linhas = dados.map((d) => {
    const rec = d.recorrentes.map((r) => r.tarefa).join(" | ");
    const ader = d.aderencia < 0 ? "" : String(d.aderencia);
    return `${esc(d.colaborador)},${d.planejadas},${d.concluidas},${ader},${esc(rec)},${d.horasPlanejadas},${d.horasConcluidas},${d.horasPendentes}`;
  });
  return [header, ...linhas].join("\n");
}

export function toJson(dados: DadoGestao[]): string {
  return JSON.stringify(dados, null, 2);
}
