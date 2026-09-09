// Gerador de sugestões inteligentes do Gerente da Codxis.
// Usa um LLM configurável (LLMProvider) quando disponível; caso contrário,
// recai numa heurística determinística por regras.
// Duas visões:
//  - empresa (gestão): próximos passos estratégicos de toda a empresa.
//  - individual (colaborador): próximos passos de produtividade da pessoa.
import { CheckInStore, todayLocal } from "../store/CheckInStore.js";
import { listarDadosGestao, DadoGestao } from "../report/gestao.js";
import { LLMProvider } from "./LLMProvider.js";

export interface Sugestao {
  area: string;
  acao: string;
  prioridade: "alta" | "media" | "baixa";
}

export interface ContextoEmpresa {
  tenantId: string;
  aderenciaGeral: number;
  totalPlanejadas: number;
  totalConcluidas: number;
  semCheckinHoje: string[];
  colaboradores: DadoGestao[];
}

export interface ContextoColaborador {
  nome: string;
  planejadas: number;
  concluidas: number;
  aderencia: number;
  recorrentes: string[];
  checkinHoje: boolean;
  checkoutHoje: boolean;
}

function hojeISO(): string {
  return todayLocal();
}

/** Reúne o contexto da empresa (últimos 7 dias + participação de hoje). */
export async function contextoEmpresa(
  store: CheckInStore,
  tenantId: string
): Promise<ContextoEmpresa> {
  const [dados, todos, comCheckin] = await Promise.all([
    listarDadosGestao(store, tenantId),
    store.listColaboradores(tenantId),
    store.listarColaboradoresComCheckinNaData(tenantId, hojeISO()),
  ]);

  const totalPlanejadas = dados.reduce((a, d) => a + d.planejadas, 0);
  const totalConcluidas = dados.reduce((a, d) => a + d.concluidas, 0);

  const comHoje = new Set(comCheckin);
  const semCheckinHoje = todos.filter((c) => !comHoje.has(c));

  return {
    tenantId,
    aderenciaGeral: totalPlanejadas
      ? Math.round((totalConcluidas / totalPlanejadas) * 100)
      : 0,
    totalPlanejadas,
    totalConcluidas,
    semCheckinHoje,
    colaboradores: dados,
  };
}

/** Reúne o contexto individual de um colaborador. */
export async function contextoColaborador(
  store: CheckInStore,
  tenantId: string,
  colaboradorId: string
): Promise<ContextoColaborador> {
  const [dados, todos, checkinHoje, checkoutHoje] = await Promise.all([
    listarDadosGestao(store, tenantId),
    store.listarColaboradoresComCheckinNaData(tenantId, hojeISO()),
    store.hasCheckIn(tenantId, colaboradorId),
    store.getCheckOut(tenantId, colaboradorId),
  ]);

  const d = dados.find((x) => x.colaborador === colaboradorId) ?? {
    colaborador: colaboradorId,
    planejadas: 0,
    concluidas: 0,
    aderencia: -1,
    recorrentes: [],
    horasPlanejadas: 0,
    horasConcluidas: 0,
    horasPendentes: 0,
  };

  return {
    nome: colaboradorId,
    planejadas: d.planejadas,
    concluidas: d.concluidas,
    aderencia: d.aderencia,
    recorrentes: d.recorrentes.map((r) => r.tarefa),
    checkinHoje: Boolean(checkinHoje),
    checkoutHoje: Boolean(checkoutHoje),
  };
}

// ── Heurística por regras (fallback) ────────────────────────────────────────

export function regrasEmpresa(ctx: ContextoEmpresa): Sugestao[] {
  const sugestoes: Sugestao[] = [];

  if (ctx.semCheckinHoje.length > 0) {
    sugestoes.push({
      area: "participação",
      prioridade: "alta",
      acao: `${ctx.semCheckinHoje.length} colaborador(es) ainda não fizeram o check-in de hoje (${
        ctx.semCheckinHoje.join(", ")
      }). Avaliar lembrete/descobrir o motivo.`,
    });
  }

  const comRecorrente = ctx.colaboradores.filter(
    (d) => d.recorrentes.length > 0
  );
  if (comRecorrente.length > 0) {
    sugestoes.push({
      area: "pendência recorrente",
      prioridade: "alta",
      acao: `${comRecorrente
        .map((d) => `${d.colaborador} (${d.recorrentes.map((r) => r.tarefa).join(", ")})`)
        .join("; ")} têm pendências 3+ dias seguidos. Agendar conversa para destravar ou repriorizar.`,
    });
  }

  if (ctx.totalPlanejadas > 0 && ctx.aderenciaGeral < 60) {
    sugestoes.push({
      area: "capacidade",
      prioridade: "media",
      acao: `Aderência geral está em ${ctx.aderenciaGeral}% (${ctx.totalConcluidas}/${ctx.totalPlanejadas} tarefas). Rever planejamento: pode haver sobrecarga ou estimativas irreais.`,
    });
  }

  return sugestoes;
}

export function regrasColaborador(ctx: ContextoColaborador): Sugestao[] {
  const sugestoes: Sugestao[] = [];

  if (!ctx.checkinHoje) {
    sugestoes.push({
      area: "planejamento",
      prioridade: "alta",
      acao: "Ainda não registrou o check-in de hoje. Planejar as tarefas do dia ajuda a manter o foco e a medir a aderência.",
    });
  } else if (ctx.checkinHoje && !ctx.checkoutHoje) {
    sugestoes.push({
      area: "fechamento",
      prioridade: "media",
      acao: "Fez o check-in, mas ainda não fechou o dia com o check-out.",
    });
  }

  if (ctx.aderencia >= 0 && ctx.aderencia < 60) {
    sugestoes.push({
      area: "aderência",
      prioridade: "media",
      acao: `Sua aderência dos últimos 7 dias está em ${ctx.aderencia}%. Vale revisar o que travou e ajustar o planejamento.`,
    });
  } else if (ctx.aderencia >= 90) {
    sugestoes.push({
      area: "aderência",
      prioridade: "baixa",
      acao: `Ótima aderência (${ctx.aderencia}%) nos últimos 7 dias. Continue assim.`,
    });
  }

  if (ctx.recorrentes.length > 0) {
    sugestoes.push({
      area: "pendência recorrente",
      prioridade: "alta",
      acao: `"${ctx.recorrentes[0]}" está pendente há 3+ dias. Considerar dividir em tarefas menores ou pedir apoio.`,
    });
  }

  return sugestoes;
}

// ── Conversão de texto do LLM em sugestões estruturadas ────────────────────

function parseSugestoes(item: string, area: string): Sugestao {
  const trimmed = item.replace(/^\s*[-*•\d.)]+\s*/, "").trim();
  return { area, acao: trimmed, prioridade: "media" };
}

// ── API pública ────────────────────────────────────────────────────────────

/**
 * Sugestões com visão de empresa (gestão). Usa LLM quando configurado;
 * caso contrário, cai na heurística por regras.
 */
export async function sugestoesEmpresa(
  llm: LLMProvider | null,
  ctx: ContextoEmpresa
): Promise<Sugestao[]> {
  const fallback = regrasEmpresa(ctx);

  if (!llm || !llm.isConfigured) return fallback;

  const sistema =
    "Você é o Gerente da Codxis, um assistente de gestão de uma empresa pequena. " +
    "Com base nos dados agregados (últimos 7 dias), liste próximos passos concretos e acionáveis " +
    "para melhorar a operação. Responda apenas com uma lista em markdown, uma ação por linha. " +
    "Máximo 5 itens. Seja específico sobre colaboradores/tarefas quando os dados indicarem.";

  const linhas = ctx.colaboradores.map(
    (d) =>
      `- ${d.colaborador}: ${d.planejadas} planejadas, ${d.concluidas} concluídas ` +
      `(aderência ${d.aderencia >= 0 ? d.aderencia + "%" : "sem plano"}), ` +
      `recorrentes: ${d.recorrentes.map((r) => r.tarefa).join(", ") || "nenhuma"}`
  );

  const usuario = [
    `Aderência geral: ${ctx.aderenciaGeral}% (${ctx.totalConcluidas}/${ctx.totalPlanejadas} tarefas).`,
    `Colaboradores sem check-in hoje: ${ctx.semCheckinHoje.join(", ") || "nenhum"}.`,
    `Detalhe por colaborador:\n${linhas.join("\n") || "Sem registros."}`,
  ].join("\n");

  try {
    const texto = await llm.complete(sistema, usuario);
    const itens = texto
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const sugestoes = itens.map((l) => parseSugestoes(l, "próximos passos"));
    return sugestoes.length > 0 ? sugestoes.slice(0, 5) : fallback;
  } catch (e) {
    if (e instanceof Error) {
      console.error("[Sugestoes] Erro ao gerar sugestões (empresa):", e.message);
      return fallback;
    }
    throw e;
  }
}

/**
 * Sugestões com visão individual. Usa LLM quando configurado; caso
 * contrário, cai na heurística por regras.
 */
export async function sugestoesColaborador(
  llm: LLMProvider | null,
  ctx: ContextoColaborador
): Promise<Sugestao[]> {
  const fallback = regrasColaborador(ctx);

  if (!llm || !llm.isConfigured) return fallback;

  const sistema =
    "Você é o Gerente da Codxis, um assistente de produtividade de um funcionário. " +
    "Com base nos dados dele (últimos 7 dias), dê próximos passos práticos para ele melhorar a " +
    "produtividade e o planejamento do dia. Responda apenas com uma lista em markdown, uma ação por linha. " +
    "Máximo 3 itens. Seja específico, mas gentil.";

  const usuario = [
    `Colaborador: ${ctx.nome}`,
    `Planejadas: ${ctx.planejadas}, concluídas: ${ctx.concluidas}`,
    `Aderência (7 dias): ${ctx.aderencia >= 0 ? ctx.aderencia + "%" : "sem dados"}`,
    `Pendências recorrentes: ${ctx.recorrentes.join(", ") || "nenhuma"}`,
    `Check-in hoje: ${ctx.checkinHoje ? "feito" : "não feito"}`,
    `Check-out hoje: ${ctx.checkoutHoje ? "feito" : "não feito"}`,
  ].join("\n");

  try {
    const texto = await llm.complete(sistema, usuario);
    const itens = texto
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const sugestoes = itens.map((l) => parseSugestoes(l, "produtividade"));
    return sugestoes.length > 0 ? sugestoes.slice(0, 3) : fallback;
  } catch (e) {
    if (e instanceof Error) {
      console.error("[Sugestoes] Erro ao gerar sugestões (colaborador):", e.message);
      return fallback;
    }
    throw e;
  }
}

export function formatarSugestoes(
  titulo: string,
  sugestoes: Sugestao[]
): string {
  if (sugestoes.length === 0) return "";
  const corpo = sugestoes
    .map((s) => {
      const p = s.prioridade === "alta" ? "🔴" : s.prioridade === "media" ? "🟠" : "🟢";
      return `${p} ${s.acao}`;
    })
    .join("\n");
  return `${titulo}\n${corpo}`;
}
