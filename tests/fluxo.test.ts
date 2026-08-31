import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CheckInBot,
} from "../src/bot/CheckInBot.js";
import { CheckInStore } from "../src/store/CheckInStore.js";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "../src/channel/ChannelConnector.js";

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

test("fluxo completo: check-in → check-out → /hoje", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  // /check-in pede as tarefas
  await conn.say("/check-in");
  assert.match(lastSent(conn), /Quais são suas tarefas/);

  // registra as tarefas
  await conn.say("Planejar sprint, Reunião");
  assert.match(lastSent(conn), /Check-in registrado/);
  assert.match(lastSent(conn), /Planejar sprint/);

  // /hoje mostra o plano
  await conn.say("/hoje");
  assert.match(lastSent(conn), /Planejadas/);
  assert.match(lastSent(conn), /1\. Planejar sprint/);

  // /check-out pede o que concluiu
  await conn.say("/check-out");
  assert.match(lastSent(conn), /O que você concluiu/);

  // concluídas
  await conn.say("Planejar sprint");
  assert.match(lastSent(conn), /O que ficou pendente/);

  // pendentes
  await conn.say("nenhuma");
  assert.match(lastSent(conn), /Check-out registrado/);
  assert.match(lastSent(conn), /Taxa de aderência/);
});

test("fluxo com pendência: check-out registra pendente e justificativa", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/check-in");
  await conn.say("Tarefa A, Tarefa B");

  await conn.say("/check-out");
  await conn.say("Tarefa A");
  await conn.say("Tarefa B");
  await conn.say("faltou tempo");

  const resumo = lastSent(conn);
  assert.match(resumo, /Check-out registrado/);
  assert.match(resumo, /Pendentes: 1/);
  assert.match(resumo, /Taxa de aderência: 50%/);
});

test("bloqueio: check-out antes de check-in é rejeitado", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/check-out");
  assert.match(lastSent(conn), /não fez o check-in/);
});

test("bloqueio: segundo check-in no mesmo dia é rejeitado", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/check-in");
  await conn.say("Tarefa A");
  await conn.say("/check-in");
  assert.match(lastSent(conn), /já fez o check-in hoje/);
});

test("cancelar aborta o fluxo em andamento", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/check-in");
  await conn.say("cancelar");
  assert.match(lastSent(conn), /Cancelado/);

  // agora /check-out deve reclamar que não há check-in
  await conn.say("/check-out");
  assert.match(lastSent(conn), /não fez o check-in/);
});

test("check-out 100% de aderência quando tudo foi concluído", async () => {
  const store = new CheckInStore(":memory:");
  const bot = new CheckInBot(store);
  const conn = new FakeConnector();
  bot.onConnect(conn);

  await conn.say("/check-in");
  await conn.say("A, B, C");
  await conn.say("/check-out");
  await conn.say("A, B, C");
  await conn.say("nenhuma");

  assert.match(lastSent(conn), /Taxa de aderência: 100%/);
});
