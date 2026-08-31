import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CheckInStore } from "../src/store/CheckInStore.js";
import { startDashboard } from "../src/dashboard/server.js";

function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function semear(store: CheckInStore): void {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const insert = (
    colaborador: string,
    data: string,
    tipo: string,
    tarefas: string[],
    pendentes: string[],
    just: string | null
  ) => {
    db.prepare(
      `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "codxis",
      colaborador,
      data,
      tipo,
      JSON.stringify(tarefas),
      JSON.stringify(pendentes),
      just,
      data + "T18:00:00.000Z"
    );
  };

  // ana: 2 tarefas planejadas, 1 concluída hoje → aderência 50%, sem recorrente
  const hoje = offsetDate(0);
  insert("ana", hoje, "check_in", ["T1", "T2"], [], null);
  insert("ana", hoje, "check_out", ["T1"], [], null);

  // bob: pendência 'Bug X' por 3 dias seguidos sem justificativa → recorrente
  for (const off of [-2, -1, 0]) {
    const dia = offsetDate(off);
    insert("bob", dia, "check_in", ["Bug X"], [], null);
    insert("bob", dia, "check_out", [], ["Bug X"], null);
  }
}

test("dashboard: recebe consulta via HTTP e responde HTML/JSON", async () => {
  const store = new CheckInStore(":memory:");
  semear(store);

  const port = 49871;
  const server = startDashboard(store, "codxis", { port, host: "127.0.0.1" });
  after(() => server.close());

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
