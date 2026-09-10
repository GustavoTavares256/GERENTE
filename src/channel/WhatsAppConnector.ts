import qrcode from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";
import type WAWebJS from "whatsapp-web.js";
import { createRequire } from "node:module";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "./ChannelConnector.js";

type Client = WAWebJS.Client;
type Message = WAWebJS.Message;

const require = createRequire(import.meta.url);

/** Caminho do Chrome for Testing baixado pelo puppeteer (se disponível). */
function chromeExecutable(): string | undefined {
  try {
    const puppeteer = require("puppeteer") as {
      executablePath?: () => string;
    };
    if (typeof puppeteer.executablePath === "function") {
      return puppeteer.executablePath();
    }
  } catch {
    // puppeteer não resolvido ou Chrome ainda não baixado → usa o padrão
  }
  return undefined;
}

export class WhatsAppConnector implements ChannelConnector {
  readonly name = "whatsapp";
  private client: Client;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor() {
    const { Client, LocalAuth } = whatsapp;
    const chromePath = chromeExecutable();
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: "gerente-codxis" }),
      puppeteer: chromePath
        ? { headless: true, executablePath: chromePath }
        : { headless: true },
    });

    this.client.on("qr", (qr) => {
      qrcode.generate(qr, { small: true });
      console.log("[WhatsApp] Escaneie o QR code acima com o seu celular.");
    });

    this.client.on("ready", () => {
      console.log("[WhatsApp] Conectado e pronto.");
    });

    this.client.on("message", (message: Message) => {
      void this.handleIncoming(message);
    });
  }

  async start(): Promise<void> {
    await this.client.initialize();
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  send(msg: OutgoingMessage): Promise<void> {
    return this.client.sendMessage(msg.to, msg.text).then(() => undefined);
  }

  private async handleIncoming(message: Message): Promise<void> {
    if (this.handler === null) return;
    const incoming: IncomingMessage = {
      senderId: message.from,
      senderName: message.author,
      text: message.body,
      channel: this.name,
    };
    await this.handler(incoming);
  }
}
