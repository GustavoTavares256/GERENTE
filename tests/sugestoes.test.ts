import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckInBot } from "../src/bot/CheckInBot.js";
import { CheckInStore } from "../src/store/CheckInStore.js";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "../src/channel/ChannelConnector.js";
import {
  regrasEmpresa,
  regrasColaborador,
  sugestoesEmpresa,
  sugestoesColaborador,
  formatarSugestoes,
  ContextoEmpresa,
  ContextoColaborador,
} from "../src/ai/Sugestoes.js";
import { LLMProvider, LLMError } from "../src/ai/LLMProvider.js";
import { connectTestStore } from "./helpers.js";

function offsetDate(offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

class FakeLLM implements LLMProvider {
  readonly isConfigured = true;
  calls: Array<{ system: string; user: string }> = [];
  private reply: string;
  constructor(reply: string) {
    this.reply = reply;
  }
  async complete(system: string, user: string): Promise<string> {
    this.calls.push({ system, user });
    return this.reply;
  }
}

class ThrowingLLM implements LLMProvider {
  readonly isConfigured = true;
  async complete(): Promise<string> {
    throw new LLMError("API indisponível");
  }
}

// ── Heurísticas (fallback) ────────────────────────────────────────────────

test("regrasEmpresa: alerta colaboradores sem check-in hoje", () => {
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 80,
    totalPlanejadas: 10,
    totalConcluidas: 8,
    semCheckinHoje: ["carlos", "maria"],
    colaboradores: [],
  };
  const sugs = regrasEmpresa(ctx);
  assert.ok(sugs.some((s) => s.area === "participação" && /carlos/.test(s.acao)));
});

test("regrasEmpresa: alerta pendência recorrente", () => {
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 90,
    totalPlanejadas: 10,
    totalConcluidas: 9,
    semCheckinHoje: [],
    colaboradores: [
      {
        colaborador: "ana",
        planejadas: 3,
        concluidas: 2,
        aderencia: 66,
        recorrentes: [{ tarefa: "Bug X", dias: ["a", "b", "c"], justificada: false }],
      },
    ],
  };
  const sugs = regrasEmpresa(ctx);
  assert.ok(sugs.some((s) => s.area === "pendência recorrente" && /Bug X/.test(s.acao)));
});

test("regrasEmpresa: sugere revisar capacidade quando aderência baixa", () => {
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 40,
    totalPlanejadas: 20,
    totalConcluidas: 8,
    semCheckinHoje: [],
    colaboradores: [],
  };
  const sugs = regrasEmpresa(ctx);
  assert.ok(sugs.some((s) => s.area === "capacidade" && /40%/.test(s.acao)));
});

test("regrasColaborador: sugere check-in se não fez hoje", () => {
  const ctx: ContextoColaborador = {
    nome: "ana",
    planejadas: 0,
    concluidas: 0,
    aderencia: -1,
    recorrentes: [],
    checkinHoje: false,
    checkoutHoje: false,
  };
  const sugs = regrasColaborador(ctx);
  assert.ok(sugs.some((s) => s.area === "planejamento"));
});

test("regrasColaborador: sugere check-out se check-in feito mas sem fechamento", () => {
  const ctx: ContextoColaborador = {
    nome: "ana",
    planejadas: 2,
    concluidas: 1,
    aderencia: 50,
    recorrentes: [],
    checkinHoje: true,
    checkoutHoje: false,
  };
  const sugs = regrasColaborador(ctx);
  assert.ok(sugs.some((s) => s.area === "fechamento"));
});

test("regrasColaborador: alerta pendência recorrente do colaborador", () => {
  const ctx: ContextoColaborador = {
    nome: "ana",
    planejadas: 3,
    concluidas: 0,
    aderencia: 0,
    recorrentes: ["Bug X"],
    checkinHoje: true,
    checkoutHoje: true,
  };
  const sugs = regrasColaborador(ctx);
  assert.ok(sugs.some((s) => s.area === "pendência recorrente" && /Bug X/.test(s.acao)));
});

test("formatarSugestoes: monta mensagem com título e emojis de prioridade", () => {
  const msg = formatarSugestoes("Título", [{ area: "x", acao: "fazer algo", prioridade: "alta" }]);
  assert.match(msg, /Título/);
  assert.match(msg, /fazer algo/);
  assert.match(msg, /🔴/);
  assert.equal(formatarSugestoes("T", []), "");
});

// ── LLM e fallback ────────────────────────────────────────────────────────

test("sugestoesEmpresa: usa o LLM quando configurado", async () => {
  const fake = new FakeLLM("- Fazer A\n- Fazer B\n- Fazer C");
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 90,
    totalPlanejadas: 10,
    totalConcluidas: 9,
    semCheckinHoje: [],
    colaboradores: [],
  };
  const sugs = await sugestoesEmpresa(fake, ctx);
  assert.equal(sugs.length, 3);
  assert.equal(sugs[0].acao, "Fazer A");
  assert.ok(fake.calls.length === 1);
});

test("sugestoesEmpresa: cai no fallback por regras se o LLM falhar", async () => {
  const fake = new ThrowingLLM();
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 40,
    totalPlanejadas: 20,
    totalConcluidas: 8,
    semCheckinHoje: ["carlos"],
    colaboradores: [],
  };
  const sugs = await sugestoesEmpresa(fake, ctx);
  assert.ok(sugs.some((s) => s.area === "capacidade"));
  assert.ok(sugs.some((s) => s.area === "participação"));
});

test("sugestoesEmpresa: usa fallback quando não há LLM configurado", async () => {
  const ctx: ContextoEmpresa = {
    tenantId: "codxis",
    aderenciaGeral: 40,
    totalPlanejadas: 20,
    totalConcluidas: 8,
    semCheckinHoje: ["carlos"],
    colaboradores: [],
  };
  const sugs = await sugestoesEmpresa(null, ctx);
  assert.ok(sugs.length > 0);
});

// ── Integração no bot ─────────────────────────────────────────────────────

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
  async sayAs(sender: string, text: string): Promise<void> {
    if (!this.handler) throw new Error("sem handler");
    await this.handler({ senderId: sender, text, channel: this.name });
  }
}

test("bot: não envia sugestão proativa após o check-out (só nos turnos)", async () => {
  const store = await connectTestStore("sugestoes");
  try {
    // colaborador tem pendência recorrente nos últimos 7 dias → regras gerariam sugestão
    for (const off of [-2, -1]) {
      const dia = offsetDate(off);
      await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: dia, tipo: "check_out", tarefas: [], pendentes: ["Bug X"] });
    }
    const bot = new CheckInBot(store, { llm: null, funcionariosIds: ["ana"] });
    const conn = new FakeConnector();
    bot.onConnect(conn);

    await conn.sayAs("ana", "/check-in");
    await conn.sayAs("ana", "T1, Bug X");
    await conn.sayAs("ana", "/check-out");
    await conn.sayAs("ana", "T1");
    await conn.sayAs("ana", "Bug X");
    await conn.sayAs("ana", "faltou tempo");

    const msgs = conn.sent.map((m) => m.text).join("\n");
    assert.match(msgs, /Bug X/);
    assert.doesNotMatch(msgs, /Próximos passos|Sugestões/);
  } finally {
    await store.close();
  }
});

test("bot: /sugestoes para gestão retorna visão de empresa", async () => {
  const store = await connectTestStore("sugestoes");
  try {
    await store.seedRecord({ tenantId: "codxis", colaboradorId: "ana", data: offsetDate(0), tipo: "check_in", tarefas: ["T1"] });
    const bot = new CheckInBot(store, { gestaoIds: ["gestor"], llm: null });
    const conn = new FakeConnector();
    bot.onConnect(conn);

    await conn.sayAs("gestor", "/sugestoes");
    const msg = conn.sent[conn.sent.length - 1].text;
    assert.match(msg, /Sugestões do gerente/);
  } finally {
    await store.close();
  }
});

test("bot: /sugestoes para colaborador retorna visão individual", async () => {
  const store = await connectTestStore("sugestoes");
  try {
    const bot = new CheckInBot(store, { llm: null, funcionariosIds: ["ana"] });
    const conn = new FakeConnector();
    bot.onConnect(conn);

    await conn.sayAs("ana", "/sugestoes");
    const msg = conn.sent[conn.sent.length - 1].text;
    assert.match(msg, /não registrou o check-in|check-in/);
  } finally {
    await store.close();
  }
});
