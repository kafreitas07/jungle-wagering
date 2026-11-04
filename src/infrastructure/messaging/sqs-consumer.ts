import { createHash } from 'node:crypto';
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../application/errors/application-errors';
import { type LoggerPort, type MetricsPort, NoopLogger, NoopMetrics } from '../../application/ports';
import { canonicalJson } from '../../application/services/payload-hash';
import type { SubmitWagerTransaction, SubmitWagerTransactionCommand } from '../../application/use-cases/submit-wager-transaction';
import { DomainError } from '../../domain/errors/domain-errors';
import { type WagerTransactionRequestedMessage, wagerTransactionRequestedSchema } from '../contracts/wager.contract';
import { runWithLogScope } from '../observability/log-context';
import { InFlight, isFinalReceive, visibilityBackoffSeconds } from './sqs-consumer-resilience';
import type { ReceivedMessage, SqsAdapter } from './sqs.adapter';

/** The inbox key. One consumer of one queue, so a message id is unique within it. */
export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export interface SqsConsumerOptions {
  readonly queue: string;
  readonly dlq: string;
  readonly pollWaitSeconds: number;
  /** The redrive policy's maxReceiveCount of `queue`. */
  readonly maxReceiveCount: number;
  /** How long `stop()` waits for the messages in progress. */
  readonly shutdownGraceMs: number;
  readonly batchSize?: number;
  /** Test only. Kills the process after the commit and before the acknowledgement. */
  readonly faultInjection?: 'crash-after-commit-before-ack' | undefined;
}

export interface SqsConsumerDependencies {
  readonly adapter: SqsAdapter;
  readonly submit: SubmitWagerTransaction;
  readonly metrics?: MetricsPort;
  readonly logger?: LoggerPort;
}

type Disposition =
  | { readonly action: 'ack' }
  | { readonly action: 'dead-letter'; readonly reason: string }
  | { readonly action: 'retry'; readonly error: unknown };

/**
 * Consumes `wager-transactions.fifo` with the same guarantees as the HTTP API (SQS-01..13).
 *
 * The message is acknowledged only after its SQL transaction committed. Invalid messages and conflicts go to the DLQ
 * and are acknowledged (nothing was written). Transient failures are left unacknowledged with a backoff, and the
 * queue's redrive policy moves them to the DLQ after `maxReceiveCount` deliveries.
 */
export class SqsConsumer {
  private readonly metrics: MetricsPort;
  private readonly logger: LoggerPort;
  private readonly inFlight = new InFlight<ReceivedMessage>();
  private running = false;
  private stopping = false;
  private abort = new AbortController();
  private loopDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: SqsConsumerDependencies,
    private readonly options: SqsConsumerOptions,
  ) {
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.logger = deps.logger ?? new NoopLogger();
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.abort = new AbortController();
    this.loopDone = this.loop();
  }

  /**
   * Stops fetching, lets the messages in progress finish for up to `shutdownGraceMs`, and hands the visibility of
   * anything unfinished back to the queue (`ChangeMessageVisibility 0`) so another instance picks it up at once.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.stopping = true;
    this.running = false;
    this.abort.abort();

    const finished = await Promise.race([
      this.loopDone.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.options.shutdownGraceMs).unref()),
    ]);
    if (!finished) {
      this.logger.warn('consumer shutdown grace period elapsed', { unfinished: this.inFlight.size });
    }
    await Promise.all(this.inFlight.remaining().map((message) => this.release(message)));
  }

  /** Processes messages already received. The polling loop uses it; tests can drive it directly. */
  async processBatch(messages: readonly ReceivedMessage[]): Promise<void> {
    for (const message of messages) {
      this.inFlight.add(message);
    }
    // One FIFO group is processed in order; different groups in parallel.
    const groups = new Map<string, ReceivedMessage[]>();
    for (const message of messages) {
      const key = message.groupId ?? message.sqsMessageId;
      groups.set(key, [...(groups.get(key) ?? []), message]);
    }
    await Promise.all([...groups.values()].map((group) => this.processGroup(group)));
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let messages: ReceivedMessage[];
      try {
        messages = await this.deps.adapter.receive(this.options.queue, {
          maxMessages: this.options.batchSize ?? 10,
          waitSeconds: this.options.pollWaitSeconds,
          signal: this.abort.signal,
        });
      } catch (error) {
        if (!this.running) {
          return;
        }
        this.logger.error('receive failed', { errorName: (error as Error)?.name, errorMessage: (error as Error)?.message });
        await sleep(1000, this.abort.signal);
        continue;
      }
      if (messages.length > 0) {
        await this.processBatch(messages);
      }
    }
  }

  private async processGroup(group: readonly ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.stopping) {
        await Promise.all(group.slice(index).map((rest) => this.release(rest)));
        return;
      }
      const disposition = await this.handle(message);
      const settled = await this.settle(message, disposition);
      this.inFlight.remove(message);
      if (!settled) {
        // The next messages of this wallet must not overtake this one: give them back untouched.
        await Promise.all(group.slice(index + 1).map((rest) => this.release(rest)));
        return;
      }
    }
  }

  /** Decides what happens to a message. Never throws. */
  private async handle(message: ReceivedMessage): Promise<Disposition> {
    let json: unknown;
    try {
      json = JSON.parse(message.body);
    } catch {
      this.logger.warn('malformed message: not JSON', { sqsMessageId: message.sqsMessageId });
      return { action: 'dead-letter', reason: 'malformed_json' };
    }
    const parsed = wagerTransactionRequestedSchema.safeParse(json);
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(root)'))].join(',');
      this.logger.warn('malformed message: invalid contract', { sqsMessageId: message.sqsMessageId, paths });
      return { action: 'dead-letter', reason: `invalid_contract: ${paths}`.slice(0, 200) };
    }

    const { messageId, data } = parsed.data;
    const logIds = { messageId, sqsMessageId: message.sqsMessageId, receiveCount: message.receiveCount };
    return runWithLogScope({ correlationId: messageId, messageId }, () => this.apply(parsed.data, logIds));
  }

  private async apply(message: WagerTransactionRequestedMessage, logIds: Record<string, unknown>): Promise<Disposition> {
    const { messageId, data } = message;
    try {
      const result = await this.deps.submit.executeFromQueue(toCommand(message), {
        consumerName: WAGER_CONSUMER_NAME,
        messageId,
        payloadHash: messageHash(data),
      });
      if (result.duplicate) {
        this.metrics.increment('inbox_duplicates_total');
        this.logger.info('duplicate message acknowledged', logIds);
        return { action: 'ack' };
      }
      if (this.options.faultInjection === 'crash-after-commit-before-ack' && !result.replay) {
        // The effect is committed; dying here is exactly the crash the inbox exists to survive.
        process.kill(process.pid, 'SIGKILL');
      }
      return { action: 'ack' };
    } catch (error) {
      return this.classify(error, message, logIds);
    }
  }

  private classify(error: unknown, message: WagerTransactionRequestedMessage, logIds: Record<string, unknown>): Disposition {
    if (error instanceof InboxPayloadConflictError) {
      this.metrics.increment('inbox_payload_conflict_total');
      this.logger.error('message id reused with a different payload', logIds);
      return { action: 'dead-letter', reason: 'inbox_payload_conflict' };
    }
    if (error instanceof IdempotencyConflictError || error instanceof ExternalIdConflictError) {
      this.logger.error('idempotency conflict', { ...logIds, code: error.code });
      return { action: 'dead-letter', reason: error.code.toLowerCase() };
    }
    if (error instanceof WalletNotFoundError || error instanceof WalletPlayerMismatchError || error instanceof WalletCurrencyMismatchError) {
      // Nothing was stored and a resend would fail the same way: acknowledge, but leave a trace.
      this.metrics.increment('wager_rejected_unpersisted_total', { code: error.code });
      this.logger.warn('message refused before processing', { ...logIds, code: error.code });
      return { action: 'ack' };
    }
    if (error instanceof DomainError) {
      this.logger.warn('message violates a domain rule', { ...logIds, errorName: error.name });
      return { action: 'dead-letter', reason: `domain_error: ${error.name}` };
    }
    return { action: 'retry', error };
  }

  /** Carries out the disposition. Returns false when the message is left for redelivery. */
  private async settle(message: ReceivedMessage, disposition: Disposition): Promise<boolean> {
    try {
      switch (disposition.action) {
        case 'ack':
          await this.deps.adapter.delete(this.options.queue, message.receiptHandle);
          return true;
        case 'dead-letter':
          await this.deadLetter(message, disposition.reason);
          return true;
        case 'retry':
          await this.scheduleRetry(message, disposition.error);
          return false;
      }
    } catch (error) {
      // The effect is already committed (or nothing was done). Redelivery is safe: the inbox answers "duplicate".
      this.logger.error('could not settle message', {
        sqsMessageId: message.sqsMessageId,
        action: disposition.action,
        errorName: (error as Error)?.name,
        errorMessage: (error as Error)?.message,
      });
      return false;
    }
  }

  private async deadLetter(message: ReceivedMessage, reason: string): Promise<void> {
    // Group and deduplication id come from the original message, so a crash between the two calls repeats harmlessly.
    await this.deps.adapter.send(this.options.dlq, {
      body: message.body,
      groupId: message.groupId ?? 'unrouted',
      deduplicationId: message.sqsMessageId,
      attributes: { failureReason: reason, sourceQueue: this.options.queue, sourceMessageId: message.sqsMessageId },
    });
    await this.deps.adapter.delete(this.options.queue, message.receiptHandle);
    this.metrics.increment('dlq_messages_total', { reason: reason.split(':')[0] ?? reason });
  }

  private async scheduleRetry(message: ReceivedMessage, error: unknown): Promise<void> {
    const final = isFinalReceive(message.receiveCount, this.options.maxReceiveCount);
    this.logger.error('transient failure, message left for redelivery', {
      sqsMessageId: message.sqsMessageId,
      receiveCount: message.receiveCount,
      willDeadLetter: final,
      errorName: (error as Error)?.name,
      errorMessage: (error as Error)?.message,
    });
    this.metrics.increment('retries_total', { reason: 'sqs_redelivery' });
    if (final) {
      // The next delivery attempt is the one the queue turns into a move to the DLQ: release it now and count it.
      this.metrics.increment('dlq_messages_total', { reason: 'max_receives' });
      await this.deps.adapter.changeVisibility(this.options.queue, message.receiptHandle, 0);
      return;
    }
    await this.deps.adapter.changeVisibility(this.options.queue, message.receiptHandle, visibilityBackoffSeconds(message.receiveCount));
  }

  /** Gives a message back to the queue right away, without counting it as a failure. */
  private async release(message: ReceivedMessage): Promise<void> {
    try {
      await this.deps.adapter.changeVisibility(this.options.queue, message.receiptHandle, 0);
    } catch (error) {
      this.logger.warn('could not release message', { sqsMessageId: message.sqsMessageId, errorName: (error as Error)?.name });
    } finally {
      this.inFlight.remove(message);
    }
  }
}

function toCommand(message: WagerTransactionRequestedMessage): SubmitWagerTransactionCommand {
  const { data } = message;
  return {
    idempotencyKey: data.idempotencyKey,
    providerId: data.providerId,
    externalTransactionId: data.externalTransactionId,
    playerId: data.playerId,
    walletId: data.walletId,
    roundId: data.roundId,
    gameId: data.gameId,
    kind: data.kind,
    money: data.money,
    ...(data.referenceExternalTransactionId === undefined ? {} : { referenceExternalTransactionId: data.referenceExternalTransactionId }),
    correlationId: message.messageId,
    causationId: message.messageId,
  };
}

/** Hash of everything the producer sent in `data`, so the same message id with other content is detected. */
function messageHash(data: WagerTransactionRequestedMessage['data']): string {
  return createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
