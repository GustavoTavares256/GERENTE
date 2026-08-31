// Inicia o agendador de turnos acoplado ao bot e ao conector de canal,
// a partir das variáveis de ambiente. Reutilizado pelos entrypoints.
import { CheckInBot } from "../bot/CheckInBot.js";
import { ChannelConnector } from "../channel/ChannelConnector.js";
import { Scheduler } from "./Scheduler.js";
import { montarTurnos, lerEnvTurnos } from "./turnos.js";

export function iniciarAgendador(
  bot: CheckInBot,
  connector: ChannelConnector
): Scheduler {
  const env = lerEnvTurnos();
  const turnos = montarTurnos(bot);
  const scheduler = new Scheduler({
    turnos,
    ativado: env.agendadorAtivo,
  });
  scheduler.start(connector);
  return scheduler;
}
