// Conversa guiada do Gerente da Codxis.
//
// O gerente conduz a conversa seguindo um ROTEIRO FIXO de tópicos (ordem
// sempre a mesma), mas o LLM (ChatGPT) redige cada pergunta de forma natural
// com base no tópico atual. Se o LLM estiver indisponível, usa uma pergunta
// pronta (fallback) — o fluxo nunca trava nem gera loop.
import { LLMProvider } from "./LLMProvider.js";

export type TopicoCheckin = "tarefas";
export type TopicoCheckout =
  | "concluidas"
  | "pendentes"
  | "justificativa"
  | "sugestao";

const FALLBACK: Record<string, string> = {
  tarefas:
    "Quais são suas tarefas para hoje?\n" +
    "Digite uma por linha ou separadas por vírgula.",
  tarefas_extra:
    "Quais novas tarefas você quer adicionar ao check-in de hoje?\n" +
    "Digite uma por linha ou separadas por vírgula.",
  concluidas:
    "O que você concluiu hoje?\n" +
    "Digite uma por linha ou separadas por vírgula.",
  pendentes:
    "O que ficou pendente?\n(envie `nenhuma` se concluiu tudo)",
  justificativa: "Por que essas pendências ocorreram?",
  sugestao:
    "Quer uma sugestão de como resolver o que ficou pendente? (sim/não)",
};

/**
 * Redige a pergunta do tópico atual usando o LLM. Se o LLM não estiver
 * configurado ou falhar, retorna a pergunta pronta (fallback).
 */
export async function redigirPergunta(
  topico: string,
  llm: LLMProvider | null,
  contexto: string = ""
): Promise<string> {
  const fallback = FALLBACK[topico] ?? "Continuando…";
  if (!llm || !llm.isConfigured) return fallback;

  try {
    const sistema =
      "Você é o Gerente da Codxis, no meio de uma conversa de check-in/check-out " +
      "com um colaborador. Você DEVE fazer apenas UMA pergunta por vez, curta e em " +
      "português, sobre o tópico indicado. NÃO responda por ele nem faça outras perguntas. " +
      "Máximo de 2 linhas.";
    const usuario = `Tópico da pergunta: ${topico}.\n${
      contexto ? `Contexto da conversa até aqui:\n${contexto}\n` : ""
    }Escreva apenas a pergunta.`;
    const texto = (await llm.complete(sistema, usuario)).trim();
    return texto || fallback;
  } catch {
    return fallback;
  }
}
