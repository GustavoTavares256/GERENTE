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
import { connectTestStore } from "./helpers.js";

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

test("detectarPendenciasRecorrentes: dias com justificativa interrompem o streak", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-26", ["Bug A"], "aguardando cliente"),
    co("2026-08-27", ["Bug A"], "aguardando cliente"),
    co("2026-08-28", ["Bug A"], "aguardando cliente"),
  ]);
  assert.equal(res.length, 0);
});

test("detectarPendenciasRecorrentes: streak sem justificativa terminando em dia justificado é marcada como justificada", () => {
  const res = detectarPendenciasRecorrentes([
    co("2026-08-26", ["Bug A"], null),
    co("2026-08-27", ["Bug A"], null),
    co("2026-08-28", ["Bug A"], null),
    co("2026-08-29", ["Bug A"], "aguardando cliente"),
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

async function newBot(gestaoIds: string[]): Promise<{ store: CheckInStore; bot: CheckInBot; conn: FakeConnector }> {
  const store = await connectTestStore("pendencia");
  const bot = new CheckInBot(store, {
    gestaoIds,
    funcionariosIds: ["gestor", "colab-teste", "colab-ok", "bob", "ana"],
    llm: null,
  });
  const conn = new FakeConnector();
  bot.onConnect(conn);
  return { store, bot, conn };
}

test("/relatorio: valida capacidade (tarefas) e alerta de pendência recorrente", async () => {
  const { store, conn } = await newBot(["gestor"]);
  try {
    for (const off of [-2, -1, 0]) {
      const dia = offsetDate(off);
      await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-teste", data: dia, tipo: "check_in", tarefas: ["T1", "T2", "T3"] });
      await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-teste", data: dia, tipo: "check_out", tarefas: [], pendentes: ["Bug A"] });
    }
    // um dia extra (fora da janela contínua) com tudo concluído
    const diaExtra = offsetDate(-4);
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-teste", data: diaExtra, tipo: "check_in", tarefas: ["X"] });
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-teste", data: diaExtra, tipo: "check_out", tarefas: ["X"] });

    // segundo colaborador sem pendências recorrentes
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-ok", data: offsetDate(0), tipo: "check_in", tarefas: ["Y"] });
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "colab-ok", data: offsetDate(0), tipo: "check_out", tarefas: ["Y"] });

    await conn.say("/relatorio");
    const msg = conn.sent[conn.sent.length - 1].text;

    assert.match(msg, /colab-teste/);
    assert.match(msg, /colab-ok/);

    // capacidade do colab-teste: planejadas = 3+3+3+1 = 10, concluídas = 0+0+0+1 = 1 → aderência 10%
    assert.match(msg, /planejadas 10, concluídas 1 \(aderência 10%\)/);

    assert.match(msg, /Bug A/);
    assert.match(msg, /Pendências recorrentes/);
  } finally {
    await store.close();
  }
});

test("/relatorio: bloqueia usuário que não é da gestão", async () => {
  const { store, conn } = await newBot(["gestor-admin"]);
  try {
    await conn.say("/relatorio");
    assert.match(conn.sent[conn.sent.length - 1].text, /Acesso restrito à gestão/);
  } finally {
    await store.close();
  }
});

test("/exportar-csv: gestor recebe CSV com cabeçalho e dados", async () => {
  const { store, conn } = await newBot(["gestor"]);
  try {
    const dia = offsetDate(0);
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: dia, tipo: "check_in", tarefas: ["T1", "T2"] });
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: dia, tipo: "check_out", tarefas: ["T1"], pendentes: [] });

    await conn.say("/exportar-csv");
    const csv = conn.sent[conn.sent.length - 1].text;
    assert.match(csv, /colaborador,planejadas,concluidas,aderencia_pct,pendencia_recorrente/);
    assert.match(csv, /"ana",2,1,50,""/);
  } finally {
    await store.close();
  }
});

test("/exportar-json: gestor recebe JSON estruturado", async () => {
  const { store, conn } = await newBot(["gestor"]);
  try {
    const dia = offsetDate(0);
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: dia, tipo: "check_in", tarefas: ["T1"] });
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: dia, tipo: "check_out", tarefas: ["T1"], pendentes: [] });

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
  } finally {
    await store.close();
  }
});

test("alerta proativo: gestor recebe aviso quando há pendência recorrente", async () => {
  const { store, conn } = await newBot(["gestor"]);
  try {
    // semear 3 dias de pendência 'Bug X' sem justificativa para o colaborador 'bob'
    for (const off of [-3, -2, -1]) {
      const dia = offsetDate(off);
      await store.seedRecord({ tenantId: "codxis", colaboradorId: "bob", data: dia, tipo: "check_out", tarefas: [], pendentes: ["Bug X"] });
    }

    // 'bob' faz check-in e check-out hoje pelo fluxo do bot (não é gestor)
    // e deixa 'Bug X' pendente. O streak sem justificativa já atingiu 3 dias
    // nos dias semeados; a justificativa de hoje não o interrompe.
    await conn.sayAs("bob", "/entrada");
    await conn.sayAs("bob", "T1, Bug X");
    await conn.sayAs("bob", "/saida");
    await conn.sayAs("bob", "T1");
    await conn.sayAs("bob", "Bug X");
    await conn.sayAs("bob", "faltou tempo");

    const alertas = conn.sent.filter((m) => m.to === "gestor");
    assert.ok(alertas.length > 0, "esperava alerta enviado à gestão");
    assert.match(alertas[alertas.length - 1].text, /Bug X/);
  } finally {
    await store.close();
  }
});
