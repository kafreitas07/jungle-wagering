import { ConcurrencyConflictError } from '../../application/errors/application-errors';
import { type LoggerPort, type MetricsPort, NoopLogger, NoopMetrics } from '../../application/ports';
import { isTransientConcurrencyError } from '../../application/services/concurrency-retry';
import type { ReprocessPendingReference } from '../../application/use-cases/reprocess-pending-reference';
import { isDependencyFailure } from '../dependency-failure';
import { PollingLoop } from './polling-loop';

export interface WorkerRound {
  readonly due: number;
  readonly processed: number;
  readonly rejected: number;
  readonly stillPending: number;
  readonly skipped: number;
  readonly failed: number;
  /** Left for the next round because of a transient error. They do not use up an attempt. */
  readonly deferred: number;
}

export interface PendingReferenceWorkerOptions {
  readonly intervalMs: number;
  readonly batchSize: number;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
}

/**
 * Reapplies reversals that arrived before their reference (PREF-02..06). Every instance runs one; they coordinate
 * through the database only (the wallet lock), so adding instances never makes two process the same transaction.
 */
export class PendingReferenceWorker {
  private readonly logger: LoggerPort;
  private readonly metrics: MetricsPort;
  private readonly loop: PollingLoop;

  constructor(
    private readonly useCase: ReprocessPendingReference,
    private readonly options: PendingReferenceWorkerOptions,
  ) {
    this.logger = options.logger ?? new NoopLogger();
    this.metrics = options.metrics ?? new NoopMetrics();
    this.loop = new PollingLoop('pending reference worker', options.intervalMs, async () => void (await this.runOnce()), this.logger);
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async runOnce(): Promise<WorkerRound> {
    const due = await this.useCase.findDue(this.options.batchSize);
    const round = { due: due.length, processed: 0, rejected: 0, stillPending: 0, skipped: 0, failed: 0, deferred: 0 };

    for (const target of due) {
      try {
        const result = await this.useCase.execute(target);
        if (result === 'processed') round.processed += 1;
        else if (result === 'rejected') round.rejected += 1;
        else if (result === 'pending') round.stillPending += 1;
        else round.skipped += 1;
      } catch (error) {
        if (isTransient(error)) {
          round.deferred += 1;
          this.logger.warn('pending reference deferred', { transactionId: target.id, errorName: (error as Error)?.name });
          continue;
        }
        round.failed += 1;
        await this.fail(target, error);
      }
    }
    return round;
  }

  private async fail(target: { id: string; walletId: string; kind: string }, error: unknown): Promise<void> {
    this.logger.error('pending reference failed permanently', {
      transactionId: target.id,
      walletId: target.walletId,
      errorName: (error as Error)?.name,
      errorMessage: (error as Error)?.message,
    });
    try {
      if (await this.useCase.markFailed(target)) {
        this.metrics.increment('wager_transactions_total', { kind: target.kind, status: 'FAILED' });
      }
    } catch (markError) {
      // The transaction stays pending and is tried again next round; the original error is already logged.
      this.logger.error('could not mark pending reference as failed', { transactionId: target.id, errorName: (markError as Error)?.name });
    }
  }
}

/** Errors that say "the infrastructure is busy or away", not "this transaction is broken". */
function isTransient(error: unknown): boolean {
  return error instanceof ConcurrencyConflictError || isTransientConcurrencyError(error) || isDependencyFailure(error);
}
