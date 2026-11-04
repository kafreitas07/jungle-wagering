import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../errors/application-errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/integration-events';
import type { EventContext } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { WagerRules } from '../../domain/wager/wager-rules';
import { type ReferenceRetryPolicy, type WagerKind, WagerTransaction } from '../../domain/wager/wager-transaction';
import { type Clock, NoopMetrics, type TxRepositories, type UnitOfWork } from '../ports';
import { ConcurrencyRetry } from '../services/concurrency-retry';
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

export interface SubmitWagerTransactionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly referencePolicy: ReferenceRetryPolicy;
  /** Reruns the whole transaction on lock timeout, deadlock or lost races. Defaults to the standard policy. */
  readonly concurrencyRetry?: ConcurrencyRetry;
}

/** The one place where an operation becomes a balance change. Same path for HTTP, SQS and the pending worker. */
export class SubmitWagerTransaction {
  private readonly retry: ConcurrencyRetry;

  constructor(private readonly deps: SubmitWagerTransactionDependencies) {
    this.retry = deps.concurrencyRetry ?? new ConcurrencyRetry({ metrics: new NoopMetrics() });
  }

  execute(command: SubmitWagerTransactionCommand): Promise<SubmitResult> {
    const money = Money.from(command.money);
    return this.retry.run(() => this.deps.unitOfWork.run((tx) => this.process(tx, command, money)));
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

    const reference =
      command.referenceExternalTransactionId === undefined
        ? undefined
        : ((await tx.transactions.findByExternalId(command.providerId, command.referenceExternalTransactionId)) ?? undefined);
    const alreadyReversed = reference === undefined ? false : await tx.transactions.hasProcessedReversal(reference.id);

    const expectedVersion = wallet.version;
    const outcome = WagerRules.decide({
      wallet,
      transaction,
      ...(reference === undefined ? {} : { reference }),
      alreadyReversed,
      at,
    });

    switch (outcome.type) {
      case 'PROCESSED': {
        transaction.markProcessed({
          balanceAfter: wallet.balance,
          at,
          ...(reference === undefined ? {} : { referenceTransactionId: reference.id }),
        });
        await tx.transactions.insert(transaction);
        await this.publish(tx, WagerTransactionProcessed.from(transaction, context));
        if (outcome.entry !== undefined) {
          await tx.wallets.save(wallet, expectedVersion);
          await tx.ledger.append(outcome.entry);
          await this.publish(tx, WalletBalanceChanged.from(wallet, outcome.entry, context));
        }
        break;
      }
      case 'REJECTED': {
        transaction.reject({ failureCode: outcome.code, balanceAfter: wallet.balance, at });
        await tx.transactions.insert(transaction);
        await this.publish(tx, WagerTransactionRejected.from(transaction, context));
        break;
      }
      case 'PENDING_REFERENCE': {
        transaction.markPendingReference({ balanceAfter: wallet.balance, at, policy: this.deps.referencePolicy });
        await tx.transactions.insert(transaction);
        await this.publish(tx, WagerTransactionPendingReference.from(transaction, context));
        break;
      }
    }
    return { transaction, replay: false };
  }

  private publish(tx: TxRepositories, event: Parameters<typeof OutboxMessage.enqueue>[0]): Promise<void> {
    return tx.outbox.enqueue(OutboxMessage.enqueue(event));
  }
}
