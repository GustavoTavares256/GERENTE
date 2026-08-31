import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CheckInBot,
  detectarPendenciasRecorrentes,
  formatarAlertasPendencias,
} from "../src/bot/CheckInBot.js";
import { CheckInRecord, CheckInStore } from "../src/store/CheckInStore.js";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "../src/channel/ChannelConnector.js";

function co(
  data: string,
  pendentes: string[],
  justificativa: string | null
): CheckInRecord {
  return {
    id: 0,
    tenantId: "codxis",
    colaboradorId: "colab",
    data,
    tipo: "check_out",
    tarefas: "[]",
    pendentes: JSON.stringify(pendentes),
    justificativa_pendencia: justificativa,
    criadoEm: data + "T20:00:00.000Z",
  };
}

test("detectarPendenciasRecorrentes: 3 dias seguidos sem justificativa é alertada", () => {
  const res = detectarPendenciasRecorrentes(
    [co("2026-08-26", ["Bug A"], null), co("2026-08-27", ["Bug A"], null), co("2026-08-28", ["Bug A"], null)]
  );
  assert.equal(res.length, 1);
  assert.equal(res[0].tarefa, "Bug A");
  assert.equal(res[0].justificada, false);
});

test("detectarPendenciasRecorrentes: 2 dias seguidos não é alertada", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-27", ["Bug A"], null),
    co("2026-08-28", ["Bug A"], null),
  ]);
  assert.equal(res.length, 0);
});

test("detectarPendenciasRecorrentes: dias não consecutivos não formam streak", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-26", ["Bug A"], null),
    co("2026-08-27", ["Bug A"], null),
    co("2026-08-29", ["Bug A"], null),
  ]);
  assert.equal(res.length, 0);
});

test("detectarPendenciasRecorrentes: com justificativa é marcada como justificada", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-26", ["Bug A"], "aguardando cliente"),
    co("2026-08-27", ["Bug A"], "aguardando cliente"),
    co("2026-08-28", ["Bug A"], "aguardando cliente"),
  ]);
  assert.equal(res.length, 1);
  assert.equal(res[0].justificada, true);
});

test("formatarAlertasPendencias: gera mensagem com alerta", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-26", ["Bug A"], null),
    co("2026-08-27", ["Bug A"], null),
    co("2026-08-28", ["Bug A"], null),
  ]);
  const msg = formatarAlertasPendencias(res);
  assert.match(msg, /Pendências recorrentes/);
  assert.match(msg, /Bug A/);
});

class FakeConnector implements ChannelConnector {
  readonly name = "fake";
  sent: OutgoingMessage[] = [];
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  async start(): Promise<void> {}
  onMessage(h: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = h;
  }
  async send(m: OutgoingMessage): Promise<void> {
    this.sent.push(m);
  }
  async say(text: string): Promise<void> {
    if (!this.handler) throw new Error("sem handler");
    await this.handler({ senderId: "gestor", text, channel: this.name });
  }
  async sayAs(sender: string, text: string): Promise<void> {
    if (!this.handler) throw new Error("sem handler");
    await this.handler({ senderId: sender, text, channel: this.name });
  }
}

function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

test("/relatorio: valida capacidade (tarefas) e alerta de pendência recorrente", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store, { gestaoIds: ["gestor"] });
  const conn = new FakeConnector();
  bot.onConnect(conn);

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
      data + "T20:00:00.000Z"
    );
  };

  // 3 dias consecutivos com pendência 'Bug A' não justificada
  for (const off of [-2, -1, 0]) {
    const dia = offsetDate(off);
    insert("colab-teste", dia, "check_in", ["T1", "T2", "T3"], [], null);
    insert("colab-teste", dia, "check_out", [], ["Bug A"], null);
  }
  // um dia extra (fora da janela contínua) com tudo concluído
  const diaExtra = offsetDate(-4);
  insert("colab-teste", diaExtra, "check_in", ["X"], [], null);
  insert("colab-teste", diaExtra, "check_out", ["X"], [], null);

  // segundo colaborador sem pendências recorrentes
  insert("colab-ok", offsetDate(0), "check_in", ["Y"], [], null);
  insert("colab-ok", offsetDate(0), "check_out", ["Y"], [], null);

  await conn.say("/relatorio");
  const msg = conn.sent[conn.sent.length - 1].text;

  // agrega ambos os colaboradores
  assert.match(msg, /colab-teste/);
  assert.match(msg, /colab-ok/);

  // capacidade do colab-teste: planejadas = 3+3+3+1 = 10, concluídas = 0+0+0+1 = 1 → aderência 10%
  assert.match(msg, /planejadas 10, concluídas 1 \(aderência 10%\)/);

  // pendência recorrente só do colab-teste
  assert.match(msg, /Bug A/);
  assert.match(msg, /Pendências recorrentes/);
});

test("/relatorio: bloqueia usuário que não é da gestão", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store, { gestaoIds: ["gestor-admin"] });
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/relatorio");
  assert.match(conn.sent[conn.sent.length - 1].text, /Acesso restrito à gestão/);
});

test("/exportar-csv: gestor recebe CSV com cabeçalho e dados", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store, { gestaoIds: ["gestor"] });
  const conn = new FakeConnector();
  bot.onConnect(conn);

  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const dia = offsetDate(0);
  db.prepare(
    `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
     VALUES (?, ?, ?, 'check_in', ?, ?, NULL, ?)`
  ).run("codxis", "ana", dia, JSON.stringify(["T1", "T2"]), "[]", dia + "T08:00:00.000Z");
  db.prepare(
    `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
     VALUES (?, ?, ?, 'check_out', ?, ?, NULL, ?)`
  ).run("codxis", "ana", dia, JSON.stringify(["T1"]), "[]", dia + "T18:00:00.000Z");

  await conn.say("/exportar-csv");
  const csv = conn.sent[conn.sent.length - 1].text;
  assert.match(csv, /colaborador,planejadas,concluidas,aderencia_pct,pendencia_recorrente/);
  assert.match(csv, /"ana",2,1,50,""/);
});

test("/exportar-json: gestor recebe JSON estruturado", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store, { gestaoIds: ["gestor"] });
  const conn = new FakeConnector();
  bot.onConnect(conn);

  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const dia = offsetDate(0);
  db.prepare(
    `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
     VALUES (?, ?, ?, 'check_in', ?, ?, NULL, ?)`
  ).run("codxis", "ana", dia, JSON.stringify(["T1"]), "[]", dia + "T08:00:00.000Z");
  db.prepare(
    `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
     VALUES (?, ?, ?, 'check_out', ?, ?, NULL, ?)`
  ).run("codxis", "ana", dia, JSON.stringify(["T1"]), "[]", dia + "T18:00:00.000Z");

  await conn.say("/exportar-json");
  const json = conn.sent[conn.sent.length - 1].text;
  const parsed = JSON.parse(json) as Array<{
    colaborador: string;
    planejadas: number;
    concluidas: number;
  }>;
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].colaborador, "ana");
  assert.equal(parsed[0].planejadas, 1);
  assert.equal(parsed[0].concluidas, 1);
});

test("alerta proativo: gestor recebe aviso quando há pendência recorrente", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store, { gestaoIds: ["gestor"] });
  const conn = new FakeConnector();
  bot.onConnect(conn);

  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  // semear 2 dias de pendência 'Bug X' para o colaborador 'bob'
  for (const off of [-2, -1]) {
    const dia = offsetDate(off);
    db.prepare(
      `INSERT INTO checkins_diarios (tenant_id, colaborador_id, data, tipo, tarefas, pendentes, justificativa_pendencia, criado_em)
       VALUES (?, ?, ?, 'check_out', ?, ?, NULL, ?)`
    ).run("codxis", "bob", dia, "[]", JSON.stringify(["Bug X"]), dia + "T18:00:00.000Z");
  }

  // 'bob' faz check-in e check-out hoje pelo fluxo do bot (não é gestor)
  // e deixa 'Bug X' pendente, completando a 3ª ocorrência consecutiva
  await conn.sayAs("bob", "/check-in");
  await conn.sayAs("bob", "T1, Bug X");
  await conn.sayAs("bob", "/check-out");
  await conn.sayAs("bob", "T1");
  await conn.sayAs("bob", "Bug X");
  await conn.sayAs("bob", "faltou tempo");

  const alertas = conn.sent.filter((m) => m.to === "gestor");
  assert.ok(alertas.length > 0, "esperava alerta enviado à gestão");
  assert.match(alertas[alertas.length - 1].text, /Bug X/);
});
