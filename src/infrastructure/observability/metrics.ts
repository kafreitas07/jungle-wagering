import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CounterName, Labels, MetricsPort } from '../../application/ports';

/** Labels each counter accepts. Anything else passed by a caller is dropped instead of breaking the request. */
const COUNTERS: Record<CounterName, { help: string; labels: readonly string[] }> = {
  wager_transactions_total: { help: 'Transactions that reached a final or pending state, by kind and status.', labels: ['kind', 'status'] },
  wager_rejected_unpersisted_total: { help: 'Messages refused before anything was stored (unknown wallet, player or currency mismatch).', labels: ['code'] },
  idempotent_replays_total: { help: 'Requests answered with the result of an earlier identical request.', labels: [] },
  idempotency_conflicts_total: { help: 'Requests that reused an idempotency key or external id with a different content.', labels: [] },
  inbox_duplicates_total: { help: 'Queue messages recognised by the inbox as already handled.', labels: [] },
  inbox_payload_conflict_total: { help: 'Queue messages whose id was already received with a different payload.', labels: [] },
  retries_total: { help: 'Retries, by reason.', labels: ['reason'] },
  dlq_messages_total: { help: 'Messages sent or released to the dead letter queue, by reason.', labels: ['reason'] },
  lock_conflicts_total: { help: 'Lock timeouts, deadlocks and version conflicts that made a transaction run again.', labels: [] },
  reconciliation_mismatches_total: { help: 'Reconciliations that found a stored balance different from the ledger.', labels: [] },
};

export interface OutboxStats {
  readonly pending: number;
  readonly lagSeconds: number;
  readonly highAttempts: number;
}

export interface PrometheusMetricsOptions {
  /** Read from the database at every scrape. These values are the same on every replica: aggregate with `max()`. */
  readonly outboxStats: () => Promise<OutboxStats>;
}

/** `MetricsPort` on prom-client, with its own registry (no global state, so tests can create as many as they like). */
export class PrometheusMetrics implements MetricsPort {
  readonly registry = new Registry();
  private readonly counters = new Map<CounterName, { counter: Counter<string>; labels: readonly string[] }>();
  private readonly duration: Histogram<string>;

  constructor(options: PrometheusMetricsOptions) {
    for (const [name, definition] of Object.entries(COUNTERS) as [CounterName, (typeof COUNTERS)[CounterName]][]) {
      const counter = new Counter({ name, help: definition.help, labelNames: [...definition.labels], registers: [this.registry] });
      this.counters.set(name, { counter, labels: definition.labels });
    }
    this.duration = new Histogram({
      name: 'processing_duration_seconds',
      help: 'Time to process one transaction, from receiving it to the commit, by entry point.',
      labelNames: ['source'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    const gauge = (name: string, help: string, pick: (stats: OutboxStats) => number) =>
      new Gauge({
        name,
        help,
        registers: [this.registry],
        async collect() {
          this.set(pick(await options.outboxStats()));
        },
      });
    gauge('outbox_pending', 'Events committed and not yet published. Same on every replica: aggregate with max().', (stats) => stats.pending);
    gauge('outbox_lag_seconds', 'Age of the oldest unpublished event. Same on every replica: aggregate with max().', (stats) => stats.lagSeconds);
    gauge('outbox_messages_high_attempts', 'Unpublished events that failed many times. Same on every replica: aggregate with max().', (stats) => stats.highAttempts);
  }

  increment(metric: CounterName, labels: Labels = {}): void {
    const entry = this.counters.get(metric);
    if (entry === undefined) {
      return;
    }
    entry.counter.inc(Object.fromEntries(Object.entries(labels).filter(([name]) => entry.labels.includes(name))));
  }

  observeProcessingDuration(seconds: number, labels: Labels = {}): void {
    this.duration.observe(Object.fromEntries(Object.entries(labels).filter(([name]) => name === 'source')), seconds);
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
