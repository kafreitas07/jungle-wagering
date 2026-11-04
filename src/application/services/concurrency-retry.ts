import { ConcurrencyConflictError } from '../errors/application-errors';
import { type MetricsPort, OptimisticLockError } from '../ports';
import { SQLSTATE, isUniqueViolation, sqlState } from './sql-errors';

/** Unique constraints whose violation means "someone else got there first": the retry will see their row. */
const RACE_CONSTRAINTS = ['wager_transactions_idempotency_key', 'wager_transactions_external_id', 'wager_transactions_single_reversal'];

const TRANSIENT_STATES: readonly string[] = [SQLSTATE.lockNotAvailable, SQLSTATE.serializationFailure, SQLSTATE.deadlockDetected];

/** Waits before each retry, before jitter. Three retries make four attempts. */
const BACKOFF_MS = [20, 60, 180] as const;

export interface ConcurrencyRetryDependencies {
  readonly metrics: MetricsPort;
  readonly sleep?: (ms: number) => Promise<void>;
  /** In [0, 1). Replaceable so tests can pin the jitter. */
  readonly random?: () => number;
}

export function isTransientConcurrencyError(error: unknown): boolean {
  if (error instanceof OptimisticLockError) {
    return true;
  }
  const state = sqlState(error);
  if (state !== undefined && TRANSIENT_STATES.includes(state)) {
    return true;
  }
  return RACE_CONSTRAINTS.some((constraint) => isUniqueViolation(error, constraint));
}

/**
 * Runs a whole unit of work again when the database reports a concurrency conflict. It sits OUTSIDE the
 * transaction: every attempt opens a new one, so the rerun deduplicates against whatever the winner committed.
 */
export class ConcurrencyRetry {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: ConcurrencyRetryDependencies) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = deps.random ?? Math.random;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isTransientConcurrencyError(error)) {
          throw error;
        }
        const base = BACKOFF_MS[attempt];
        if (base === undefined) {
          throw new ConcurrencyConflictError(attempt + 1, error);
        }
        this.deps.metrics.increment('lock_conflicts_total');
        await this.sleep(Math.round(base * (0.75 + 0.5 * this.random())));
      }
    }
  }
}
