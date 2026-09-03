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

  const server = startDashboard(store, "codxis", { port: 0, host: "127.0.0.1" });
  after(() => {
    server.close();
    void store.close();
  });

  // aguarda o servidor subir e obtém a porta real escolhida pelo SO
  await new Promise((resolve) => {
    if (server.listening) {
      resolve(undefined);
    } else {
      server.once("listening", () => resolve(undefined));
    }
  });
  const port = (server.address() as { port: number }).port;

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
