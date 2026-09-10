import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcularAderencia,
  planejadosDoDia,
  resumoAderencia,
} from "../src/bot/CheckInBot.js";

function checkInRecord(tarefas: string[]) {
  return {
    id: 1,
    tenantId: "codxis",
    colaboradorId: "colab-1",
    data: "2026-08-28",
    tipo: "check_in" as const,
    tarefas: JSON.stringify(tarefas),
    pendentes: null,
    justificativa_pendencia: null,
    criadoEm: "2026-08-28T10:00:00.000Z",
  };
}

test("calcularAderencia: 100% de aderência quando tudo planejado foi concluído e nada ficou pendente", () => {
  const a = calcularAderencia(
    ["A", "B"],
    ["A", "B"],
    []
  );
  assert.deepEqual(a.concluidas, ["A", "B"]);
  assert.deepEqual(a.pendentes, []);
  assert.deepEqual(a.naoInformadasNoCheckin, []);
});

test("calcularAderencia: tarefa que consta como concluída e também como pendente é retirada das concluídas", () => {
  const a = calcularAderencia(
    ["A", "B"],
    ["A", "B", "C"],
    ["C"]
  );
  assert.deepEqual(a.concluidas, ["A", "B"]);
  assert.deepEqual(a.pendentes, ["C"]);
  assert.deepEqual(a.naoInformadasNoCheckin, ["C"]);
});

test("calcularAderencia: matching por similaridade ignora maiúsculas e espaços em excesso", () => {
  const a = calcularAderencia(
    ["Relatório Mensal", "Reunião"],
    ["relatório mensal", "  Reunião  "],
    []
  );
  assert.deepEqual(a.concluidas, ["relatório mensal", "  Reunião  "]);
  assert.deepEqual(a.naoInformadasNoCheckin, []);
});

test("calcularAderencia: tratando pendência não informada no check-in como fora do plano", () => {
  const a = calcularAderencia(
    ["A"],
    [],
    ["Tarefa nova"]
  );
  assert.deepEqual(a.naoInformadasNoCheckin, ["Tarefa nova"]);
  assert.deepEqual(a.concluidas, []);
});

test("calcularAderencia: sem plano definido, taxa é 0", () => {
  const a = calcularAderencia([], ["A"], []);
  assert.deepEqual(a.concluidas, ["A"]);
  assert.deepEqual(a.pendentes, []);
});

test("planejadosDoDia: junta tarefas de múltiplos check-ins sem duplicar", () => {
  const plano = planejadosDoDia([
    checkInRecord(["A", "B"]),
    checkInRecord(["B", "C"]),
    checkInRecord([]),
  ]);
  assert.deepEqual(plano, ["A", "B", "C"]);
});

test("resumoAderencia: taxa de 50% quando metade das planejadas foram concluídas", () => {
  const msg = resumoAderencia(
    calcularAderencia(["A", "B"], ["A"], [])
  );
  assert.match(msg, /\*Taxa de aderência: 50%\*/);
});

test("resumoAderencia: aponta pendências fora do planejamento quando existem", () => {
  const msg = resumoAderencia(
    calcularAderencia(["A"], [], ["Extra"])
  );
  assert.match(msg, /não estavam no planejamento/);
  assert.match(msg, /Extra/);
});

test("resumoAderencia: não menciona pendências fora do plano quando não há", () => {
  const msg = resumoAderencia(
    calcularAderencia(["A"], ["A"], [])
  );
  assert.doesNotMatch(msg, /não estavam no planejamento/);
});
