// Interface independente de canal.
// O restante do sistema só conhece esta interface.
export interface IncomingMessage {
  senderId: string;
  senderName?: string;
  text: string;
  channel: string;
}

export interface OutgoingMessage {
  to: string;
  text: string;
}

export interface ChannelConnector {
  readonly name: string;
  start(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  send(msg: OutgoingMessage): Promise<void>;
}
