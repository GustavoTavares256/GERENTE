import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { CheckInStore, todayLocal } from "../store/CheckInStore.js";
import {
  dataDesde,
  listarDadosGestao,
  DadoGestao,
  listarSerieAderencia,
  toJson,
  gerarDias,
} from "../report/gestao.js";
import { PendenciaRecorrente } from "../bot/CheckInBot.js";

export interface DashboardOptions {
  port: number;
  host?: string;
  /** Meta semanal de aderência (%) para ranking/metas. Padrão: 90. */
  metaAderencia?: number;
  /** Jornada semanal em horas para carga vs. folga. Padrão: 40. */
  jornadaSemanalHoras?: number;
  /** Horário previsto do turno de check-in (HH:MM) para cálculo de atraso. Padrão: 10:00. */
  horaCheckin?: string;
  /** Horário previsto do turno de check-out (HH:MM) para cálculo de atraso. Padrão: 16:30. */
  horaCheckout?: string;
  /** Lista fixa de colaboradores da empresa (timeline de participação). */
  funcionariosIds?: string[];
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function aderClass(ader: number): string {
  if (ader < 0) return "none";
  if (ader >= 90) return "ok";
  if (ader >= 60) return "warn";
  return "bad";
}

function aderLabel(ader: number): string {
  if (ader < 0) return "—";
  return `${ader}%`;
}

function aderBar(ader: number): string {
  if (ader < 0) return "";
  const status = aderClass(ader);
  return `<div class="barwrap"><div class="bar ${status}" style="width:${Math.max(
    ader,
    4
  )}%"></div></div>`;
}

function fmtHoras(h: number): string {
  if (!h || h <= 0) return "—";
  return `${String(h).replace(".", ",")}h`;
}

// ── Período (filtro 7/14/30 dias ou faixa personalizada) ────────────────────

interface Periodo {
  desde: string;
  ate: string;
  janela: string; // "7" | "14" | "30" | "custom"
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function parsePeriodo(q: URLSearchParams): Periodo {
  const hoje = todayLocal();
  const desdeP = q.get("desde");
  const ateP = q.get("ate");
  if (desdeP && RE_DATA.test(desdeP)) {
    const ate = ateP && RE_DATA.test(ateP) ? ateP : hoje;
    return { desde: desdeP, ate, janela: "custom" };
  }
  const janela = q.get("janela");
  const dias = janela === "14" ? 14 : janela === "30" ? 30 : 7;
  return { desde: dataDesde(dias), ate: hoje, janela: String(dias) };
}

function periodoQs(p: Periodo): string {
  return p.janela === "custom" ? `desde=${p.desde}&ate=${p.ate}` : `janela=${p.janela}`;
}

// ── Participação de hoje (timeline) ─────────────────────────────────────────

function horaLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function minutosPara(hhmm: string): number {
  const [h, m] = hhmm.split(":").map((n) => Number(n));
  return (h || 0) * 60 + (m || 0);
}

function atrasoLabel(previsto: string, registrado: string): string {
  const min = minutosPara(registrado) - minutosPara(previsto);
  if (min <= 0) return "no horário";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0
    ? `atraso ${h}h${m > 0 ? String(m).padStart(2, "0") : ""}`
    : `atraso ${m}min`;
}

interface Participacao {
  colaborador: string;
  checkin: { hora: string } | null;
  checkout: { hora: string } | null;
  aderencia: number | null;
}

async function montarTimeline(
  store: CheckInStore,
  tenantId: string,
  opts: DashboardOptions,
  dados: DadoGestao[]
): Promise<Participacao[]> {
  const [checkins, checkouts] = await Promise.all([
    store.listarCheckinsHoje(tenantId),
    store.listarCheckoutsHoje(tenantId),
  ]);
  const horaCi = new Map(checkins.map((c) => [c.colaboradorId, horaLocal(c.criadoEm)]));
  const horaCo = new Map(checkouts.map((c) => [c.colaboradorId, horaLocal(c.criadoEm)]));

  const roster = new Set(opts.funcionariosIds ?? []);
  for (const c of await store.listColaboradores(tenantId)) roster.add(c);
  if (roster.size === 0) return [];

  const aderencia = new Map(dados.map((d) => [d.colaborador, d.aderencia]));
  return [...roster]
    .map((colab) => ({
      colaborador: colab,
      checkin: horaCi.has(colab) ? { hora: horaCi.get(colab)! } : null,
      checkout: horaCo.has(colab) ? { hora: horaCo.get(colab)! } : null,
      aderencia: aderencia.get(colab) ?? null,
    }))
    .sort((a, b) => Number(a.checkin === null) - Number(b.checkin === null));
}

// ── Gráficos SVG (sem biblioteca externa) ───────────────────────────────────

const CHART_W = 640;
const CHART_H = 200;
const PAD_L = 36;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 24;

/** Gráfico de linha: aderência geral por dia no período. */
function serieChartSVG(
  serie: Array<{ data: string; aderencia: number | null }>
): string {
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const n = serie.length;
  const x = (i: number): number =>
    n === 1 ? PAD_L + innerW / 2 : PAD_L + (i * innerW) / (n - 1);
  const y = (v: number): number => PAD_T + ((100 - v) * innerH) / 100;

  let grid = "";
  for (const g of [0, 25, 50, 75, 100]) {
    grid += `<line x1="${PAD_L}" y1="${y(g)}" x2="${CHART_W - PAD_R}" y2="${y(g)}" stroke="#eef1f6" stroke-width="1"/>`;
    grid += `<text x="${PAD_L - 6}" y="${y(g) + 4}" text-anchor="end" font-size="10" fill="#94a3b8">${g}%</text>`;
  }

  const pts = serie.map((s, i) => ({ x: x(i), y: s.aderencia == null ? null : y(s.aderencia), s }));
  const linha = pts
    .filter((p) => p.y != null)
    .map((p) => `${p.x.toFixed(1)},${p.y!.toFixed(1)}`)
    .join(" ");
  const pontos = pts
    .filter((p) => p.y != null)
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y!.toFixed(1)}" r="3.5" fill="#3b82f6" stroke="#fff" stroke-width="1.5"/>`
    )
    .join("");

  const ticks: typeof pts = [];
  if (n > 0) {
    const qtd = Math.min(n, 6);
    for (let k = 0; k < qtd; k++) {
      const idx = k === qtd - 1 ? n - 1 : Math.round((k * (n - 1)) / (qtd - 1));
      ticks.push(pts[idx]);
    }
  }
  const labels = ticks
    .map((p) => {
      const dias = p.s.data.slice(5);
      let texto = `${dias}`;
      if (p.s.aderencia != null) texto += ` (${p.s.aderencia}%)`;
      return `<text x="${p.x}" y="${CHART_H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${esc(texto)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="Aderência por dia" style="width:100%;height:auto;font-family:Inter,system-ui,sans-serif">
    ${grid}
    <polyline points="${linha}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    ${pontos}
    ${labels}
  </svg>`;
}

/** Gráfico de barras: carga planejada (base) vs. concluída (verde) por colaborador. */
function cargaChartSVG(dados: DadoGestao[]): string {
  if (dados.length === 0) return `<p class="empty-sm">Sem dados no período.</p>`;
  const innerW = CHART_W - PAD_L - PAD_R;
  const innerH = CHART_H - PAD_T - PAD_B;
  const max = Math.max(1, ...dados.map((d) => d.planejadas));
  const step = innerW / dados.length;
  const bw = Math.max(10, step * 0.55);

  const barras = dados
    .map((d, i) => {
      const x = PAD_L + step * i + (step - bw) / 2;
      const hPlan = (d.planejadas / max) * innerH;
      const hConc = (d.concluidas / max) * innerH;
      const nome = d.colaborador.length > 12 ? d.colaborador.slice(0, 11) + "…" : d.colaborador;
      return `
        <rect x="${x.toFixed(1)}" y="${(PAD_T + innerH - hPlan).toFixed(1)}" width="${bw.toFixed(1)}" height="${hPlan.toFixed(1)}" rx="3" fill="#14263f"/>
        <rect x="${x.toFixed(1)}" y="${(PAD_T + innerH - hConc).toFixed(1)}" width="${bw.toFixed(1)}" height="${hConc.toFixed(1)}" rx="3" fill="#16a34a" opacity="${hConc > 0 ? 0.9 : 1}"/>
        <text x="${(x + bw / 2).toFixed(1)}" y="${PAD_T + innerH + 14}" text-anchor="middle" font-size="9" fill="#64748b">${esc(nome)}</text>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="Carga por colaborador" style="width:100%;height:auto;font-family:Inter,system-ui,sans-serif">
    ${barras}
    <text x="${PAD_L}" y="${PAD_T - 2}" font-size="10" fill="#94a3b8">máx ${max} tarefas</text>
  </svg>`;
}

/** Detalhe da pendência recorrente com status por dia (justificada ou não). */
function recHtml(r: PendenciaRecorrente): string {
  const semJust = r.dias.map((d) => esc(d.slice(5))).join(", ");
  const just = r.diasJustificados.length
    ? `<span class="pill pill-ok">just. em ${r.diasJustificados.map((d) => esc(d.slice(5))).join(", ")}</span>`
    : "";
  return `<span class="pill pill-bad" title="Dias sem justificativa">${esc(r.tarefa)} · ${semJust}</span>${just}`;
}

// ── Ranking e metas ─────────────────────────────────────────────────────────

const MEDALHAS = ["🥇", "🥈", "🥉"];

function rankHtml(dados: DadoGestao[], meta: number): string {
  const ordenados = [...dados].sort((a, b) => b.aderencia - a.aderencia);
  if (ordenados.length === 0) {
    return `<div class="no-alert">Sem dados no período.</div>`;
  }
  return ordenados
    .map((d, i) => {
      const medalha = i < 3 ? `<span class="medalha">${MEDALHAS[i]}</span>` : "";
      const val = d.aderencia < 0 ? "—" : `${d.aderencia}%`;
      const cls = d.aderencia >= meta ? "ok" : d.aderencia >= 60 ? "warn" : d.aderencia < 0 ? "muted" : "bad";
      return `<div class="rank-item">
        <div class="rank-pos ${i === 0 ? "t1" : ""}">${i + 1}</div>
        ${medalha}
        <div class="rank-name">${esc(d.colaborador)}</div>
        <div class="rank-val ${cls}">${val}</div>
      </div>`;
    })
    .join("\n");
}

// ── Carga vs. folga (capacidade em horas) ───────────────────────────────────

function cargaHtml(dados: DadoGestao[], jornada: number): string {
  const comHoras = dados.filter((d) => d.horasPlanejadas > 0);
  if (comHoras.length === 0) {
    return `<p class="no-alert">Nenhuma tarefa com estimativa de horas no período.<br>As estimativas são registradas no check-in das tarefas.</p>`;
  }
  return comHoras
    .map((d) => {
      const folga = jornada - d.horasPlanejadas;
      const folgaCls = folga >= 0 ? "ok" : "bad";
      const folgaTxt = folga >= 0 ? `folga ${fmtHoras(folga)}` : `sobrecarga ${fmtHoras(-folga)}`;
      return `<div class="rank-item">
        <div class="rank-name">${esc(d.colaborador)}</div>
        <div class="rank-val">carga ${fmtHoras(d.horasPlanejadas)}</div>
        <div class="tiny"><span class="ado ${folgaCls}">${folgaTxt}</span><br><span class="tiny-sub">${fmtHoras(d.horasConcluidas)} concluídas</span></div>
      </div>`;
    })
    .join("\n");
}

// ── Timeline de participação de hoje ────────────────────────────────────────

function timelineHtml(timeline: Participacao[], horaCi: string, horaCo: string): string {
  if (timeline.length === 0) {
    return `<p class="no-alert">Sem colaboradores com atividade. Configure FUNCIONARIOS_IDS ou registre check-ins.</p>`;
  }
  return timeline
    .map((t) => {
      const ci = t.checkin
        ? `<span class="tl-ok">✓ check-in ${t.checkin.hora}</span> <span class="tiny-sub">${atrasoLabel(horaCi, t.checkin.hora)}</span>`
        : `<span class="tl-bad">✕ sem check-in</span>`;
      const co = t.checkout
        ? `<span class="tl-ok">✓ check-out ${t.checkout.hora}</span> <span class="tiny-sub">${atrasoLabel(horaCo, t.checkout.hora)}</span>`
        : `<span class="tl-warn">✕ sem check-out</span>`;
      return `<div class="rank-item">
        <div class="rank-name">${esc(t.colaborador)}</div>
        <div class="tl-cell">${ci} · ${co}</div>
      </div>`;
    })
    .join("\n");
}

// ── Layout da página ────────────────────────────────────────────────────────

const ESTILOS = `:root {
    --navy-950:#05090f; --navy-900:#0a1220; --navy-800:#0f1d33; --navy-700:#14263f; --navy-600:#1b3454;
    --accent:#3b82f6; --accent-2:#60a5fa; --gold:#f59e0b; --ink:#0b0f14; --muted:#94a3b8;
    --line:rgba(255,255,255,.08); --bg:#f4f6fa; --ok:#16a34a; --warn:#d97706; --bad:#dc2626;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { font-family:"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--ink); min-height:100vh; -webkit-font-smoothing:antialiased; }
  .topbar { position:sticky; top:0; z-index:50; background:linear-gradient(135deg, var(--navy-950) 0%, var(--navy-800) 55%, var(--navy-700) 100%); border-bottom:1px solid var(--line); box-shadow:0 1px 0 rgba(255,255,255,.04), 0 10px 30px -18px rgba(5,9,15,.9); }
  .topbar-inner { max-width:1180px; margin:0 auto; padding:16px 28px; display:flex; align-items:center; justify-content:space-between; gap:20px; }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand-logo { width:42px; height:42px; border-radius:12px; flex:0 0 auto; background:linear-gradient(135deg, var(--accent), var(--accent-2)); display:flex; align-items:center; justify-content:center; color:#fff; font-weight:800; font-size:20px; box-shadow:0 8px 20px -8px rgba(59,130,246,.7); }
  .brand-text { line-height:1.05; }
  .brand-name { color:#fff; font-weight:800; letter-spacing:.22em; font-size:15px; }
  .brand-sub { color:var(--accent-2); font-size:12px; letter-spacing:.12em; font-weight:600; }
  .top-meta { text-align:right; color:var(--muted); font-size:12px; line-height:1.5; }
  .top-meta b { color:#e2e8f0; font-weight:600; }
  .pill-top { display:inline-block; margin-top:4px; padding:2px 10px; border-radius:999px; background:rgba(59,130,246,.16); border:1px solid rgba(59,130,246,.35); color:var(--accent-2); font-size:11px; font-weight:600; letter-spacing:.05em; }
  main { max-width:1180px; margin:0 auto; padding:30px 28px 60px; }
  .page-title { margin:0 0 4px; font-size:22px; font-weight:800; color:var(--navy-900); }
  .page-sub { margin:0 0 26px; color:var(--muted); font-size:14px; }
  .filtro { display:flex; flex-wrap:wrap; gap:10px; align-items:center; background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:14px; padding:12px 16px; margin-bottom:24px; box-shadow:0 1px 2px rgba(11,15,20,.04); }
  .filtro select, .filtro input { padding:7px 10px; border:1px solid #dbe2ea; border-radius:9px; font-size:13px; font-family:inherit; color:var(--ink); background:#fff; }
  .filtro label { font-size:12px; color:var(--muted); font-weight:600; }
  .filtro button { padding:8px 16px; border:none; border-radius:9px; background:var(--navy-900); color:#fff; font-weight:700; font-size:13px; cursor:pointer; }
  .filtro a { font-size:12px; color:var(--accent); text-decoration:none; font-weight:600; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px; margin-bottom:28px; }
  .card { position:relative; overflow:hidden; background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:16px; padding:22px 22px 20px; box-shadow:0 1px 2px rgba(11,15,20,.04), 0 16px 34px -24px rgba(11,15,20,.35); transition:transform .18s ease, box-shadow .18s ease; }
  .card:hover { transform:translateY(-3px); box-shadow:0 22px 40px -26px rgba(11,15,20,.4); }
  .card::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--card-accent,var(--accent)); }
  .card .k { font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .card .v { margin-top:8px; font-size:34px; font-weight:800; color:var(--navy-900); line-height:1; }
  .card .u { margin-top:6px; font-size:12px; color:var(--muted); }
  .card.alt { --card-accent:var(--gold); }
  .card.mid { --card-accent:#8b5cf6; }
  .grid { display:grid; grid-template-columns:1fr; gap:24px; }
  @media (min-width:880px){ .grid { grid-template-columns:2fr 1fr; } }
  .panel { background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04), 0 18px 40px -28px rgba(11,15,20,.35); }
  .panel-head { padding:18px 22px; border-bottom:1px solid #eef1f6; display:flex; align-items:center; justify-content:space-between; }
  .panel-head h2 { margin:0; font-size:15px; font-weight:800; color:var(--navy-900); }
  .panel-head .hint { font-size:12px; color:var(--muted); }
  .panel-body { padding:18px 22px; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  thead th { text-align:left; padding:12px 22px; font-size:11px; font-weight:700; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); background:var(--bg); border-bottom:1px solid #eef1f6; white-space:nowrap; }
  tbody td { padding:15px 22px; border-bottom:1px solid #f1f4f8; font-size:14px; vertical-align:middle; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr { transition:background .15s ease; }
  tbody tr:hover { background:#f8fafc; }
  td.num { font-weight:700; color:var(--navy-900); }
  .user { font-weight:700; color:var(--navy-900); }
  .user a { color:var(--navy-900); text-decoration:none; }
  .user a:hover { color:var(--accent); text-decoration:underline; }
  .empty { text-align:center; color:var(--muted); padding:40px !important; }
  .ader-cell { min-width:120px; }
  .ader-val { display:inline-block; font-size:13px; font-weight:800; }
  .ader-val.ok { color:var(--ok); } .ader-val.warn { color:var(--warn); } .ader-val.bad { color:var(--bad); } .ader-val.none { color:var(--muted); }
  .barwrap { margin-top:6px; height:6px; background:#eef1f6; border-radius:999px; overflow:hidden; }
  .bar { height:100%; border-radius:999px; }
  .bar.ok { background:linear-gradient(90deg,#15803d,var(--ok)); }
  .bar.warn { background:linear-gradient(90deg,#b45309,var(--warn)); }
  .bar.bad { background:linear-gradient(90deg,#b91c1c,var(--bad)); }
  .pill { display:inline-block; padding:4px 11px; border-radius:999px; font-size:12px; font-weight:700; margin:2px 4px 2px 0; }
  .pill-ok { background:#dcfce7; color:#166534; }
  .pill-bad { background:#fee2e2; color:#991b1b; }
  .side-stack { display:flex; flex-direction:column; gap:24px; }
  .side { background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04), 0 18px 40px -28px rgba(11,15,20,.35); }
  .side-head { padding:16px 20px; border-bottom:1px solid #eef1f6; }
  .side-head h2 { margin:0; font-size:14px; font-weight:800; color:var(--navy-900); display:flex; align-items:center; gap:8px; }
  .side-head .hint { font-size:11px; color:var(--muted); margin-left:auto; }
  .side-body { padding:8px 20px 16px; }
  .rank-item { display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid #f3f5f9; }
  .rank-item:last-child { border-bottom:none; }
  .rank-pos { width:24px; height:24px; border-radius:8px; background:var(--navy-900); color:#fff; font-size:12px; font-weight:800; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
  .rank-pos.t1 { background:linear-gradient(135deg,var(--accent),var(--accent-2)); }
  .medalha { font-size:14px; flex:0 0 auto; }
  .rank-name { flex:1; font-weight:600; color:var(--navy-900); font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rank-val { font-weight:800; color:var(--navy-900); font-size:14px; white-space:nowrap; }
  .rank-val.ok { color:var(--ok); } .rank-val.warn { color:var(--warn); } .rank-val.bad { color:var(--bad); }
  .rank-val.muted { color:var(--muted); }
  .tiny { text-align:right; font-size:11px; line-height:1.5; white-space:nowrap; }
  .tiny .ado { font-weight:800; }
  .tiny .ado.ok { color:var(--ok); } .tiny .ado.bad { color:var(--bad); }
  .tiny-sub { color:var(--muted); font-size:11px; }
  .tl-cell { font-size:12px; text-align:right; line-height:1.6; white-space:nowrap; }
  .tl-ok { color:var(--ok); font-weight:700; }
  .tl-warn { color:var(--warn); font-weight:700; }
  .tl-bad { color:var(--bad); font-weight:700; }
  .alert-box { display:flex; gap:12px; padding:12px 20px 4px; }
  .alert-dot { width:30px; height:30px; border-radius:9px; background:#fee2e2; color:#b91c1c; display:flex; align-items:center; justify-content:center; font-weight:800; flex:0 0 auto; }
  .alert-txt b { color:var(--navy-900); }
  .alert-txt { color:#57534e; font-size:13px; line-height:1.5; }
  .no-alert { padding:6px 0; color:var(--muted); font-size:13px; }
  .empty-sm { color:var(--muted); font-size:13px; }
  .foot { margin-top:34px; padding-top:18px; border-top:1px solid #e6eaf0; text-align:center; color:var(--muted); font-size:12px; display:flex; justify-content:center; gap:14px; align-items:center; flex-wrap:wrap; }
  .foot a { color:var(--accent); text-decoration:none; font-weight:600; }
  .hist-dia { border:1px solid #e9edf3; border-radius:12px; padding:14px 18px; margin-bottom:14px; background:#fff; }
  .hist-dia h3 { margin:0 0 8px; font-size:14px; font-weight:800; color:var(--navy-900); display:flex; align-items:center; gap:10px; }
  .hist-dia ul { margin:4px 0 0; padding-left:20px; font-size:13px; color:#334155; }
  .hist-dia .justi { font-size:12px; color:#57534e; margin-top:6px; }
  .back { font-size:13px; font-weight:700; color:var(--accent); text-decoration:none; }
  .back:hover { text-decoration:underline; }`;

function paginaHtml(titulo: string, tenantId: string, conteudo: string, periodo: Periodo): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)} — Gerente Codxis</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${ESTILOS}</style>
</head>
<body>
<div class="topbar">
  <div class="topbar-inner">
    <div class="brand">
      <div class="brand-logo">C</div>
      <div class="brand-text">
        <div class="brand-name">GERENTE CODXIS</div>
        <div class="brand-sub">PAINEL DA GESTÃO</div>
      </div>
    </div>
    <div class="top-meta">
      Tenant <b>${esc(tenantId)}</b><br>
      <span class="pill-top">${esc(periodo.desde)} → ${esc(periodo.ate)}</span>
    </div>
  </div>
</div>
<main>${conteudo}</main>
</body>
</html>`;
}

function filtroHtml(p: Periodo): string {
  const opts = ["7", "14", "30"]
    .map((d) => `<option value="${d}"${p.janela === d ? " selected" : ""}>Últimos ${d} dias</option>`)
    .join("");
  const custom = p.janela === "custom" ? " selected" : "";
  return `<form class="filtro" method="get" action="/">
    <label>Período</label>
    <select name="janela">
      ${opts}
      <option value="custom"${custom}>Período personalizado</option>
    </select>
    <label>de</label> <input type="date" name="desde" value="${esc(p.janela === "custom" ? p.desde : "")}">
    <label>até</label> <input type="date" name="ate" value="${esc(p.janela === "custom" ? p.ate : "")}">
    <button type="submit">Aplicar</button>
    <a href="/">limpar filtro</a>
  </form>`;
}

// ── Página principal ────────────────────────────────────────────────────────

async function renderHtml(
  store: CheckInStore,
  tenantId: string,
  opts: DashboardOptions,
  p: Periodo
): Promise<string> {
  const dados = await listarDadosGestao(store, tenantId, p.desde);
  const [serie, timeline] = await Promise.all([
    listarSerieAderencia(store, tenantId, p.desde, p.ate),
    montarTimeline(store, tenantId, opts, dados),
  ]);

  const meta = opts.metaAderencia ?? 90;
  const jornada = opts.jornadaSemanalHoras ?? 40;
  const horaCi = opts.horaCheckin ?? "10:00";
  const horaCo = opts.horaCheckout ?? "16:30";

  const totalPlanejadas = dados.reduce((a, d) => a + d.planejadas, 0);
  const totalConcluidas = dados.reduce((a, d) => a + d.concluidas, 0);
  const totalHoras = dados.reduce((a, d) => a + d.horasPlanejadas, 0);
  const totalHorasConc = dados.reduce((a, d) => a + d.horasConcluidas, 0);
  const comRec = dados.filter((d) => d.recorrentes.length > 0).length;
  const acimaMeta = dados.filter((d) => d.aderencia >= meta).length;
  const aquiader = totalPlanejadas
    ? Math.round((totalConcluidas / totalPlanejadas) * 100)
    : 0;
  const folgaGeral = dados.length
    ? jornada * dados.length - totalHoras
    : null;

  const linhas =
    dados.length === 0
      ? `<tr class="empty"><td colspan="7">Nenhum registro no período.</td></tr>`
      : dados
          .map((d) => {
            const href = `/colaborador/${encodeURIComponent(d.colaborador)}?${periodoQs(p)}`;
            return `<tr>
              <td><div class="user"><a href="${href}">${esc(d.colaborador)}</a></div></td>
              <td class="num">${d.planejadas}</td>
              <td class="num">${d.concluidas}</td>
              <td class="num">
                <div class="ader-cell">
                  <span class="ader-val ${aderClass(d.aderencia)}">${aderLabel(d.aderencia)}</span>
                  ${aderBar(d.aderencia)}
                </div>
              </td>
              <td class="num">${fmtHoras(d.horasPlanejadas)}</td>
              <td class="num">${fmtHoras(d.horasConcluidas)}</td>
              <td>${d.recorrentes.map(recHtml).join(" ")}</td>
            </tr>`;
          })
          .join("\n");

  const conteudo = `
  <h1 class="page-title">Visão geral de desempenho</h1>
  <p class="page-sub">Capacidade, aderência, horas e pendências recorrentes por colaborador.</p>
  ${filtroHtml(p)}

  <div class="stats">
    <div class="card"><div class="k">Colaboradores</div><div class="v">${dados.length}</div><div class="u">ativos no período · ${acimaMeta} na meta (${meta}%)</div></div>
    <div class="card alt"><div class="k">Tarefas planejadas</div><div class="v">${totalPlanejadas}</div><div class="u">capacidade total</div></div>
    <div class="card"><div class="k">Tarefas concluídas</div><div class="v">${totalConcluidas}</div><div class="u">do período</div></div>
    <div class="card mid"><div class="k">Aderência geral</div><div class="v">${aquiader}%</div><div class="u">${comRec > 0 ? `${comRec} com pendência recorrente` : "sem pendências recorrentes"}</div></div>
    ${totalHoras > 0 ? `<div class="card alt"><div class="k">Carga em horas</div><div class="v" style="font-size:26px">${fmtHoras(totalHoras)}</div><div class="u">${fmtHoras(totalHorasConc)} concluídas · folga ${folgaGeral == null ? "—" : fmtHoras(Math.max(0, folgaGeral))}</div></div>` : ""}
  </div>

  <div class="grid">
    <div class="panel">
      <div class="panel-head">
        <h2>Detalhamento por colaborador</h2>
        <span class="hint">${esc(p.desde)} → ${esc(p.ate)}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Colaborador</th><th>Planejadas</th><th>Concluídas</th><th>Aderência</th><th>Horas plan.</th><th>Horas concl.</th><th>Pendências recorrentes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>

    <div class="side-stack">
      <div class="side">
        <div class="side-head"><h2>🏆 Ranking de aderência</h2><span class="hint">meta ${meta}%</span></div>
        <div class="side-body">${rankHtml(dados, meta)}</div>
      </div>
      <div class="side">
        <div class="side-head"><h2>⏱️ Participação de hoje</h2><span class="hint">check-in ${horaCi} · check-out ${horaCo}</span></div>
        <div class="side-body">${timelineHtml(timeline, horaCi, horaCo)}</div>
      </div>
      <div class="side">
        <div class="side-head"><h2>🧮 Carga vs. folga</h2><span class="hint">jornada ${jornada}h/sem</span></div>
        <div class="side-body">${cargaHtml(dados, jornada)}</div>
      </div>
      <div class="side" style="border-color:rgba(220,38,38,.25)">
        <div class="side-head" style="background:#fef2f2"><h2 style="color:#991b1b">⚠️ Alertas de gestão</h2></div>
        <div class="side-body">${alertHtml(dados)}</div>
      </div>
    </div>
  </div>

  <div class="grid" style="margin-top:24px">
    <div class="panel">
      <div class="panel-head"><h2>📈 Tendência de aderência</h2><span class="hint">% concluídas/planejadas por dia</span></div>
      <div class="panel-body">${serieChartSVG(serie)}</div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>📊 Carga por colaborador</h2><span class="hint">azul planejadas · verde concluídas</span></div>
      <div class="panel-body">${cargaChartSVG(dados)}</div>
    </div>
  </div>

  <div class="foot">
    <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
    <span>·</span>
    <a href="/api/relatorio.json?${periodoQs(p)}">Exportar JSON</a>
  </div>`;

  return paginaHtml("Visão geral", tenantId, conteudo, p);
}

function alertHtml(dados: DadoGestao[]): string {
  const comRec = dados.filter((d) => d.recorrentes.length > 0);
  if (comRec.length === 0) {
    return `<div class="no-alert">Nenhuma pendência recorrente no momento. <b>✔</b></div>`;
  }
  return comRec
    .map(
      (d) => `
      <div class="alert-box">
        <div class="alert-dot">!</div>
        <div class="alert-txt"><b>${esc(d.colaborador)}</b> tem pendência por 3+ dias seguidos: ${d.recorrentes
          .map((r) => `${esc(r.tarefa)} (${r.dias.length} sem just.)`)
          .join(", ")}.</div>
      </div>`
    )
    .join("\n");
}

// ── Página de histórico por colaborador ─────────────────────────────────────

async function renderColaboradorHtml(
  store: CheckInStore,
  tenantId: string,
  colaborador: string,
  p: Periodo
): Promise<string> {
  const [checkIns, checkOuts] = await Promise.all([
    store.listCheckIns(tenantId, colaborador, p.desde),
    store.listCheckOuts(tenantId, colaborador, p.desde),
  ]);

  const dias = new Map<string, {
    planejadas: string[];
    concluidas: string[];
    pendentes: string[];
    justificativa: string | null;
  }>();
  for (const ci of checkIns) {
    const d = dias.get(ci.data) ?? { planejadas: [], concluidas: [], pendentes: [], justificativa: null };
    d.planejadas.push(...(JSON.parse(ci.tarefas) as string[]));
    dias.set(ci.data, d);
  }
  for (const co of checkOuts) {
    const d = dias.get(co.data) ?? { planejadas: [], concluidas: [], pendentes: [], justificativa: null };
    d.concluidas.push(...(JSON.parse(co.tarefas) as string[]));
    if (co.pendentes) d.pendentes.push(...(JSON.parse(co.pendentes) as string[]));
    d.justificativa = co.justificativa_pendencia;
    dias.set(co.data, d);
  }

  const datas = gerarDias(p.desde, p.ate);
  let blocos = "";
  if (datas.length === 0 || dias.size === 0) {
    blocos = `<p class="no-alert">Nenhum registro no período.</p>`;
  } else {
    for (const data of datas) {
      const d = dias.get(data);
      if (!d) continue;
      const taxa = d.planejadas.length
        ? Math.round((d.concluidas.length / d.planejadas.length) * 100)
        : 0;
      const badge = `<span class="pill ${aderClass(taxa)}">aderência ${taxa}%</span>`;
      const bloco = d.planejadas.length
        ? `<li><b>Planejadas:</b> ${d.planejadas.map(esc).join(", ")}</li>`
        : "";
      const concl = d.concluidas.length
        ? `<li><b>Concluídas:</b> ${d.concluidas.map(esc).join(", ")}</li>`
        : "";
      const pend = d.pendentes.length
        ? `<li><b>Pendentes:</b> ${d.pendentes.map(esc).join(", ")}</li>`
        : "";
      const justi = d.justificativa ? `<div class="justi"><b>Justificativa:</b> ${esc(d.justificativa)}</div>` : "";
      blocos += `<div class="hist-dia">
        <h3>${esc(data.slice(0, 10))} ${badge}</h3>
        <ul>${bloco}${concl}${pend}</ul>
        ${justi}
      </div>`;
    }
  }

  const conteudo = `
  <h1 class="page-title">👤 ${esc(colaborador)}</h1>
  <p class="page-sub"><a class="back" href="/?${periodoQs(p)}">← voltar à visão geral</a></p>
  ${filtroHtml(p)}
  ${blocos}`;

  return paginaHtml(`Histórico de ${colaborador}`, tenantId, conteudo, p);
}

// ── Servidor HTTP ───────────────────────────────────────────────────────────

const CONTENT_TYPE = {
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export function startDashboard(
  store: CheckInStore,
  tenantId: string,
  options: DashboardOptions
): import("node:http").Server {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const urlPath = (req.url ?? "/").split("?")[0];
        const q = new URLSearchParams((req.url ?? "").split("?")[1] ?? "");
        const p = parsePeriodo(q);
        let status = 200;
        let body: string;
        let type: string;

        if (urlPath === "/api/relatorio.json") {
          const dados = await listarDadosGestao(store, tenantId, p.desde);
          body = toJson(dados);
          type = CONTENT_TYPE.json;
        } else if (urlPath === "/") {
          body = await renderHtml(store, tenantId, options, p);
          type = CONTENT_TYPE.html;
        } else if (urlPath.startsWith("/colaborador/")) {
          const id = decodeURIComponent(urlPath.slice("/colaborador/".length));
          if (!id) {
            status = 404;
            body = "Não encontrado";
            type = "text/plain; charset=utf-8";
          } else {
            body = await renderColaboradorHtml(store, tenantId, id, p);
            type = CONTENT_TYPE.html;
          }
        } else {
          status = 404;
          body = "Não encontrado";
          type = "text/plain; charset=utf-8";
        }

        res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
        res.end(body);
      } catch (err) {
        console.error("[Dashboard] Erro ao processar requisição:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Erro interno no dashboard.");
        } else {
          res.end();
        }
      }
    }
  );

  server.on("error", (err) => {
    console.error(
      `[Dashboard] Falha ao iniciar em ${options.host ?? "127.0.0.1"}:${options.port}: ${err.message}`
    );
  });

  server.listen(options.port, options.host ?? "127.0.0.1", () => {
    const host = options.host ?? "127.0.0.1";
    console.log(
      `[Dashboard] Gestão disponível em http://${host}:${options.port}/ (tenant ${tenantId})`
    );
  });

  return server;
}