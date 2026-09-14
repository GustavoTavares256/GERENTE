import {
  ChannelConnector,
  IncomingMessage,
} from "../channel/ChannelConnector.js";
import { CheckInRecord, CheckInStore, todayLocal } from "../store/CheckInStore.js";
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

/** Junta as tarefas de todos os check-ins do dia, sem duplicatas (mantém ordem). */
export function planejadosDoDia(checkIns: CheckInRecord[]): string[] {
  const vistos = new Set<string>();
  const plano: string[] = [];
  for (const ci of checkIns) {
    for (const t of JSON.parse(ci.tarefas) as string[]) {
      const key = t.trim().toLowerCase();
      if (!vistos.has(key)) {
        vistos.add(key);
        plano.push(t);
      }
    }
  }
  return plano;
}

export function calcularAderencia(
  planejadas: string[],
  concluidas: string[],
  pendentes: string[]
): Aderencia {
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

// --- Parser simples de listas (aceita 1 por linha, -, *, •, ou vírgula) ---
// Várias linhas = cada linha é uma tarefa (vírgulas/ponto-e-vírgula são
// literais dentro da tarefa). Linha única = aceita separação por , ou ;.
// Uma tarefa começando com "/" (ex.: "/dados") não vira comando: só os
// comandos conhecidos são tratados como comando.
function parseList(text: string): string[] {
  const linhas = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);

  if (linhas.length === 0) return [];
  if (linhas.length > 1) return linhas;

  return linhas[0]
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const COMANDOS = new Set([
  "/E",
  "/E",
  "/S",
  "/S",
  "/hoje",
  "/resumo",
  "/sugestoes",
]);

/** Para cada parte respeitando o limite de caracteres do canal (≈4096). */
function dividirMensagem(texto: string, limite: number = 4000): string[] {
  if (texto.length <= limite) return [texto];
  const partes: string[] = [];
  let atual = "";
  for (const linha of texto.split("\n")) {
    if (atual.length > 0 && atual.length + linha.length + 1 > limite) {
      partes.push(atual);
      atual = "";
    }
    if (linha.length > limite) {
      if (atual) {
        partes.push(atual);
        atual = "";
      }
      let resto = linha;
      while (resto.length > limite) {
        partes.push(resto.slice(0, limite));
        resto = resto.slice(limite);
      }
      atual = resto;
    } else {
      atual = atual ? atual + "\n" + linha : linha;
    }
  }
  if (atual) partes.push(atual);
  return partes;
}

async function enviarEmPartes(
  connector: ChannelConnector,
  to: string,
  texto: string
): Promise<void> {
  for (const parte of dividirMensagem(texto)) {
    await connector.send({ to, text: parte });
  }
}

// --- Pendência recorrente: mesma tarefa pendente por 3+ check-outs seguidos sem justificativa ---
export interface PendenciaRecorrente {
  tarefa: string;
  dias: string[]; // datas (check-out) em que ficou pendente e não justificadas
  diasJustificados: string[]; // datas em que ficou pendente MAS houve justificativa
  justificada: boolean; // se o check-out mais recente tinha justificativa
}

export function detectarPendenciasRecorrentes(
  checkOuts: CheckInRecord[],
  limiteDias: number = 3
): PendenciaRecorrente[] {
  // checkOuts: já ordenados por data ASC.
  // Cada check-out: { data, pendentes (jsonb), justificativa_pendencia }
  // Dias com justificativa NÃO contam para o streak ("3+ dias seguidos sem
  // justificativa"). A flag `justificada` reflete o check-out mais recente.
  const porTarefa = new Map<
    string,
    { original: string; dias: string[]; justificado: Map<string, boolean> }
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
        porTarefa.set(key, {
          original: tarefa,
          dias: [],
          justificado: new Map(),
        });
      }
      const entrada = porTarefa.get(key)!;
      // Se já apareceu no dia (não deveria), evita duplicar
      if (!entrada.dias.includes(co.data)) {
        entrada.dias.push(co.data);
        entrada.justificado.set(co.data, justificado);
      }
    }
  }

  const resultado: PendenciaRecorrente[] = [];
  for (const [key, entrada] of porTarefa) {
    const diasOrdem = [...entrada.dias].sort();

    // Maior sequência de dias CONSECUTIVOS em que ficou pendente SEM justificativa.
    let maior = 0;
    let atual = 0;
    let ultimoDia: string | null = null;
    for (const dia of diasOrdem) {
      if (entrada.justificado.get(dia)) {
        atual = 0;
        ultimoDia = null;
        continue;
      }
      if (atual > 0 && ultimoDia) {
        const anterior = new Date(ultimoDia + "T00:00:00Z");
        const atualD = new Date(dia + "T00:00:00Z");
        if ((atualD.getTime() - anterior.getTime()) / 86400000 !== 1) {
          atual = 0;
        }
      }
      atual++;
      if (atual > maior) maior = atual;
      ultimoDia = dia;
    }

    if (maior >= limiteDias) {
      const ultimoDiaPendente = diasOrdem[diasOrdem.length - 1];
      resultado.push({
        tarefa: entrada.original,
        dias: diasOrdem.filter((d) => !entrada.justificado.get(d)),
        diasJustificados: diasOrdem.filter(
          (d) => entrada.justificado.get(d) === true
        ),
        justificada: Boolean(entrada.justificado.get(ultimoDiaPendente)),
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
      const just = p.diasJustificados.length
        ? ` | justificados: ${p.diasJustificados.map((d) => d.slice(5)).join(", ")}`
        : "";
      return `- ${p.tarefa} — ${dias} ${status}${just}`;
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
}

export class CheckInBot {
  private flows = new Map<string, Flow>();
  private gestaoIds: Set<string>;
  private funcionariosIds: Set<string>;
  private tenantId: string;
  private llm: LLMProvider | null;

  constructor(
    private store: CheckInStore,
    private options: BotOptions = {}
  ) {
    this.gestaoIds = new Set(this.options.gestaoIds ?? []);
    this.funcionariosIds = new Set(this.options.funcionariosIds ?? []);
    this.tenantId = this.options.tenantId ?? TENANT_DEFAULT;
    this.llm =
      this.options.llm === undefined ? new LLMProvider() : this.options.llm;
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
    return todayLocal();
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
        if (!(await this.store.hasCheckIn(this.tenantId, c))) return;
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
    const cmd = msg.text.toLowerCase().split(" ")[0];

    // Comandos conhecidos sempre são comandos (mesmo durante um fluxo).
    // Qualquer outra mensagem durante o fluxo é resposta (ex.: tarefa "/dados").
    if (COMANDOS.has(cmd)) {
      await this.handleCommand(msg, connector);
      return;
    }

    if (flow) {
      await this.advance(sender, flow, msg, connector);
      return;
    }

    await this.handleCommand(msg, connector);
  }

  private async handleCommand(
    msg: IncomingMessage,
    connector: ChannelConnector
  ): Promise<void> {
    const sender = msg.senderId;
    const cmd = msg.text.toLowerCase().split(" ")[0];

    // Texto solto sem fluxo ativo (ex.: "oi", "bugou") → ignora em silêncio,
    // sem devolver a lista de comandos toda vez.
    if (!cmd.startsWith("/")) return;

    switch (cmd) {
      case "/check-in":
      case "/checkin":
        {
          const jaFez = await this.store.hasCheckIn(this.tenantId, sender);
          this.flows.set(sender, { step: "checkin_tarefas" });
          await this.perguntar(
            sender,
            connector,
            jaFez ? "tarefas_extra" : "tarefas",
            jaFez ? "check-in já feito hoje; adicionando novas tarefas" : ""
          );
        }
        return;

      case "/check-out":
      case "/checkout":
        if (!(await this.store.hasCheckIn(this.tenantId, sender))) {
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

      case "/help":
      case "/ajuda":
        await this.listarComandos(sender, connector);
        return;

      default:
        // Comando desconhecido (ex.: /xyz) → mostra a lista de comandos.
        await this.listarComandos(sender, connector);
    }
  }

  /** Mostra a lista de comandos do bot. */
  private async listarComandos(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    await connector.send({
      to: sender,
      text:
        "Comandos:\n/check-in — registrar tarefas do dia\n/check-out — fechar o dia\n/hoje — ver resumo de hoje\n/sugestoes — próximos passos\n/relatorio — relatório de gestão\n/exportar-csv ou /exportar-json — exportar dados (gestão)",
    });
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

    const checkIns = await this.store.getCheckIns(this.tenantId, sender);
    if (checkIns.length === 0) {
      await connector.send({ to: sender, text: "✅ Check-out registrado!" });
      return;
    }

    const aderencia = calcularAderencia(
      planejadosDoDia(checkIns),
      flow.concluidas,
      flow.pendentes
    );
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
  }

  private async verificarEAlertarPendenciasRecorrentes(
    connector: ChannelConnector
  ): Promise<void> {
    if (this.gestaoIds.size === 0) return;

    const recorrentes = await this.listarPendenciasRecorrentes();
    if (recorrentes.length === 0) return;

    const msg = formatarAlertasPendencias(recorrentes);
    for (const gestor of this.gestaoIds) {
      await connector.send({ to: gestor, text: msg });
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

  private async sendResumo(
    sender: string,
    connector: ChannelConnector
  ): Promise<void> {
    const checkIns = await this.store.getCheckIns(this.tenantId, sender);
    if (checkIns.length === 0) {
      await connector.send({
        to: sender,
        text: "Nenhum check-in registrado hoje. Use /check-in.",
      });
      return;
    }

    const planejadas = planejadosDoDia(checkIns);
    const checkOut = await this.store.getCheckOut(this.tenantId, sender);
    let msg = `🗓️ Resumo de hoje:\n\nPlanejadas:\n${planejadas
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
        resumoAderencia(calcularAderencia(planejadas, concluidas, pendentes));
    }

    await connector.send({ to: sender, text: msg });
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
