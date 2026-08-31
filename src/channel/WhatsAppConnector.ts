import qrcode from "qrcode-terminal";
import whatsapp from "whatsapp-web.js";
import type WAWebJS from "whatsapp-web.js";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "./ChannelConnector.js";

type Client = WAWebJS.Client;
type Message = WAWebJS.Message;

export class WhatsAppConnector implements ChannelConnector {
  readonly name = "whatsapp";
  private client: Client;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  constructor() {
    const { Client, LocalAuth } = whatsapp;
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId: "gerente-codxis" }),
      puppeteer: {
        headless: true,
        executablePath:
          "C:\\Users\\gusta\\.cache\\puppeteer\\chrome\\win64-146.0.7680.31\\chrome-win64\\chrome.exe",
      },
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
