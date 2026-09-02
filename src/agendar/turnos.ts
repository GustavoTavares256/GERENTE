// Constrói a configuração (horários + ações) dos turnos automáticos do
// Gerente da Codxis a partir das variáveis de ambiente e do bot.
import { CheckInBot } from "../bot/CheckInBot.js";
import { TurnoDef } from "./Scheduler.js";

export interface TurnosEnv {
  horaCheckin: string; // manhã
  horaCobrancaCheckin: string; // início da tarde
  horaCheckout: string; // fim do dia
  agendadorAtivo: boolean;
}

export function lerEnvTurnos(env: NodeJS.ProcessEnv = process.env): TurnosEnv {
  return {
    horaCheckin: env.HORA_CHECKIN ?? "10:00",
    horaCobrancaCheckin: env.HORA_COBRANCA_CHECKIN ?? "14:30",
    horaCheckout: env.HORA_CHECKOUT ?? "16:30",
    agendadorAtivo: (env.AGENDADOR_ATIVO ?? "true") !== "false",
  };
}

/** Monta os três turnos, conectando cada horário à ação correspondente no bot. */
export function montarTurnos(bot: CheckInBot, env = process.env): TurnoDef[] {
  const { horaCheckin, horaCobrancaCheckin, horaCheckout } =
    lerEnvTurnos(env);

  return [
    {
      id: "manha",
      horario: horaCheckin,
      label: "Lembrete de check-in",
      acao: (connector) => bot.lembrarCheckinTodos(connector),
    },
    {
      id: "tarde",
      horario: horaCobrancaCheckin,
      label: "Cobrança de check-in",
      acao: (connector) => bot.cobrarCheckinNaoFeito(connector),
    },
    {
      id: "fimDoDia",
      horario: horaCheckout,
      label: "Check-out + sugestões para a gestão",
      acao: (connector) => bot.fecharDia(connector),
    },
  ];
}
