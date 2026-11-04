import { WalletNotFoundError } from '../errors/application-errors';
import type { ReferenceRetryPolicy, TransactionStatus, WagerTransaction } from '../../domain/wager/wager-transaction';
import { type Clock, NoopMetrics, type UnitOfWork } from '../ports';
import { applyWagerDecision } from '../services/apply-wager-decision';
import { ConcurrencyRetry } from '../services/concurrency-retry';

export interface PendingTarget {
  readonly id: string;
  readonly walletId: string;
  readonly kind: string;
}

/** What one reprocessing did to the transaction. `skipped`: someone else already handled it, or it is not due. */
export type ReprocessResult = 'skipped' | 'processed' | 'rejected' | 'pending';

export interface ReprocessPendingReferenceDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly referencePolicy: ReferenceRetryPolicy;
  readonly concurrencyRetry?: ConcurrencyRetry;
}

/**
 * Applies a PENDING_REFERENCE transaction again, with exactly the rules of the synchronous submission
 * (`applyWagerDecision`). The lock order is the same as there: wallet first, then the transaction. That order is
 * what keeps this path and a concurrent submission from deadlocking, and what makes two workers on the same
 * pending transaction safe: the second waits for the wallet, re-reads, finds it no longer pending and leaves.
 */
export class ReprocessPendingReference {
  private readonly retry: ConcurrencyRetry;

  constructor(private readonly deps: ReprocessPendingReferenceDependencies) {
    this.retry = deps.concurrencyRetry ?? new ConcurrencyRetry({ metrics: new NoopMetrics() });
  }

  /** Reads only; nothing is locked here. */
  findDue(limit: number): Promise<PendingTarget[]> {
    return this.deps.unitOfWork.run((tx) => tx.transactions.findDuePending(this.deps.clock.now(), limit));
  }

  execute(target: PendingTarget): Promise<ReprocessResult> {
    return this.retry.run(() =>
      this.deps.unitOfWork.run(async (tx) => {
        const wallet = await tx.wallets.lockById(target.walletId);
        if (wallet === null) {
          throw new WalletNotFoundError(target.walletId);
        }
        const transaction = await tx.transactions.findById(target.id);
        const at = this.deps.clock.now();
        if (transaction === null || !isDue(transaction, at)) {
          return 'skipped';
        }
        await applyWagerDecision({
          tx,
          wallet,
          transaction,
          mode: 'reprocess',
          context: { correlationId: Bun.randomUUIDv7(), causationId: transaction.id, at },
          policy: this.deps.referencePolicy,
          at,
        });
        return resultOf(transaction.status);
      }),
    );
  }

  /**
   * The transaction hit an error that is not about the business rules and will not go away by trying again.
   * It leaves the queue of pending work as FAILED / PROCESSING_FAILED. No rejection event: it was not rejected.
   * Returns false when it was no longer pending (someone else finished it first).
   */
  markFailed(target: PendingTarget): Promise<boolean> {
    return this.retry.run(() =>
      this.deps.unitOfWork.run(async (tx) => {
        await tx.wallets.lockById(target.walletId);
        const transaction = await tx.transactions.findById(target.id);
        if (transaction === null || (transaction.status as TransactionStatus) !== 'PENDING_REFERENCE') {
          return false;
        }
        transaction.fail({ at: this.deps.clock.now() });
        await tx.transactions.save(transaction);
        return true;
      }),
    );
  }
}

function isDue(transaction: WagerTransaction, at: Date): boolean {
  return (
    (transaction.status as TransactionStatus) === 'PENDING_REFERENCE' &&
    transaction.nextAttemptAt !== null &&
    transaction.nextAttemptAt.getTime() <= at.getTime()
  );
}

function resultOf(status: TransactionStatus): ReprocessResult {
  switch (status) {
    case 'PROCESSED':
      return 'processed';
    case 'REJECTED':
      return 'rejected';
    default:
      return 'pending';
  }
}
