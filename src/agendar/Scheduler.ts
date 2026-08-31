// Agendador de turnos do Gerente da Codxis.
// Dispara mensagens automáticas em horários configuráveis, sem depender de
// o usuário digitar comando. Usa o conector de canal (independe do canal:
// console em dev, WhatsApp em produção).
import { ChannelConnector } from "../channel/ChannelConnector.js";

export type TurnoId = "manha" | "tarde" | "fimDoDia";

export interface TurnoDef {
  id: TurnoId;
  horario: string; // "HH:MM"
  label: string;
  acao: (connector: ChannelConnector) => Promise<void>;
}

export interface SchedulerOptions {
  turnos: TurnoDef[];
  /** false desliga o agendador inteiro. Padrão: true */
  ativado?: boolean;
  /** intervalo de checagem em ms. Padrão: 30s */
  intervaloMs?: number;
  /** relógio injetável para teste. Padrão: Date.now */
  clock?: () => Date;
}

/** "HH:MM" → minutos desde meia-noite (0-1439). */
export function paraMinutos(horario: string): number {
  const [h, m] = horario.split(":").map((n) => Number(n));
  return (h || 0) * 60 + (m || 0);
}

/** Converte um Date em "HH:MM" no fuso local. */
export function agoraHHMM(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/**
 * Dado o instante atual, diz quais turnos devem disparar agora (com base no
 * horário e no dia). `jaDisparou` é o conjunto de turnos já executados hoje,
 * para evitar repetição. Função pura → testável.
 */
export function turnosParaDisparar(
  agora: Date,
  turnos: TurnoDef[],
  jaDisparou: Set<TurnoId>
): TurnoDef[] {
  const agoraMin = paraMinutos(agoraHHMM(agora));
  const dia = agora.toDateString();
  // A cada execução que venceu no dia, usamos o dia do disparo para não repetir.
  return turnos.filter((t) => {
    const min = paraMinutos(t.horario);
    return agoraMin >= min && !jaDisparou.has(t.id);
  });
}

/**
 * Agenda os turnos diários. A cada `intervaloMs`, checa se algum turno venceu
 * e dispara a ação correspondente (uma vez por dia por turno).
 */
export class Scheduler {
  private turnos: Map<TurnoId, TurnoDef>;
  private ativado: boolean;
  private intervaloMs: number;
  private clock: () => Date;
  private jaDisparou = new Map<string, Set<TurnoId>>(); // key = toDateString()
  private timer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerOptions) {
    this.turnos = new Map(options.turnos.map((t) => [t.id, t]));
    this.ativado = options.ativado ?? true;
    this.intervaloMs = options.intervaloMs ?? 30_000;
    this.clock = options.clock ?? (() => new Date());
  }

  private async tick(connector: ChannelConnector): Promise<void> {
    if (!this.ativado) return;
    const agora = this.clock();
    const dia = agora.toDateString();
    const ja = this.jaDisparou.get(dia) ?? new Set<TurnoId>();

    for (const turno of turnosParaDisparar(agora, [...this.turnos.values()], ja)) {
      ja.add(turno.id);
      try {
        await turno.acao(connector);
      } catch (err) {
        console.error(`[Scheduler] Falha no turno ${turno.id}:`, err);
      }
    }
    this.jaDisparou.set(dia, ja);

    // limpa registros de dias antigos
    for (const key of this.jaDisparou.keys()) {
      if (key !== dia) this.jaDisparou.delete(key);
    }
  }

  /** Inicia o loop de checagem. */
  start(connector: ChannelConnector): void {
    if (!this.ativado) return;
    this.timer = setInterval(() => void this.tick(connector), this.intervaloMs);
    // primeira checagem imediata (em testes, dispara já se venceu)
    void this.tick(connector);
  }

  /** Para o loop. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Executa uma única checagem (usado em testes). */
  async runOnce(connector: ChannelConnector): Promise<void> {
    await this.tick(connector);
  }

  /** Reseta o estado de "já disparou" (usado em testes). */
  _reset(): void {
    this.jaDisparou.clear();
  }
}
