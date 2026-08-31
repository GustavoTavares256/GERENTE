import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { CheckInStore } from "../store/CheckInStore.js";
import {
  dataDesde,
  listarDadosGestao,
  DadoGestao,
  toJson,
} from "../report/gestao.js";

export interface DashboardOptions {
  port: number;
  host?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

function recHtml(d: DadoGestao): string {
  if (d.recorrentes.length === 0) {
    return `<span class="pill pill-ok">Sem pendências</span>`;
  }
  return d.recorrentes
    .map(
      (r) =>
        `<span class="pill pill-bad">${esc(r.tarefa)} · ${r.dias
          .map((x) => esc(x.slice(5)))
          .join(", ")}</span>`
    )
    .join(" ");
}

async function renderHtml(store: CheckInStore, tenantId: string): Promise<string> {
  const desdeStr = dataDesde();
  const dados = await listarDadosGestao(store, tenantId, desdeStr);

  const totalPlanejadas = dados.reduce((a, d) => a + d.planejadas, 0);
  const totalConcluidas = dados.reduce((a, d) => a + d.concluidas, 0);
  const comRec = dados.filter((d) => d.recorrentes.length > 0).length;
  const aquiader = totalPlanejadas
    ? Math.round((totalConcluidas / totalPlanejadas) * 100)
    : 0;

  const linhas =
    dados.length === 0
      ? `<tr class="empty"><td colspan="6">Nenhum registro no período de 7 dias.</td></tr>`
      : dados
          .map((d) => {
            return `<tr>
              <td><div class="user">${esc(d.colaborador)}</div></td>
              <td class="num">${d.planejadas}</td>
              <td class="num">${d.concluidas}</td>
              <td class="num">
                <div class="ader-cell">
                  <span class="ader-val ${aderClass(d.aderencia)}">${aderLabel(d.aderencia)}</span>
                  ${aderBar(d.aderencia)}
                </div>
              </td>
              <td>${recHtml(d)}</td>
            </tr>`;
          })
          .join("\n");

  const topo = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gerente Codxis — Painel da Gestão</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  :root {
    --navy-950:#05090f;
    --navy-900:#0a1220;
    --navy-800:#0f1d33;
    --navy-700:#14263f;
    --navy-600:#1b3454;
    --accent:#3b82f6;
    --accent-2:#60a5fa;
    --gold:#f59e0b;
    --ink:#0b0f14;
    --muted:#94a3b8;
    --line:rgba(255,255,255,.08);
    --bg:#f4f6fa;
    --ok:#16a34a;
    --warn:#d97706;
    --bad:#dc2626;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body {
    font-family:"Inter", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:var(--bg); color:var(--ink); min-height:100vh;
    -webkit-font-smoothing:antialiased;
  }

  /* ── Top bar / branding ─────────────────────────── */
  .topbar {
    position:sticky; top:0; z-index:50;
    background:linear-gradient(135deg, var(--navy-950) 0%, var(--navy-800) 55%, var(--navy-700) 100%);
    border-bottom:1px solid var(--line);
    box-shadow:0 1px 0 rgba(255,255,255,.04), 0 10px 30px -18px rgba(5,9,15,.9);
  }
  .topbar-inner {
    max-width:1180px; margin:0 auto; padding:16px 28px;
    display:flex; align-items:center; justify-content:space-between; gap:20px;
  }
  .brand { display:flex; align-items:center; gap:14px; }
  .brand-logo {
    width:42px; height:42px; border-radius:12px; flex:0 0 auto;
    background:linear-gradient(135deg, var(--accent), var(--accent-2));
    display:flex; align-items:center; justify-content:center; color:#fff;
    font-weight:800; font-size:20px; box-shadow:0 8px 20px -8px rgba(59,130,246,.7);
  }
  .brand-text { line-height:1.05; }
  .brand-name { color:#fff; font-weight:800; letter-spacing:.22em; font-size:15px; }
  .brand-sub { color:var(--accent-2); font-size:12px; letter-spacing:.12em; font-weight:600; }
  .top-meta { text-align:right; color:var(--muted); font-size:12px; line-height:1.5; }
  .top-meta b { color:#e2e8f0; font-weight:600; }
  .pill-top {
    display:inline-block; margin-top:4px; padding:2px 10px; border-radius:999px;
    background:rgba(59,130,246,.16); border:1px solid rgba(59,130,246,.35);
    color:var(--accent-2); font-size:11px; font-weight:600; letter-spacing:.05em;
  }

  main { max-width:1180px; margin:0 auto; padding:30px 28px 60px; }

  .page-title { margin:0 0 4px; font-size:22px; font-weight:800; color:var(--navy-900); }
  .page-sub { margin:0 0 26px; color:var(--muted); font-size:14px; }

  /* ── Stat cards ───────────────────────────────── */
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:18px; margin-bottom:28px; }
  .card {
    position:relative; overflow:hidden;
    background:#fff; border:1px solid rgba(15,29,51,.08);
    border-radius:16px; padding:22px 22px 20px;
    box-shadow:0 1px 2px rgba(11,15,20,.04), 0 16px 34px -24px rgba(11,15,20,.35);
    transition:transform .18s ease, box-shadow .18s ease;
  }
  .card:hover { transform:translateY(-3px); box-shadow:0 22px 40px -26px rgba(11,15,20,.4); }
  .card::before { content:""; position:absolute; inset:0 auto 0 0; width:4px; background:var(--card-accent,var(--accent)); }
  .card .k { font-size:11px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); }
  .card .v { margin-top:8px; font-size:34px; font-weight:800; color:var(--navy-900); line-height:1; }
  .card .u { margin-top:6px; font-size:12px; color:var(--muted); }
  .card.alt { --card-accent:var(--gold); }
  .card.mid { --card-accent:#8b5cf6; }

  /* ── Layout grid ──────────────────────────────── */
  .grid { display:grid; grid-template-columns:1fr; gap:24px; }
  @media (min-width:880px){ .grid { grid-template-columns:2fr 1fr; } }

  .panel {
    background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:16px;
    overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04), 0 18px 40px -28px rgba(11,15,20,.35);
  }
  .panel-head { padding:18px 22px; border-bottom:1px solid #eef1f6; display:flex; align-items:center; justify-content:space-between; }
  .panel-head h2 { margin:0; font-size:15px; font-weight:800; color:var(--navy-900); }
  .panel-head .hint { font-size:12px; color:var(--muted); }

  /* ── Table ───────────────────────────────────── */
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; }
  thead th {
    text-align:left; padding:12px 22px; font-size:11px; font-weight:700;
    letter-spacing:.09em; text-transform:uppercase; color:var(--muted);
    background:var(--bg); border-bottom:1px solid #eef1f6; white-space:nowrap;
  }
  tbody td { padding:15px 22px; border-bottom:1px solid #f1f4f8; font-size:14px; vertical-align:middle; }
  tbody tr:last-child td { border-bottom:none; }
  tbody tr { transition:background .15s ease; }
  tbody tr:hover { background:#f8fafc; }
  td.num { font-weight:700; color:var(--navy-900); }
  .user { font-weight:700; color:var(--navy-900); }
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

  /* ── Side panel: ranking / alerta ────────────── */
  .side-stack { display:flex; flex-direction:column; gap:24px; }
  .side { background:#fff; border:1px solid rgba(15,29,51,.08); border-radius:16px; overflow:hidden; box-shadow:0 1px 2px rgba(11,15,20,.04), 0 18px 40px -28px rgba(11,15,20,.35); }
  .side-head { padding:16px 20px; border-bottom:1px solid #eef1f6; }
  .side-head h2 { margin:0; font-size:14px; font-weight:800; color:var(--navy-900); display:flex; align-items:center; gap:8px; }
  .side-body { padding:8px 20px 16px; }
  .rank-item { display:flex; align-items:center; gap:12px; padding:10px 0; border-bottom:1px solid #f3f5f9; }
  .rank-item:last-child { border-bottom:none; }
  .rank-pos { width:24px; height:24px; border-radius:8px; background:var(--navy-900); color:#fff; font-size:12px; font-weight:800; display:flex; align-items:center; justify-content:center; flex:0 0 auto; }
  .rank-pos.t1 { background:linear-gradient(135deg,var(--accent),var(--accent-2)); }
  .rank-name { flex:1; font-weight:600; color:var(--navy-900); font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .rank-val { font-weight:800; color:var(--navy-900); font-size:14px; }
  .rank-val.muted { color:var(--muted); }

  .alert-box { display:flex; gap:12px; padding:12px 20px 4px; }
  .alert-dot { width:30px; height:30px; border-radius:9px; background:#fee2e2; color:#b91c1c; display:flex; align-items:center; justify-content:center; font-weight:800; flex:0 0 auto; }
  .alert-txt b { color:var(--navy-900); }
  .alert-txt { color:#57534e; font-size:13px; line-height:1.5; }
  .no-alert { padding:14px 20px; color:var(--muted); font-size:13px; }

  .foot { margin-top:34px; padding-top:18px; border-top:1px solid #e6eaf0; text-align:center; color:var(--muted); font-size:12px; display:flex; justify-content:center; gap:8px; align-items:center; }
  .foot a { color:var(--accent); text-decoration:none; font-weight:600; }
</style>
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
      <span class="pill-top">Últimos 7 dias</span>
    </div>
  </div>
</div>

<main>
  <h1 class="page-title">Visão geral de desempenho</h1>
  <p class="page-sub">Capacidade, aderência e pendências recorrentes por colaborador.</p>

  <div class="stats">
    <div class="card"><div class="k">Colaboradores</div><div class="v">${dados.length}</div><div class="u">ativos no período</div></div>
    <div class="card alt"><div class="k">Tarefas planejadas</div><div class="v">${totalPlanejadas}</div><div class="u">capacidade total</div></div>
    <div class="card"><div class="k">Tarefas concluídas</div><div class="v">${totalConcluidas}</div><div class="u">do período</div></div>
    <div class="card mid"><div class="k">Aderência geral</div><div class="v">${aquiader}%</div><div class="u">${comRec > 0 ? `${comRec} com pendência recorrente` : "sem pendências recorrentes"}</div></div>
  </div>

  <div class="grid">
    <div class="panel">
      <div class="panel-head">
        <h2>Detalhamento por colaborador</h2>
        <span class="hint">últimos 7 dias</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Colaborador</th><th>Planejadas</th><th>Concluídas</th><th>Aderência</th><th>Pendências recorrentes</th></tr></thead>
          <tbody>${linhas}</tbody>
        </table>
      </div>
    </div>

    <div class="side-stack">
      <div class="side">
        <div class="side-head"><h2>🏆 Ranking de aderência</h2></div>
        <div class="side-body">
          ${rankHtml(dados)}
        </div>
      </div>
      <div class="side" style="border-color:rgba(220,38,38,.25)">
        <div class="side-head" style="background:#fef2f2"><h2 style="color:#991b1b">⚠️ Alertas de gestão</h2></div>
        <div class="side-body">
          ${alertHtml(dados)}
        </div>
      </div>
    </div>
  </div>

  <div class="foot">
    <span>Gerado em ${new Date().toLocaleString("pt-BR")}</span>
    <span>·</span>
    <a href="/api/relatorio.json">Exportar JSON</a>
  </div>
</main>
</body>
</html>`;

  return topo;
}

function rankHtml(dados: DadoGestao[]): string {
  const ordenados = [...dados].sort((a, b) => b.aderencia - a.aderencia);
  if (ordenados.length === 0) {
    return `<div class="no-alert">Sem dados no período.</div>`;
  }
  return ordenados
    .map((d, i) => {
      const cls = i === 0 ? "t1" : "";
      const val = d.aderencia < 0 ? "—" : `${d.aderencia}%`;
      return `<div class="rank-item">
        <div class="rank-pos ${cls}">${i + 1}</div>
        <div class="rank-name">${esc(d.colaborador)}</div>
        <div class="rank-val ${d.aderencia < 0 ? "muted" : ""}">${val}</div>
      </div>`;
    })
    .join("\n");
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
        .map((r) => `${esc(r.tarefa)} (${r.dias.length} dias)`)
        .join(", ")}.</div>
      </div>`
    )
    .join("\n");
}

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
      const url = (req.url ?? "/").split("?")[0];
      let status = 200;
      let body: string;
      let type: string;

      if (url === "/api/relatorio.json") {
        const dados = await listarDadosGestao(store, tenantId, dataDesde());
        body = toJson(dados);
        type = CONTENT_TYPE.json;
      } else if (url === "/") {
        body = await renderHtml(store, tenantId);
        type = CONTENT_TYPE.html;
      } else {
        status = 404;
        body = "Não encontrado";
        type = "text/plain; charset=utf-8";
      }

      res.writeHead(status, { "Content-Type": type });
      res.end(body);
    }
  );

  server.listen(options.port, options.host ?? "127.0.0.1", () => {
    const host = options.host ?? "127.0.0.1";
    console.log(
      `[Dashboard] Gestão disponível em http://${host}:${options.port}/ (tenant ${tenantId})`
    );
  });

  return server;
}
