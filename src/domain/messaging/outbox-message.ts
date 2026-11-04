import type { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly groupKey: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lockedUntil: Date | null;
  readonly publishedAt: Date | null;
  readonly lastError: string | null;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

/** An event waiting to be published. Written in the same SQL transaction as the change that caused it. */
export class OutboxMessage {
  private constructor(private state: OutboxMessageState) {}

  /** The event id is the message id, which later becomes the queue deduplication id. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      groupKey: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON() as unknown as Record<string, unknown>,
      occurredAt: event.occurredAt,
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      lockedUntil: null,
      publishedAt: null,
      lastError: null,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(state);
  }

  get id(): string {
    return this.state.id;
  }

  get aggregateId(): string {
    return this.state.aggregateId;
  }

  /** Becomes the queue MessageGroupId: the wallet. */
  get groupKey(): string {
    return this.state.groupKey;
  }

  get eventType(): string {
    return this.state.eventType;
  }

  get payload(): Readonly<Record<string, unknown>> {
    return this.state.payload;
  }

  get occurredAt(): Date {
    return this.state.occurredAt;
  }

  get attempts(): number {
    return this.state.attempts;
  }

  get nextAttemptAt(): Date {
    return this.state.nextAttemptAt;
  }

  get lockedUntil(): Date | null {
    return this.state.lockedUntil;
  }

  get publishedAt(): Date | null {
    return this.state.publishedAt;
  }

  get lastError(): string | null {
    return this.state.lastError;
  }

  isPending(): boolean {
    return this.state.publishedAt === null;
  }

  /** Pending, past its backoff and not under a live lease held by another publisher. */
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      this.state.nextAttemptAt.getTime() <= now.getTime() &&
      (this.state.lockedUntil === null || this.state.lockedUntil.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.state = { ...this.state, publishedAt: at, lockedUntil: null };
  }

  /** A failed publication: count it, back off (1 s, 2 s, 4 s … 60 s), release the lease. Never discards. */
  scheduleRetry(now: Date, error?: string): void {
    const attempts = this.state.attempts + 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
    this.state = {
      ...this.state,
      attempts,
      nextAttemptAt: new Date(now.getTime() + delay),
      lockedUntil: null,
      lastError: error ?? this.state.lastError,
    };
  }

  toState(): OutboxMessageState {
    return this.state;
  }
}
