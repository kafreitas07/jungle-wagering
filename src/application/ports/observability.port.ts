export type Labels = Readonly<Record<string, string>>;

export type CounterName =
  | 'wager_transactions_total'
  | 'wager_rejected_unpersisted_total'
  | 'idempotent_replays_total'
  | 'idempotency_conflicts_total'
  | 'inbox_duplicates_total'
  | 'inbox_payload_conflict_total'
  | 'retries_total'
  | 'dlq_messages_total'
  | 'lock_conflicts_total'
  | 'reconciliation_mismatches_total';

export interface MetricsPort {
  increment(metric: CounterName, labels?: Labels): void;
  observeProcessingDuration(seconds: number, labels?: Labels): void;
}

/** Context carries ids only: never amounts, balances, player ids or payloads. */
export type LogContext = Readonly<Record<string, unknown>>;

export interface LoggerPort {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}
