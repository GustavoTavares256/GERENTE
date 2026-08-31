import { CheckInStore } from "../store/CheckInStore.js";
import { detectarPendenciasRecorrentes, PendenciaRecorrente } from "../bot/CheckInBot.js";

export interface DadoGestao {
  colaborador: string;
  planejadas: number;
  concluidas: number;
  aderencia: number; // 0-100, -1 quando sem planejamento
  recorrentes: PendenciaRecorrente[];
}

const LIMITE_RECORRENCIA = 3;
const JANELA_DIAS = 7;

export function dataDesde(janelaDias: number = JANELA_DIAS): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - (janelaDias - 1));
  return d.toISOString().slice(0, 10);
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

    dados.push({
      colaborador: colab,
      planejadas,
      concluidas,
      aderencia:
        planejadas === 0 ? -1 : Math.round((concluidas / planejadas) * 100),
      recorrentes,
    });
  }
  return dados;
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
    "colaborador,planejadas,concluidas,aderencia_pct,pendencia_recorrente";
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const linhas = dados.map((d) => {
    const rec = d.recorrentes.map((r) => r.tarefa).join(" | ");
    const ader = d.aderencia < 0 ? "" : String(d.aderencia);
    return `${esc(d.colaborador)},${d.planejadas},${d.concluidas},${ader},${esc(rec)}`;
  });
  return [header, ...linhas].join("\n");
}

export function toJson(dados: DadoGestao[]): string {
  return JSON.stringify(dados, null, 2);
}
