import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckInBot } from "../src/bot/CheckInBot.js";
import { CheckInStore } from "../src/store/CheckInStore.js";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "../src/channel/ChannelConnector.js";
import { connectTestStore } from "./helpers.js";
import {
  Scheduler,
  turnosParaDisparar,
  paraMinutos,
  agoraHHMM,
  TurnoDef,
} from "../src/agendar/Scheduler.js";
import { montarTurnos, lerEnvTurnos } from "../src/agendar/turnos.js";
import { LLMProvider } from "../src/ai/LLMProvider.js";

class FakeConnector implements ChannelConnector {
  readonly name = "fake";
  sent: OutgoingMessage[] = [];
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  async start(): Promise<void> {}

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }

  async say(text: string): Promise<void> {
    if (!this.handler) throw new Error("sem handler");
    await this.handler({ senderId: "colab-teste", text, channel: this.name });
  }
}

function findSent(conn: FakeConnector, pattern: RegExp): string {
  const msg = [...conn.sent].reverse().find((m) => pattern.test(m.text));
  if (!msg) {
    throw new Error(
      `Nenhuma mensagem confere com ${pattern}. Enviadas: ${conn.sent
        .map((m) => `${m.to}: ${m.text}`)
        .join(" | ")}`
    );
  }
  return msg.text;
}

class FakeLLM implements LLMProvider {
  readonly isConfigured = true;
  async complete(): Promise<string> {
    return "Sugestão gerada pelo fake LLM.";
  }
}

// ── Funções puras do Scheduler ─────────────────────────────────────────────

test("paraMinutos converte HH:MM em minutos", () => {
  assert.equal(paraMinutos("08:00"), 480);
  assert.equal(paraMinutos("00:05"), 5);
  assert.equal(paraMinutos("23:59"), 1439);
});

test("agoraHHMM usa o relógio local", () => {
  const d = new Date(2026, 0, 5, 8, 30); // 08:30 local
  assert.equal(agoraHHMM(d), "08:30");
});

function turno(id: string, horario: string, acao?: () => Promise<void>): TurnoDef {
  return {
    id: id as TurnoDef["id"],
    horario,
    label: id,
    acao: acao ?? (async () => {}),
  };
}

test("turnosParaDisparar: dispara os turnos já vencidos", () => {
  const turnos = [turno("manha", "08:00"), turno("tarde", "14:00"), turno("fimDoDia", "17:30")];
  const agora = new Date(2026, 0, 5, 18, 0); // 18:00 local
  const disparar = turnosParaDisparar(agora, turnos, new Set());
  const ids = disparar.map((t) => t.id).sort();
  assert.deepEqual(ids, ["fimDoDia", "manha", "tarde"]);
});

test("turnosParaDisparar: não dispara turno cujo horário ainda não chegou", () => {
  const turnos = [turno("manha", "08:00"), turno("fimDoDia", "17:30")];
  const agora = new Date(2026, 0, 5, 9, 0); // 09:00 local
  const disparar = turnosParaDisparar(agora, turnos, new Set());
  assert.deepEqual(disparar.map((t) => t.id), ["manha"]);
});

test("turnosParaDisparar: não repete turno já disparado hoje", () => {
  const turnos = [turno("manha", "08:00")];
  const agora = new Date(2026, 0, 5, 18, 0);
  const ja = new Set<TurnoDef["id"]>(["manha"]);
  assert.deepEqual(turnosParaDisparar(agora, turnos, ja), []);
});

test("Scheduler.runOnce dispara a ação do turno uma vez por dia", async () => {
  const conn = new FakeConnector();
  let chamadas = 0;
  const defs = [turno("manha", "08:00", async () => { chamadas++; })];
  let agora = new Date(2026, 0, 5, 9, 0);
  const scheduler = new Scheduler({
    turnos: defs,
    ativado: true,
    clock: () => agora,
  });
  await scheduler.runOnce(conn);
  assert.equal(chamadas, 1);
  // segunda checagem no mesmo dia: não repete
  await scheduler.runOnce(conn);
  assert.equal(chamadas, 1);
  // dia seguinte: dispara de novo
  agora = new Date(2026, 0, 6, 9, 0);
  await scheduler.runOnce(conn);
  assert.equal(chamadas, 2);
});

test("Scheduler desativado não dispara nada", async () => {
  const conn = new FakeConnector();
  let chamadas = 0;
  const scheduler = new Scheduler({
    turnos: [turno("manha", "08:00", async () => { chamadas++; })],
    ativado: false,
    clock: () => new Date(2026, 0, 5, 9, 0),
  });
  await scheduler.runOnce(conn);
  assert.equal(chamadas, 0);
});

// ── montarTurnos / lerEnvTurnos ────────────────────────────────────────────

test("lerEnvTurnos usa padrões quando não há env", () => {
  const env = lerEnvTurnos({});
  assert.equal(env.horaCheckin, "08:00");
  assert.equal(env.horaCobrancaCheckin, "14:00");
  assert.equal(env.horaCheckout, "17:30");
  assert.equal(env.agendadorAtivo, true);
});

test("lerEnvTurnos respeita o .env e AGENDADOR_ATIVO=false", () => {
  const env = lerEnvTurnos({
    HORA_CHECKIN: "09:15",
    HORA_COBRANCA_CHECKIN: "15:00",
    HORA_CHECKOUT: "18:45",
    AGENDADOR_ATIVO: "false",
  });
  assert.equal(env.horaCheckin, "09:15");
  assert.equal(env.horaCobrancaCheckin, "15:00");
  assert.equal(env.horaCheckout, "18:45");
  assert.equal(env.agendadorAtivo, false);
});

test("montarTurnos cria os três turnos com horários corretos", () => {
  const bot = {} as CheckInBot;
  const turnos = montarTurnos(bot, {
    HORA_CHECKIN: "08:30",
    HORA_COBRANCA_CHECKIN: "14:30",
    HORA_CHECKOUT: "18:00",
  });
  assert.equal(turnos.length, 3);
  assert.equal(turnos[0].id, "manha");
  assert.equal(turnos[0].horario, "08:30");
  assert.equal(turnos[1].id, "tarde");
  assert.equal(turnos[1].horario, "14:30");
  assert.equal(turnos[2].id, "fimDoDia");
  assert.equal(turnos[2].horario, "18:00");
});

// ── Ações dos turnos no bot (lista fixa configurada) ───────────────────────

const hoje = new Date().toISOString().slice(0, 10);

test("lembrarCheckinTodos envia para a lista fixa de funcionários", async () => {
  const store = await connectTestStore("agendador_lembrar");
  const conn = new FakeConnector();
  const bot = new CheckInBot(store, {
    funcionariosIds: ["f1@c.us", "f2@c.us"],
    gestaoIds: [],
    llm: new FakeLLM() as unknown as LLMProvider,
  });
  await bot.lembrarCheckinTodos(conn);
  const destinos = conn.sent.map((m) => m.to).sort();
  assert.deepEqual(destinos, ["f1@c.us", "f2@c.us"]);
  assert.match(conn.sent[0].text, /check-in/i);
});

test("cobrarCheckinNaoFeito cobra só quem não fez check-in hoje", async () => {
  const store = await connectTestStore("agendador_tarde");
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "f1@c.us",
    data: hoje,
    tipo: "check_in",
    tarefas: ["Tarefa A"],
  });
  const conn = new FakeConnector();
  const bot = new CheckInBot(store, {
    funcionariosIds: ["f1@c.us", "f2@c.us"],
    gestaoIds: [],
    llm: new FakeLLM() as unknown as LLMProvider,
  });
  await bot.cobrarCheckinNaoFeito(conn);
  const destinos = conn.sent.map((m) => m.to).sort();
  assert.deepEqual(destinos, ["f2@c.us"]);
});

test("fecharDia não envia check-out para quem já fez, e envia sugestão ao gestor", async () => {
  const store = await connectTestStore("agendador_fimdodia");
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "f1@c.us",
    data: hoje,
    tipo: "check_in",
    tarefas: ["Tarefa A"],
  });
  await store.seedRecord({
    tenantId: "codxis",
    colaboradorId: "f1@c.us",
    data: hoje,
    tipo: "check_out",
    tarefas: ["Tarefa A"],
    pendentes: [],
  });
  const conn = new FakeConnector();
  const bot = new CheckInBot(store, {
    funcionariosIds: ["f1@c.us", "f2@c.us"],
    gestaoIds: ["gestor@c.us"],
    sugestoesProativas: true,
    llm: new FakeLLM() as unknown as LLMProvider,
  });
  await bot.fecharDia(conn);
  // f1 fez check-out → não é cobrado; f2 (lista fixa, sem check-out) → cobrado
  assert.equal(conn.sent.some((m) => m.to === "f1@c.us" && /check-out/i.test(m.text)), false);
  assert.equal(conn.sent.some((m) => m.to === "f2@c.us" && /check-out/i.test(m.text)), true);
  // gestor recebe sugestão do fim do dia
  assert.equal(conn.sent.some((m) => m.to === "gestor@c.us" && /fim do dia/i.test(m.text)), true);
});
