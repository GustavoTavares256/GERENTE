import { test } from "node:test";
import assert from "node:assert/strict";
import { CheckInStore } from "../src/store/CheckInStore.js";

function newStore(): CheckInStore {
  return new CheckInStore(":memory:");
}

test("store: começa sem check-in e sem check-out no dia", () => {
  const store = newStore();
  assert.equal(store.getCheckIn("codxis", "colab-1"), null);
  assert.equal(store.getCheckOut("codxis", "colab-1"), null);
});

test("store: registrar check-in permite lê-lo novamente", () => {
  const store = newStore();
  store.recordCheckIn("codxis", "colab-1", ["A", "B"]);
  const record = store.getCheckIn("codxis", "colab-1");
  assert.ok(record);
  assert.equal(record.tipo, "check_in");
  assert.deepEqual(JSON.parse(record.tarefas), ["A", "B"]);
  assert.equal(store.hasCheckIn("codxis", "colab-1"), true);
});

test("store: registrar check-out grava concluídas, pendentes e justificativa", () => {
  const store = newStore();
  store.recordCheckIn("codxis", "colab-1", ["A", "B"]);
  store.recordCheckOut("codxis", "colab-1", ["A"], ["B"], "sem tempo");

  const checkout = store.getCheckOut("codxis", "colab-1");
  assert.ok(checkout);
  assert.deepEqual(JSON.parse(checkout.tarefas), ["A"]);
  assert.deepEqual(JSON.parse(checkout.pendentes!), ["B"]);
  assert.equal(checkout.justificativa_pendencia, "sem tempo");
  assert.equal(store.hasCheckOut("codxis", "colab-1"), true);
});

test("store: check-in e check-out são isolados por colaborador", () => {
  const store = newStore();
  store.recordCheckIn("codxis", "colab-1", ["A"]);
  assert.equal(store.getCheckIn("codxis", "colab-2"), null);
  assert.equal(store.hasCheckIn("codxis", "colab-2"), false);
});

test("store: check-in sem pendências grava pendentes nulo na resposta", () => {
  const store = newStore();
  store.recordCheckIn("codxis", "colab-1", []);
  const record = store.getCheckIn("codxis", "colab-1");
  assert.ok(record);
  assert.deepEqual(JSON.parse(record.tarefas), []);
});
