import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "./ChannelConnector.js";

/**
 * Conector de canal via UAZAPI (provedor de WhatsApp por API REST).
 * Substitui o whatsapp-web.js na produção: não precisa de QR no terminal,
 * a sessão do WhatsApp vive na instância UAZAPI (pairing feito no painel deles).
 *
 * - Envio  : POST {base}/send/text  (header `token`, body {number, text})
 * - Recepção: SSE em {base}/sse?token=...&events=messages (funciona local,
 *   sem expor URL pública), com reconexão exponencial.
 *
 * Configuração (env):
 *   UAZAPI_BASE_URL  (padrão https://free.uazapi.com)
 *   UAZAPI_TOKEN     (token da instância)
 */
export class UazapiConnector implements ChannelConnector {
  readonly name = "uazapi";

  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;
  private readonly baseUrl: string;
  private readonly token: string;
  private running = false;

  constructor(options?: { baseUrl?: string; token?: string }) {
    this.baseUrl =
      (options?.baseUrl ?? process.env.UAZAPI_BASE_URL)?.replace(/\/+$/, "") ||
      "https://free.uazapi.com";
    this.token =
      options?.token ?? process.env.UAZAPI_TOKEN ?? "";
  }

  /** Abre a conexão SSE para receber mensagens em tempo real. */
  async start(): Promise<void> {
    if (!this.token) {
      console.warn(
        "[Uazapi] UAZAPI_TOKEN não configurado. Configure UAZAPI_BASE_URL e UAZAPI_TOKEN."
      );
      return;
    }
    this.running = true;
    void this.listenSse();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  /** Envia uma mensagem de texto via POST /send/text. */
  async send(msg: OutgoingMessage): Promise<void> {
    if (!this.token) {
      throw new Error("[Uazapi] UAZAPI_TOKEN não configurado.");
    }
    const res = await fetch(`${this.baseUrl}/send/text`, {
      method: "POST",
      headers: {
        token: this.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        number: apenasDigitos(msg.to),
        text: msg.text,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[Uazapi] Falha ao enviar (${res.status}): ${await res.text()}`
      );
    }
  }

  private async listenSse(): Promise<void> {
    let delay = 5000;
    while (this.running) {
      try {
        const res = await fetch(
          `${this.baseUrl}/sse?token=${encodeURIComponent(this.token)}&events=messages`
        );
        if (res.status === 401) {
          console.error(
            "[Uazapi] Token inválido ou instância removida. Encerrando reconexões."
          );
          this.running = false;
          return;
        }
        if (!res.ok || !res.body) {
          throw new Error(`SSE status ${res.status}`);
        }
        delay = 5000; // conectou: reseta o backoff
        console.log("[Uazapi] SSE conectado. Aguardando mensagens...");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            await this.dispatchEvent(part);
          }
        }
      } catch (e) {
        console.error("[Uazapi] SSE desconectado.", e);
      }
      if (!this.running) break;
      console.log(`[Uazapi] Reconectando em ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60000);
    }
  }

  private async dispatchEvent(chunk: string): Promise<void> {
    if (this.handler === null) return;
    const data = extrairDadoSSE(chunk);
    if (!data) return;

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }

    // Formato real do SSE da UAZAPI:
    // { EventType: "messages", message: { content, text, fromMe, isGroup,
    //   sender_pn, senderName, mediaType, type }, chat: { wa_chatid, wa_isGroup } }
    if (payload.EventType && payload.EventType !== "messages") return;

    const msg = payload.message ?? payload;
    const chat = payload.chat ?? {};
    if (!msg || typeof msg !== "object") return;

    // Ignora as próprias mensagens (loop): o dono do número não consegue
    // testar consigo mesmo, mas os funcionários respondem com fromMe=false.
    if (msg.fromMe || msg.wasSentByApi) return;
    // Só conversas 1:1 — o bot não responde em grupos.
    if (msg.isGroup || chat.wa_isGroup || /@g\.us/i.test(msg.chatid || "")) return;
    // Só texto (ignora mídia: imagem, áudio, vídeo, doc, sticker...).
    if (msg.type && msg.type !== "text") return;
    if (msg.mediaType && msg.mediaType !== "chat" && msg.mediaType !== "text") return;

    const senderRaw = String(msg.sender_pn || msg.sender || msg.chatid || "");
    if (!senderRaw) return;
    const texto = extrairTexto(msg);
    if (!texto) return;

    const incoming: IncomingMessage = {
      senderId: normalizarSendor(senderRaw),
      senderName: msg.senderName || undefined,
      text: texto,
      channel: this.name,
    };
    console.log(
      `[Uazapi] Mensagem recebida de ${incoming.senderId}: "${texto}"`
    );
    await this.handler(incoming);
  }
}

/** Converte o sender da UAZAPI (número puro ou JID) para `<digitos>@c.us`. */
function normalizarSendor(raw: string): string {
  const digitos = apenasDigitos(raw);
  return digitos ? `${digitos}@c.us` : raw;
}

/** Extrai o texto de texto de uma mensagem (content pode ser objeto). */
function extrairTexto(msg: any): string {
  const candidatos = [
    typeof msg.content === "string" ? msg.content : undefined,
    msg.content?.text,
    typeof msg.text === "string" ? msg.text : undefined,
    msg.body,
  ];
  for (const c of candidatos) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function apenasDigitos(v: string): string {
  return String(v ?? "").replace(/\D/g, "");
}

/** Extrai o conteúdo do campo `data:` de um bloco SSE. */
function extrairDadoSSE(chunk: string): string | null {
  const linhas: string[] = [];
  for (const linha of chunk.split(/\r?\n/)) {
    const t = linha.trim();
    if (t.startsWith("data:")) {
      linhas.push(t.slice(5).trimStart());
    }
  }
  return linhas.length ? linhas.join("\n") : null;
}
