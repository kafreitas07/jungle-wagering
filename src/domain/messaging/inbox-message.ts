export interface InboxMessageState {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
}

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly at: Date;
}

/** Record that a queue message was received; `(consumerName, messageId)` is the deduplication key. */
export class InboxMessage {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
  private processed: Date | null;

  private constructor(state: InboxMessageState) {
    this.messageId = state.messageId;
    this.consumerName = state.consumerName;
    this.payloadHash = state.payloadHash;
    this.receivedAt = state.receivedAt;
    this.processed = state.processedAt;
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
      receivedAt: props.at,
      processedAt: null,
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state);
  }

  get processedAt(): Date | null {
    return this.processed;
  }

  isProcessed(): boolean {
    return this.processed !== null;
  }

  markProcessed(at: Date): void {
    this.processed = at;
  }
}
