import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestStore } from "./helpers.js";

test("store: começa sem check-in e sem check-out no dia", async () => {
  const store = await connectTestStore("store");
  try {
    assert.equal(await store.getCheckIn("codxis", "colab-1"), null);
    assert.equal(await store.getCheckOut("codxis", "colab-1"), null);
  } finally {
    await store.close();
  }
});

test("store: registrar check-in permite lê-lo novamente", async () => {
  const store = await connectTestStore("store");
  try {
    await store.recordCheckIn("codxis", "colab-1", ["A", "B"]);
    const record = await store.getCheckIn("codxis", "colab-1");
    assert.ok(record);
    assert.equal(record.tipo, "check_in");
    assert.deepEqual(JSON.parse(record.tarefas), ["A", "B"]);
    assert.equal(await store.hasCheckIn("codxis", "colab-1"), true);
  } finally {
    await store.close();
  }
});

test("store: múltiplos check-ins no dia ficam registrados em ordem", async () => {
  const store = await connectTestStore("store");
  try {
    await store.recordCheckIn("codxis", "colab-1", ["A", "B"]);
    await store.recordCheckIn("codxis", "colab-1", ["C"]);
    const registros = await store.getCheckIns("codxis", "colab-1");
    assert.equal(registros.length, 2);
    assert.deepEqual(JSON.parse(registros[0].tarefas), ["A", "B"]);
    assert.deepEqual(JSON.parse(registros[1].tarefas), ["C"]);
    assert.equal(await store.hasCheckIn("codxis", "colab-1"), true);
  } finally {
    await store.close();
  }
});

test("store: registrar check-out grava concluídas, pendentes e justificativa", async () => {
  const store = await connectTestStore("store");
  try {
    await store.recordCheckIn("codxis", "colab-1", ["A", "B"]);
    await store.recordCheckOut("codxis", "colab-1", ["A"], ["B"], "sem tempo");

    const checkout = await store.getCheckOut("codxis", "colab-1");
    assert.ok(checkout);
    assert.deepEqual(JSON.parse(checkout.tarefas), ["A"]);
    assert.deepEqual(JSON.parse(checkout.pendentes!), ["B"]);
    assert.equal(checkout.justificativa_pendencia, "sem tempo");
    assert.equal(await store.hasCheckOut("codxis", "colab-1"), true);
  } finally {
    await store.close();
  }
});

test("store: check-in e check-out são isolados por colaborador", async () => {
  const store = await connectTestStore("store");
  try {
    await store.recordCheckIn("codxis", "colab-1", ["A"]);
    assert.equal(await store.getCheckIn("codxis", "colab-2"), null);
    assert.equal(await store.hasCheckIn("codxis", "colab-2"), false);
  } finally {
    await store.close();
  }
});

test("store: check-in sem pendências grava pendentes nulo na resposta", async () => {
  const store = await connectTestStore("store");
  try {
    await store.recordCheckIn("codxis", "colab-1", []);
    const record = await store.getCheckIn("codxis", "colab-1");
    assert.ok(record);
    assert.deepEqual(JSON.parse(record.tarefas), []);
  } finally {
    await store.close();
  }
});
