import {
  ChannelConnector,
  IncomingMessage,
} from "../channel/ChannelConnector.js";
import { CheckInRecord, CheckInStore } from "../store/CheckInStore.js";
import {
  listarPendenciasRecorrentes as listarPendenciasRecorrentesGestao,
  listarDadosGestao as listarDadosGestaoGestao,
  toCsv,
  toJson,
  dataDesde,
  DadoGestao,
} from "../report/gestao.js";
import {
  contextoEmpresa,
  contextoColaborador,
  sugestoesEmpresa,
  sugestoesColaborador,
  formatarSugestoes,
} from "../ai/Sugestoes.js";
import { LLMProvider } from "../ai/LLMProvider.js";
import { redigirPergunta } from "../ai/Dialogo.js";

// --- Aderência: compara check_out (concluídas/pendentes) com check_in (planejadas) ---
export interface Aderencia {
  planejadas: string[];
  concluidas: string[];
  pendentes: string[];
  naoInformadasNoCheckin: string[];
}

export function calcularAderencia(
  checkIn: CheckInRecord,
  concluidas: string[],
  pendentes: string[]
): Aderencia {
  const planejadas = JSON.parse(checkIn.tarefas) as string[];
  const pendentesNorm = new Set(pendentes.map((t) => t.trim().toLowerCase()));

  const deFatoConcluidas = concluidas.filter(
    (t) => !pendentesNorm.has(t.trim().toLowerCase())
  );

  const planejadasNorm = new Set(planejadas.map((t) => t.trim().toLowerCase()));
  const naoInformadasNoCheckin = pendentes.filter(
    (t) => !planejadasNorm.has(t.trim().toLowerCase())
  );

  return {
    planejadas,
    concluidas: deFatoConcluidas,
    pendentes,
    naoInformadasNoCheckin,
  };
}

export function resumoAderencia(aderencia: Aderencia): string {
  const { planejadas, concluidas, pendentes, naoInformadasNoCheckin } =
    aderencia;
  const taxa = planejadas.length
    ? Math.round((concluidas.length / planejadas.length) * 100)
    : 0;

  let msg = `📋 Resumo do dia:\n`;
  msg += `• Planejadas: ${planejadas.length}\n`;
  msg += `• Concluídas: ${concluidas.length}\n`;
  msg += `• Pendentes: ${pendentes.length}\n`;
  msg += `*Taxa de aderência: ${taxa}%*\n`;

  if (naoInformadasNoCheckin.length > 0) {
    msg += `\n⚠️ Pendências que não estavam no planejamento:\n${naoInformadasNoCheckin
      .map((p) => `- ${p}`)
      .join("\n")}`;
  }
  return msg;
}

// --- Parser simples de listas (aceita 1 por linha, -, *, ou vírgula) ---
function parseList(text: string): string[] {
  return text
    .split(/\n|[,;]/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}

// --- Pendência recorrente: mesma tarefa pendente por 3+ check-outs seguidos sem justificativa ---
export interface PendenciaRecorrente {
  tarefa: string;
  dias: string[]; // datas (check-out) em que ficou pendente e não justificadas
  justificada: boolean; // se o check-out mais recente tinha justificativa
}

export function detectarPendenciasRecorrentes(
  checkOuts: CheckInRecord[],
  limiteDias: number = 3
): PendenciaRecorrente[] {
  // checkOuts: já ordenados por data ASC.
  // Cada check-out: { data, pendentes (jsonb), justificativa_pendencia }
  const porTarefa = new Map<
    string,
    { original: string; dias: string[]; justificado: boolean }
  >();

  for (const co of checkOuts) {
    const pendentes = co.pendentes
      ? (JSON.parse(co.pendentes) as string[])
      : [];
    if (pendentes.length === 0) continue;

    const justificado = Boolean(co.justificativa_pendencia);
    for (const tarefa of pendentes) {
      const key = tarefa.trim().toLowerCase();
      if (!porTarefa.has(key)) {
        porTarefa.set(key, { original: tarefa, dias: [], justificado: false });
      }
      const entrada = porTarefa.get(key)!;
      // Se já apareceu no dia (não deveria), evita duplicar
      if (!entrada.dias.includes(co.data)) {
        entrada.dias.push(co.data);
        // Considera justificada se algo no dia teve justificativa
        entrada.justificado = entrada.justificado || justificado;
      }
    }
  }

  const resultado: PendenciaRecorrente[] = [];
  for (const [key, entrada] of porTarefa) {
    // Dias consecutivos: conta a maior sequência de check-outs seguidos (por data +1 dia)
    const diasOrdem = [...entrada.dias].sort();
    let streak = 1;
    let maior = 1;
    for (let i = 1; i < diasOrdem.length; i++) {
      const anterior = new Date(diasOrdem[i - 1] + "T00:00:00Z");
      const atual = new Date(diasOrdem[i] + "T00:00:00Z");
      const diff = (atual.getTime() - anterior.getTime()) / 86400000;
      if (diff === 1) {
        streak++;
        if (streak > maior) maior = streak;
      } else {
        streak = 1;
      }
    }

    if (maior >= limiteDias) {
      resultado.push({
        tarefa: entrada.original,
        dias: diasOrdem,
        justificada: entrada.justificado,
      });
    }
  }

  return resultado;
}

export function formatarAlertasPendencias(
  pendencias: PendenciaRecorrente[]
): string {
  if (pendencias.length === 0) return "";
  let msg = `⚠️ *Pendências recorrentes (3+ dias seguidos):*\n`;
  msg += pendencias
    .map((p) => {
      const dias = p.dias.map((d) => d.slice(5)).join(", ");
      const status = p.justificada ? "(justificada)" : "(sem justificativa)";
      return `- ${p.tarefa} — ${dias} ${status}`;
    })
    .join("\n");
  return msg;
}

const TENANT_DEFAULT = "codxis";

interface CheckInFlow {
  step: "checkin_tarefas";
}

interface CheckOutFlow {
  step: "checkout_concluidas" | "checkout_pendentes" | "checkout_justificativa";
  concluidas: string[];
  pendentes: string[];
}

type Flow = CheckInFlow | CheckOutFlow;

export interface BotOptions {
  /** IDs de quem pode ver /relatorio e recebe alertas proativos de pendência. */
  gestaoIds?: string[];
  /** Lista fixa de IDs de colaboradores que recebem os envios automáticos dos turnos. */
  funcionariosIds?: string[];
  /** Identificador do tenant (multi-tenant). Padrão: "codxis". */
  tenantId?: string;
  /** Provedor LLM para as sugestões inteligentes. Sem key, usa fallback por regras. */
  llm?: LLMProvider | null;
  /** Envia sugestões proativas após interações relevantes (check-out, /hoje). Padrão: true. */
  sugestoesProativas?: boolean;
}

export class CheckInBot {
  private flows = new Map<string, Flow>();
  private gestaoIds: Set<string>;
  private funcionariosIds: Set<string>;
  private tenantId: string;
  private llm: LLMProvider | null;
  private sugestoesProativas: boolean;

  constructor(
    private store: CheckInStore,
    private options: BotOptions = {}
  ) {
    this.gestaoIds = new Set(this.options.gestaoIds ?? []);
    this.funcionariosIds = new Set(this.options.funcionariosIds ?? []);
    this.tenantId = this.options.tenantId ?? TENANT_DEFAULT;
    this.llm =
      this.options.llm === undefined ? new LLMProvider() : this.options.llm;
    this.sugestoesProativas = this.options.sugestoesProativas ?? true;
  }

  onConnect(connector: ChannelConnector): void {
    connector.onMessage((msg) => this.handle(msg, connector));
  }

  /** Envia a pergunta de um tópico do fluxo, redigida pelo LLM (com fallback). */
  private async perguntar(
    sender: string,
    connector: ChannelConnector,
    topico: string,
    contexto: string = ""
  ): Promise<void> {
    const pergunta = await redigirPergunta(topico, this.llm, contexto);
    await connector.send({ to: sender, text: pergunta });
  }

  // --- Ações dos turnos automáticos (Scheduler) ---
  private hoje(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Turno manhã: lembra todos os colaboradores registrados de fazer o check-in. */
  /** Turno manhã: inicia a conversa guiada de check-in para todos os
   *  colaboradores que ainda não registraram — sem exigir /check-in. */
  async lembrarCheckinTodos(connector: ChannelConnector): Promise<void> {
    const colaboradores = [...this.funcionariosIds];
    if (colaboradores.length === 0) return;
    await Promise.all(
      colaboradores.map(async (c) => {
        if (await this.store.hasCheckIn(this.tenantId, c)) return;
        this.flows.set(c, { step: "checkin_tarefas" });
        await this.perguntar(c, connector, "tarefas", "check-in da manhã");
      })
    );
  }

  /** Turno tarde: cobra o check-in de quem ainda não registrou hoje. */
  async cobrarCheckinNaoFeito(connector: ChannelConnector): Promise<void> {
    const colaboradores = [...this.funcionariosIds];
    const comCheckin = new Set(
      await this.store.listarColaboradoresComCheckinNaData(
        this.tenantId,
        this.hoje()
      )
    );
    const faltantes = colaboradores.filter((c) => !comCheckin.has(c));
    if (faltantes.length === 0) return;
    await Promise.all(
      faltantes.map((c) =>
        connector.send({
          to: c,
          text:
            "⚠️ *Check-in pendente!*\n\n" +
            "Você ainda não registrou suas tarefas de hoje.\n" +
            "Envie /check-in para não perder o acompanhamento do dia.",
        })
      )
    );
  }

  /**
   * Turno fim do dia: inicia a conversa guiada de check-out para quem fez
   * check-in mas ainda não fechou o dia, enviando as sugestões individuais
   * do colaborador junto com a pergunta de check-out. Usa a lista fixa.
   */
  async fecharDia(connector: ChannelConnector): Promise<void> {
    const comCheckout = new Set(
      await this.store.listarColaboradoresComCheckoutNaData(
        this.tenantId,
        this.hoje()
      )
    );
    await Promise.all(
      [...this.funcionariosIds].map(async (c) => {
        if (comCheckout.has(c)) return;
        if (!(await this.store.getCheckIn(this.tenantId, c))) return;
        this.flows.set(c, {
          step: "checkout_concluidas",
          concluidas: [],
          pendentes: [],
        });
        const ctx = await contextoColaborador(this.store, this.tenantId, c);
        const sugestoes = await sugestoesColaborador(this.llm, ctx);
        const sugestoesMsg = formatarSugestoes(
          "💡 *Sugestões para você:*",
          sugestoes
        );
        const pergunta = await redigirPergunta(
          "concluidas",
          this.llm,
          "check-out do fim do dia"
        );
        const corpo = sugestoesMsg
          ? `${sugestoesMsg}\n\n${pergunta}`
          : pergunta;
        await connector.send({ to: c, text: corpo });
      })
    );
  }

  private isGestao(sender: string): boolean {
    return this.gestaoIds.has(sender);
  }

  /** true se o remetente está nas listas permitidas (funcionários ou gestão). */
  private isPermitido(sender: string): boolean {
    return this.funcionariosIds.has(sender) || this.gestaoIds.has(sender);
  }

  private async handle(
    msg: IncomingMessage,
    connector: ChannelConnector
  ): Promise<void> {
    const sender = msg.senderId;

    if (!this.isPermitido(sender)) {
      return;
    }

    if (msg.text.toLowerCase() === "cancelar") {
      this.flows.delete(sender);
      await connector.send({ to: sender, text: "Cancelado." });
      return;
    }

    const flow = this.flows.get(sender);

    if (msg.text.startsWith("/") || !flow) {
      await this.handleCommand(msg, connector);
      return;
    }

    await this.advance(sender, flow, msg, connector);
  }

  private async handleCommand(
    msg: IncomingMessage,
    connector: ChannelConnector
  ): Promise<void> {
    const sender = msg.senderId;
    const cmd = msg.text.toLowerCase().split(" ")[0];

    switch (cmd) {
      case "/check-in":
      case "/checkin":
        if (await this.store.hasCheckIn(this.tenantId, sender)) {
          await connector.send({
            to: sender,
            text: "Você já fez o check-in hoje. Use /hoje para ver o resumo.",
          });
          return;
        }
        this.flows.set(sender, { step: "checkin_tarefas" });
        await this.perguntar(sender, connector, "tarefas");
        return;

      case "/check-out":
      case "/checkout":
        if (!(await this.store.getCheckIn(this.tenantId, sender))) {
          await connector.send({
            to: sender,
            text: "Você ainda não fez o check-in hoje. Use /check-in primeiro.",
          });
          return;
        }
        if (await this.store.hasCheckOut(this.tenantId, sender)) {
          await connector.send({
            to: sender,
            text: "Você já fez o check-out hoje. Use /hoje para ver o resumo.",
          });
          return;
        }
        this.flows.set(sender, {
          step: "checkout_concluidas",
          concluidas: [],
          pendentes: [],
        });
        await this.perguntar(sender, connector, "concluidas");
        return;

      case "/hoje":
      case "/resumo":
        await this.sendResumo(sender, connector);
        return;

      case "/relatorio":
      case "/exportar-csv":
      case "/exportar-json":
        if (!this.isGestao(sender)) {
          await connector.send({
            to: sender,
            text: "Acesso restrito à gestão.",
          });
          return;
        }
        if (cmd === "/exportar-csv") {
          await this.sendExport(sender, connector, "csv");
        } else if (cmd === "/exportar-json") {
          await this.sendExport(sender, connector, "json");
        } else {
          await this.sendRelatorio(sender, connector);
        }
        return;

      case "/sugestoes":
        await this.sendSugestoes(sender, connector);
        return;

      default:
        await connector.send({
          to: sender,
          text:
            "Comandos:\n/check-in — registrar tarefas do dia\n/check-out — fechar o dia\n/hoje — ver resumo de hoje\n/sugestoes — próximos passos\n/relatorio — relatório de gestão\n/exportar-csv ou /exportar-json — exportar dados (gestão)",
        });
    }
  }

  private async advance(
    sender: string,
    flow: Flow,
    msg: IncomingMessage,
    connector: ChannelConnector
  ): Promise<void> {
    if (flow.step === "checkin_tarefas") {
      const tarefas = parseList(msg.text);
      this.flows.delete(sender);
      await this.store.recordCheckIn(this.tenantId, sender, tarefas);
      await connector.send({
        to: sender,
        text:
          `✅ Check-in registrado!\n` +
          tarefas.map((t, i) => `${i + 1}. ${t}`).join("\n") +
          `\n\nAo final do dia, use /check-out.`,
      });
      return;
    }

    // check-out flow
    if (flow.step === "checkout_concluidas") {
      flow.concluidas =
        msg.text.toLowerCase() === "nenhuma" ? [] : parseList(msg.text);
      flow.step = "checkout_pendentes";
      await this.perguntar(sender, connector, "pendentes");
      return;
    }

    if (flow.step === "checkout_pendentes") {
      flow.pendentes =
        msg.text.toLowerCase() === "nenhuma" ? [] : parseList(msg.text);
      if (flow.pendentes.length === 0) {
        this.flows.delete(sender);
        await this.finishCheckout(sender, flow, connector, null);
      } else {
        flow.step = "checkout_justificativa";
        await this.perguntar(sender, connector, "justificativa");
      }
      return;
    }

    if (flow.step === "checkout_justificativa") {
      const justificativa = msg.text.trim();
      this.flows.delete(sender);
      await this.finishCheckout(sender, flow, connector, justificativa);
    }
  }

  private async finishCheckout(
    sender: string,
    flow: CheckOutFlow,
    connector: ChannelConnector,
    justificativa: string | null
  ): Promise<void> {
    await this.store.recordCheckOut(
      this.tenantId,
      sender,
      flow.concluidas,
      flow.pendentes,
      justificativa
    );

    const checkIn = await this.store.getCheckIn(this.tenantId, sender);
    if (!checkIn) {
      await connector.send({ to: sender, text: "✅ Check-out registrado!" });
      return;
    }

    const aderencia = calcularAderencia(checkIn, flow.concluidas, flow.pendentes);
    if (justificativa && flow.pendentes.length > 0) {
      aderencia.naoInformadasNoCheckin.push(
        `Justificativa: ${justificativa}`
      );
    }
    await connector.send({
      to: sender,
      text: "✅ Check-out registrado!\n\n" + resumoAderencia(aderencia),
    });

    await this.verificarEAlertarPendenciasRecorrentes(connector);
    await this.enviarSugestoesProativas(sender, connector);
  }

  private async verificarEAlertarPendenciasRecorrentes(
    connector: ChannelConnector
  ): Promise<void> {
    if (this.gestaoIds.size === 0) return;

    for (const gestor of this.gestaoIds) {
      const recorrentes = await this.listarPendenciasRecorrentes();
      if (recorrentes.length > 0) {
        await connector.send({
          to: gestor,
          text: formatarAlertasPendencias(recorrentes),
        });
      }
    }
  }

  private async listarPendenciasRecorrentes(): Promise<PendenciaRecorrente[]> {
    return listarPendenciasRecorrentesGestao(this.store, this.tenantId);
  }

  private async listarDadosGestao(desdeStr: string): Promise<DadoGestao[]> {
    return listarDadosGestaoGestao(this.store, this.tenantId, desdeStr);
  }

  /** Gera e envia sugestões sob demanda (/sugestoes). Foco conforme o remetente. */
  private async sendSugestoes(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    if (this.isGestao(sender)) {
      const ctx = await contextoEmpresa(this.store, this.tenantId);
      const sugestoes = await sugestoesEmpresa(this.llm, ctx);
      const msg = formatarSugestoes("🧭 *Sugestões do gerente* (empresa):", sugestoes);
      await connector.send({ to: sender, text: msg || "Nenhuma sugestão no momento." });
    } else {
      const ctx = await contextoColaborador(this.store, this.tenantId, sender);
      const sugestoes = await sugestoesColaborador(this.llm, ctx);
      const msg = formatarSugestoes("🧭 *Sugestões do gerente*:", sugestoes);
      await connector.send({ to: sender, text: msg || "Nenhuma sugestão no momento." });
    }
  }

  /** Envia sugestões proativamente após interações relevantes (check-out, /hoje). */
  private async enviarSugestoesProativas(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    if (!this.sugestoesProativas) return;

    if (this.isGestao(sender)) {
      const ctx = await contextoEmpresa(this.store, this.tenantId);
      const sugestoes = await sugestoesEmpresa(this.llm, ctx);
      const msg = formatarSugestoes(
        "🧭 *Próximos passos sugeridos* (empresa):",
        sugestoes
      );
      if (msg) await connector.send({ to: sender, text: msg });
    } else {
      const ctx = await contextoColaborador(this.store, this.tenantId, sender);
      const sugestoes = await sugestoesColaborador(this.llm, ctx);
      const msg = formatarSugestoes("🧭 *Próximos passos pra você*:", sugestoes);
      if (msg) await connector.send({ to: sender, text: msg });
    }
  }

  private async sendResumo(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    const checkIn = await this.store.getCheckIn(this.tenantId, sender);
    if (!checkIn) {
      await connector.send({
        to: sender,
        text: "Nenhum check-in registrado hoje. Use /check-in.",
      });
      return;
    }

    const checkOut = await this.store.getCheckOut(this.tenantId, sender);
    let msg = `🗓️ Resumo de hoje:\n\nPlanejadas:\n${(
      JSON.parse(checkIn.tarefas) as string[]
    )
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n")}`;

    if (!checkOut) {
      msg += `\n\nAinda não fez check-out. Use /check-out quando terminar.`;
    } else {
      const concluidas = JSON.parse(checkOut.tarefas) as string[];
      const pendentes = checkOut.pendentes
        ? (JSON.parse(checkOut.pendentes) as string[])
        : [];
      msg +=
        `\n\n` +
        resumoAderencia(calcularAderencia(checkIn, concluidas, pendentes));
    }

    await connector.send({ to: sender, text: msg });
    await this.enviarSugestoesProativas(sender, connector);
  }

  private async sendRelatorio(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    const colaboradores = await this.store.listColaboradores(this.tenantId);

    let msg = `📊 *Relatório de gestão* (últimos 7 dias):\n`;

    if (colaboradores.length === 0) {
      msg += `\nNenhum registro ainda.`;
      await connector.send({ to: sender, text: msg });
      return;
    }

    const desdeStr = dataDesde();

    let pendenteRecorrenteAlgum = false;

    for (const d of await this.listarDadosGestao(desdeStr)) {
      msg += `\n👤 *${d.colaborador}*\n`;

      if (d.planejadas === 0) {
        msg += `Capacidade: sem planejamento no período.\n`;
      } else {
        msg += `Capacidade (tarefas): planejadas ${d.planejadas}, concluídas ${d.concluidas} (aderência ${d.aderencia}%)\n`;
      }

      if (d.recorrentes.length > 0) {
        pendenteRecorrenteAlgum = true;
        msg += formatarAlertasPendencias(d.recorrentes) + "\n";
      } else {
        msg += `Pendências recorrentes: nenhuma.\n`;
      }
    }

    if (pendenteRecorrenteAlgum) {
      msg += `\n_Alguns colaboradores têm pendências recorrentes. Recomenda-se tratar._`;
    }

    await connector.send({ to: sender, text: msg });
  }

  private async sendExport(
    sender: string,
    connector: ChannelConnector,
    formato: "csv" | "json"
  ): Promise<void> {
    const dados = await this.listarDadosGestao(dataDesde());
    const corpo = formato === "json" ? toJson(dados) : toCsv(dados);
    await connector.send({ to: sender, text: corpo });
  }
}
