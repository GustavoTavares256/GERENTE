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

function lastSent(conn: FakeConnector): string {
  return conn.sent[conn.sent.length - 1].text;
}

function findSent(conn: FakeConnector, pattern: RegExp): string {
  const msg = [...conn.sent].reverse().find((m) => pattern.test(m.text));
  if (!msg) {
    throw new Error(`Nenhuma mensagem enviada confere com ${pattern}. Enviadas: ${conn.sent.map((m) => m.text).join(" | ")}`);
  }
  return msg.text;
}

async function newBot(): Promise<{ store: CheckInStore; bot: CheckInBot; conn: FakeConnector }> {
  const store = await connectTestStore("fluxo");
  const bot = new CheckInBot(store, {
    llm: null,
    funcionariosIds: ["colab-teste"],
  });
  const conn = new FakeConnector();
  bot.onConnect(conn);
  return { store, bot, conn };
}

test("fluxo completo: check-in → check-out → /hoje", async () => {
  const { store, conn } = await newBot();
  try {
    // /check-in pede as tarefas
    await conn.say("/check-in");
    assert.match(lastSent(conn), /Quais são suas tarefas/);

    // registra as tarefas
    await conn.say("Planejar sprint, Reunião");
    assert.match(lastSent(conn), /Check-in registrado/);
    assert.match(lastSent(conn), /Planejar sprint/);

    // /hoje mostra o plano
    await conn.say("/hoje");
    assert.match(findSent(conn, /Planejadas/), /Planejadas/);
    assert.match(findSent(conn, /Planejadas/), /1\. Planejar sprint/);

    // /check-out pede o que concluiu
    await conn.say("/check-out");
    assert.match(lastSent(conn), /O que você concluiu/);

    // concluídas
    await conn.say("Planejar sprint");
    assert.match(lastSent(conn), /O que ficou pendente/);

    // pendentes
    await conn.say("nenhuma");
    assert.match(findSent(conn, /Check-out registrado/), /Check-out registrado/);
    assert.match(findSent(conn, /Check-out registrado/), /Taxa de aderência/);
  } finally {
    await store.close();
  }
});

test("fluxo com pendência: check-out registra pendente e justificativa", async () => {
  const { store, conn } = await newBot();
  try {
    await conn.say("/check-in");
    await conn.say("Tarefa A, Tarefa B");

    await conn.say("/check-out");
    await conn.say("Tarefa A");
    await conn.say("Tarefa B");
    await conn.say("faltou tempo");

    const resumo = findSent(conn, /Check-out registrado/);
    assert.match(resumo, /Check-out registrado/);
    assert.match(resumo, /Pendentes: 1/);
    assert.match(resumo, /Taxa de aderência: 50%/);
  } finally {
    await store.close();
  }
});

test("bloqueio: check-out antes de check-in é rejeitado", async () => {
  const { store, conn } = await newBot();
  try {
    await conn.say("/check-out");
    assert.match(lastSent(conn), /não fez o check-in/);
  } finally {
    await store.close();
  }
});

test("bloqueio: segundo check-in no mesmo dia é rejeitado", async () => {
  const { store, conn } = await newBot();
  try {
    await conn.say("/check-in");
    await conn.say("Tarefa A");
    await conn.say("/check-in");
    assert.match(lastSent(conn), /já fez o check-in hoje/);
  } finally {
    await store.close();
  }
});

test("cancelar aborta o fluxo em andamento", async () => {
  const { store, conn } = await newBot();
  try {
    await conn.say("/check-in");
    await conn.say("cancelar");
    assert.match(lastSent(conn), /Cancelado/);

    // agora /check-out deve reclamar que não há check-in
    await conn.say("/check-out");
    assert.match(lastSent(conn), /não fez o check-in/);
  } finally {
    await store.close();
  }
});

test("check-out 100% de aderência quando tudo foi concluído", async () => {
  const { store, conn } = await newBot();
  try {
    await conn.say("/check-in");
    await conn.say("A, B, C");
    await conn.say("/check-out");
    await conn.say("A, B, C");
    await conn.say("nenhuma");

    assert.match(findSent(conn, /Taxa de aderência: 100%/), /Taxa de aderência: 100%/);
  } finally {
    await store.close();
  }
});

test("trava de seguranca: remetente fora da lista e ignorado", async () => {
  const store = await connectTestStore("fluxo");
  const bot = new CheckInBot(store, {
    llm: null,
    funcionariosIds: ["permitido@c.us"],
  });
  const conn = new FakeConnector();
  bot.onConnect(conn);
  try {
    // colab-teste NAO esta na lista -> qualquer mensagem e ignorada
    await conn.say("/check-in");
    await conn.say("qualquer coisa");
    assert.equal(conn.sent.length, 0);
  } finally {
    await store.close();
  }
});

test("trava de seguranca: permite quem esta na lista de funcionarios", async () => {
  const store = await connectTestStore("fluxo");
  const bot = new CheckInBot(store, {
    llm: null,
    funcionariosIds: ["colab-teste"],
  });
  const conn = new FakeConnector();
  bot.onConnect(conn);
  try {
    await conn.say("/check-in");
    assert.match(lastSent(conn), /Quais são suas tarefas/);
  } finally {
    await store.close();
  }
});
