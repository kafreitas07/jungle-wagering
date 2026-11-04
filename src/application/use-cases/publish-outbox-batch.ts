import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { type Clock, type EventPublisherPort, type LoggerPort, type MetricsPort, NoopLogger, NoopMetrics, type UnitOfWork } from '../ports';

export interface PublishOutboxBatchDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly publisher: EventPublisherPort;
  readonly clock: Clock;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
  readonly batchSize?: number;
  /** How long a claim hides the rows from other publishers. A crashed publisher's rows come back after this. */
  readonly leaseMs?: number;
}

export interface PublishOutboxResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export const DEFAULT_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_OUTBOX_LEASE_MS = 30_000;

/**
 * One round of the outbox publisher, in three steps with no SQL transaction open during the network call:
 * 1. a short transaction claims rows (`FOR UPDATE SKIP LOCKED` + `locked_until`) and commits;
 * 2. the batch goes to the queue;
 * 3. a short transaction records the result per message: published, or `attempts + 1` with backoff.
 * A crash after step 1 leaves the lease to expire; a crash after step 2 republishes, which the queue deduplicates
 * by event id and consumers deduplicate again.
 */
export class PublishOutboxBatch {
  private readonly logger: LoggerPort;
  private readonly metrics: MetricsPort;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  constructor(private readonly deps: PublishOutboxBatchDependencies) {
    this.logger = deps.logger ?? new NoopLogger();
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.batchSize = deps.batchSize ?? DEFAULT_OUTBOX_BATCH_SIZE;
    this.leaseMs = deps.leaseMs ?? DEFAULT_OUTBOX_LEASE_MS;
  }

  async execute(): Promise<PublishOutboxResult> {
    const claimed = await this.deps.unitOfWork.run((tx) => tx.outbox.claimDue(this.deps.clock.now(), this.batchSize, this.leaseMs));
    if (claimed.length === 0) {
      return { claimed: 0, published: 0, failed: 0 };
    }

    const failures = new Map<string, string>();
    try {
      const result = await this.deps.publisher.publishBatch(claimed);
      for (const failure of result.failed) {
        failures.set(failure.id, failure.error);
      }
      // Anything the queue did not confirm counts as failed: an event is never assumed published.
      const confirmed = new Set(result.published);
      for (const message of claimed) {
        if (!confirmed.has(message.id) && !failures.has(message.id)) {
          failures.set(message.id, 'not confirmed by the queue');
        }
      }
    } catch (error) {
      const reason = describe(error);
      for (const message of claimed) {
        failures.set(message.id, reason);
      }
    }

    const at = this.deps.clock.now();
    await this.deps.unitOfWork.run(async (tx) => {
      for (const message of claimed) {
        const failure = failures.get(message.id);
        if (failure === undefined) {
          message.markPublished(at);
        } else {
          message.scheduleRetry(at, failure);
        }
        await tx.outbox.save(message);
      }
    });

    for (let failed = 0; failed < failures.size; failed += 1) {
      this.metrics.increment('retries_total', { reason: 'outbox_publish' });
    }
    if (failures.size > 0) {
      this.logger.warn('outbox publication failed', { failed: failures.size, claimed: claimed.length, ...firstFailure(claimed, failures) });
    }
    return { claimed: claimed.length, published: claimed.length - failures.size, failed: failures.size };
  }
}

function firstFailure(claimed: readonly OutboxMessage[], failures: ReadonlyMap<string, string>): Record<string, unknown> {
  const message = claimed.find((candidate) => failures.has(candidate.id));
  return message === undefined ? {} : { eventId: message.id, attempts: message.attempts, reason: failures.get(message.id) };
}

/** Name and first line only, bounded: this text is stored in `last_error` and logged. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${typeof code === 'string' ? code : error.name}: ${error.message.split('\n')[0] ?? ''}`.slice(0, 200);
  }
  return 'unknown error';
}
