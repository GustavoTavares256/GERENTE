import readline from "node:readline/promises";
import {
  ChannelConnector,
  IncomingMessage,
  OutgoingMessage,
} from "./ChannelConnector.js";

export class ConsoleConnector implements ChannelConnector {
  readonly name = "console";
  private rl: readline.Interface | null = null;
  private handler: ((msg: IncomingMessage) => Promise<void>) | null = null;

  async start(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });

    console.log(
      "[Console] Bot no console. Digite /entrada, /saida, /hoje ou cancelar.",
    );

    while (true) {
      let linha: string;
      try {
        linha = await this.rl.question("você > ");
      } catch {
        break; // stdin fechou (EOF em uso via pipe) → encerra com elegância
      }
      if (linha === null) break;
      if (this.handler === null) continue;
      const text = linha.trim();
      if (!text) continue;
      if (text.toLowerCase() === "sair") {
        console.log("[Console] Encerrando.");
        this.rl.close();
        process.exit(0);
      }
      await this.handler({
        senderId: "console-local",
        senderName: "teste",
        text,
        channel: this.name,
      });
    }
    this.rl.close();
    console.log("[Console] Entrada encerrada. Até a próxima!");
  }

  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.handler = handler;
  }

  async send(msg: OutgoingMessage): Promise<void> {
    console.log(`bot   > ${msg.text}`);
  }
}
