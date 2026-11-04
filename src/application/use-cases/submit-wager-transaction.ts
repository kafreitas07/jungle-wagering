import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InboxPayloadConflictError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../errors/application-errors';
import type { EventContext } from '../../domain/messaging/integration-event';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { type ReferenceRetryPolicy, type WagerKind, WagerTransaction } from '../../domain/wager/wager-transaction';
import { type Clock, type MetricsPort, NoopMetrics, type TxRepositories, type UnitOfWork } from '../ports';
import { ConcurrencyRetry } from '../services/concurrency-retry';
import { applyWagerDecision } from '../services/apply-wager-decision';
import { payloadHash } from '../services/payload-hash';

export interface SubmitWagerTransactionCommand {
  readonly idempotencyKey: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface SubmitResult {
  /** The persisted transaction, in the state the database now holds. */
  readonly transaction: WagerTransaction;
  /** True when this call only returned a transaction that an earlier call already created. */
  readonly replay: boolean;
}

/** Who sent which message: the inbox key `(consumerName, messageId)` and the hash of its payload. */
export interface QueueMessageIdentity {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
}

export type QueueSubmitResult = { readonly duplicate: true } | ({ readonly duplicate: false } & SubmitResult);

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly referencePolicy: ReferenceRetryPolicy;
  /** Reruns the whole transaction on lock timeout, deadlock or lost races. Defaults to the standard policy. */
  readonly concurrencyRetry?: ConcurrencyRetry;
  /** Counts committed outcomes, replays and idempotency conflicts, and times each call. Defaults to no-op. */
  readonly metrics?: MetricsPort;
}

/** The one place where an operation becomes a balance change. Same path for HTTP, SQS and the pending worker. */
export class SubmitWagerTransaction {
  private readonly retry: ConcurrencyRetry;
  private readonly metrics: MetricsPort;

  constructor(private readonly deps: SubmitWagerTransactionDependencies) {
    this.metrics = deps.metrics ?? new NoopMetrics();
    this.retry = deps.concurrencyRetry ?? new ConcurrencyRetry({ metrics: this.metrics });
  }

  execute(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    const money = Money.from(command.money);
    return this.track('http', () => this.retry.run(() => this.deps.unitOfWork.run((tx) => this.process(tx, command, money))));
  }

  /**
   * Metrics are recorded after the commit, from what the database now holds, so a rolled-back attempt counts nothing.
   * Idempotency conflicts are counted here, once, whichever entry point they came through.
   */
  private async track<T extends object>(source: 'http' | 'sqs', work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      const outcome = result as Partial<SubmitResult>;
      if (outcome.transaction !== undefined) {
        if (outcome.replay) {
          this.metrics.increment('idempotent_replays_total');
        } else {
          this.metrics.increment('wager_transactions_total', { kind: outcome.transaction.kind, status: outcome.transaction.status });
        }
      }
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError || error instanceof ExternalIdConflictError) {
        this.metrics.increment('idempotency_conflicts_total');
      }
      throw error;
    } finally {
      this.metrics.observeProcessingDuration((performance.now() - started) / 1000, { source });
    }
  }

  /**
   * The queue entry point. The inbox row is written first, in the same SQL transaction as the financial change and
   * the outbox events, so "message handled" and "effect applied" commit together or not at all.
   * `duplicate`: this message id was already handled with the same payload: nothing is done.
   * A same-id/different-payload message throws `InboxPayloadConflictError`.
   */
  executeFromQueue(command: SubmitWagerTransactionCommand, inbox: QueueMessageIdentity): Promise<QueueSubmitResult> {
    const money = Money.from(command.money);
    return this.track('sqs', () => this.retry.run(() =>
      this.deps.unitOfWork.run(async (tx): Promise<QueueSubmitResult> => {
        const at = this.deps.clock.now();
        const message = InboxMessage.receive({ ...inbox, at });
        message.markProcessed(at);
        const recorded = await tx.inbox.tryRecord(message);
        if (recorded === 'duplicate') {
          return { duplicate: true };
        }
        if (recorded === 'conflict') {
          throw new InboxPayloadConflictError(inbox.consumerName, inbox.messageId);
        }
        return { duplicate: false, ...(await this.process(tx, command, money)) };
      }),
    ));
  }

  private async process(tx: TxRepositories, command: SubmitWagerTransactionCommand, money: Money): Promise<SubmitResult> {
    const wallet = await tx.wallets.lockById(command.walletId);
    if (wallet === null) {
      throw new WalletNotFoundError(command.walletId);
    }
    if (wallet.playerId !== command.playerId) {
      throw new WalletPlayerMismatchError(wallet.id);
    }
    if (wallet.currency !== money.currency) {
      throw new WalletCurrencyMismatchError(wallet.id, money.currency);
    }

    const hash = payloadHash({ ...command, money: money.toJSON() });
    const existing = await tx.transactions.findByIdempotencyKey(command.providerId, command.idempotencyKey);
    if (existing !== null) {
      if (existing.payloadHash !== hash) {
        throw new IdempotencyConflictError(command.providerId, command.idempotencyKey);
      }
      return { transaction: existing, replay: true };
    }
    if ((await tx.transactions.findByExternalId(command.providerId, command.externalTransactionId)) !== null) {
      throw new ExternalIdConflictError(command.providerId, command.externalTransactionId);
    }

    const at = this.deps.clock.now();
    const context: EventContext = {
      correlationId: command.correlationId ?? Bun.randomUUIDv7(),
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      at,
    };
    const transaction = WagerTransaction.create({
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash: hash,
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      ...(command.referenceExternalTransactionId === undefined
        ? {}
        : { referenceExternalTransactionId: command.referenceExternalTransactionId }),
      at,
    });

    await applyWagerDecision({ tx, wallet, transaction, mode: 'create', context, policy: this.deps.referencePolicy, at });
    return { transaction, replay: false };
  }
}
