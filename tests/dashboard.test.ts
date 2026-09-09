import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CheckInStore } from "../src/store/CheckInStore.js";
import { startDashboard } from "../src/dashboard/server.js";
import { connectTestStore } from "./helpers.js";

function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function semear(store: CheckInStore): Promise<void> {
  // ana: 2 tarefas planejadas, 1 concluída hoje → aderência 50%, sem recorrente
  const hoje = offsetDate(0);
  await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: hoje, tipo: "check_in", tarefas: ["T1", "T2"] });
  await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: hoje, tipo: "check_out", tarefas: ["T1"], pendentes: [] });

  // bob: pendência 'Bug X' por 3 dias seguidos sem justificativa → recorrente
  for (const off of [-2, -1, 0]) {
    const dia = offsetDate(off);
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "bob", data: dia, tipo: "check_in", tarefas: ["Bug X"] });
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "bob", data: dia, tipo: "check_out", tarefas: [], pendentes: ["Bug X"] });
  }
}

test("dashboard: recebe consulta via HTTP e responde HTML/JSON", async () => {
  const store = await connectTestStore("dashboard");
  await semear(store);

  const port = 49871;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });

  // espera o servidor subir
  await new Promise((r) => setTimeout(r, 800));

  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /GERENTE CODXIS/);
  assert.match(html, /ana/);
  assert.match(html, /bob/);
  assert.match(html, /Bug X/);
  assert.match(html, /50%/);
  assert.match(html, /Ranking de aderência/);
  assert.match(html, /Alertas de gestão/);

  const json = await fetch(
    `http://127.0.0.1:${port}/api/relatorio.json`
  ).then((r) => r.text());
  const parsed = JSON.parse(json) as Array<{
    colaborador: string;
    aderencia: number;
    recorrentes: Array<{ tarefa: string }>;
  }>;
  assert.equal(parsed.length, 2);
  const ana = parsed.find((d) => d.colaborador === "ana")!;
  assert.equal(ana.aderencia, 50);
  const bob = parsed.find((d) => d.colaborador === "bob")!;
  assert.ok(bob.recorrentes.length > 0);
  assert.equal(bob.recorrentes[0].tarefa, "Bug X");
});

test("dashboard: gráfico de tendência (SVG) é servido na página principal", async () => {
  const store = await connectTestStore("dashboard_svg");
  await semear(store);
  const port = 49872;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });
  await new Promise((r) => setTimeout(r, 800));

  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /Tendência de aderência/);
  assert.match(html, /<svg /);
  assert.match(html, /Carga por colaborador/);
  assert.match(html, /Participação de hoje/);
  assert.match(html, /🥇/);
});

test("dashboard: página de histórico por colaborador mostra dia a dia", async () => {
  const store = await connectTestStore("dashboard_hist");
  await semear(store);
  const port = 49873;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });
  await new Promise((r) => setTimeout(r, 800));

  const referer = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(referer, /\/colaborador\/ana\?/);

  const hist = await fetch(`http://127.0.0.1:${port}/colaborador/ana`).then((r) => r.text());
  assert.match(hist, /👤 ana/);
  assert.match(hist, /Planejadas:<\/b> T1, T2/);
  assert.match(hist, /Concluídas:<\/b> T1/);
  assert.match(hist, /aderência 50%/);
});

test("dashboard: filtro de período (janela de 14 dias) é respeitado", async () => {
  const store = await connectTestStore("dashboard_periodo");
  await semear(store);
  const port = 49874;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });
  await new Promise((r) => setTimeout(r, 800));

  const resp = await fetch(`http://127.0.0.1:${port}/?janela=14`);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  assert.match(html, /Últimos 14 dias/);
  assert.match(html, /value="14" selected/);
});

test("dashboard: capacidade em horas aparece quando há estimativas", async () => {
  const store = await connectTestStore("dashboard_horas");
  const hoje = offsetDate(0);
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "carla",
    data: hoje,
    tipo: "check_in",
    tarefas: ["T1", "T2"],
    estimativas: { T1: 3, T2: 2 },
  });
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "carla",
    data: hoje,
    tipo: "check_out",
    tarefas: ["T1"],
    pendentes: ["T2"],
    justificativa: "sem tempo",
  });
  const port = 49875;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });
  await new Promise((r) => setTimeout(r, 800));

  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /Carga em horas/);
  assert.match(html, /carga 5h/);
  assert.match(html, /3h concluídas/);

  const json = await fetch(`http://127.0.0.1:${port}/api/relatorio.json`).then((r) => r.text());
  const parsed = JSON.parse(json) as Array<{
    colaborador: string;
    horasPlanejadas: number;
    horasConcluidas: number;
    horasPendentes: number;
  }>;
  const carla = parsed.find((d) => d.colaborador === "carla")!;
  assert.equal(carla.horasPlanejadas, 5);
  assert.equal(carla.horasConcluidas, 3);
  assert.equal(carla.horasPendentes, 2);
});

test("dashboard: pendência recorrente detalha dias justificados", async () => {
  const store = await connectTestStore("dashboard_justif");
  const hoje = offsetDate(0);
  // 3 dias sem justificativa + 1 dia final justificado (streak de 3 dispara, último com just.)
  for (const off of [-3, -2, -1]) {
    await store.seedRecord({
      tenantId: "codxis",
      colaboradorId: "bob",
      data: offsetDate(off),
      tipo: "check_out",
      tarefas: [],
      pendentes: ["Bug X"],
      justificativa: null,
    });
  }
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "bob",
    data: hoje,
    tipo: "check_out",
    tarefas: [],
    pendentes: ["Bug X"],
    justificativa: "aguardando cliente",
  });
  const port = 49876;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });
  await new Promise((r) => setTimeout(r, 800));

  const hist = await fetch(`http://127.0.0.1:${port}/colaborador/bob`).then((r) => r.text());
  assert.match(hist, /Justificativa:<\/b> aguardando cliente/);

  const html = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  assert.match(html, /just\. em/);
});
