import { describe, expect, test } from 'bun:test';
import { ConcurrencyConflictError, IdempotencyConflictError } from '../../../src/application/errors/application-errors';
import { OptimisticLockError } from '../../../src/application/ports';
import type { Labels, MetricsPort } from '../../../src/application/ports';
import { ConcurrencyRetry } from '../../../src/application/services/concurrency-retry';

const sqlError = (code: string, message = 'db error') => Object.assign(new Error(message), { code });

class RecordingMetrics implements MetricsPort {
  readonly counts: string[] = [];
  increment(metric: string, _labels?: Labels): void {
    this.counts.push(metric);
  }
  observeProcessingDuration(): void {}
}

function build(random = () => 0.5) {
  const metrics = new RecordingMetrics();
  const sleeps: number[] = [];
  const retry = new ConcurrencyRetry({ metrics, sleep: async (ms) => void sleeps.push(ms), random });
  return { retry, metrics, sleeps };
}

/** Fails with the given errors in order, then succeeds. */
function flaky<T>(failures: unknown[], result: T) {
  let calls = 0;
  const operation = async () => {
    calls += 1;
    const failure = failures[calls - 1];
    if (failure !== undefined) {
      throw failure;
    }
    return result;
  };
  return { operation, calls: () => calls };
}

describe('ConcurrencyRetry (CONC-05, CONC-07)', () => {
  test('returns the result without sleeping or counting when the first attempt succeeds', async () => {
    const { retry, metrics, sleeps } = build();
    const { operation, calls } = flaky([], 'ok');

    expect(await retry.run(operation)).toBe('ok');
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
    expect(metrics.counts).toEqual([]);
  });

  test('a transient error that passes on the second attempt ends in success, counting one retry', async () => {
    const { retry, metrics, sleeps } = build();
    const { operation, calls } = flaky([sqlError('55P03')], 'ok');

    expect(await retry.run(operation)).toBe('ok');
    expect(calls()).toBe(2);
    expect(sleeps).toHaveLength(1);
    expect(metrics.counts).toEqual(['lock_conflicts_total', 'retries_total']);
  });

  test.each([
    ['lock timeout', sqlError('55P03')],
    ['serialization failure', sqlError('40001')],
    ['deadlock', sqlError('40P01')],
    ['optimistic lock', new OptimisticLockError('wallet-1', 3)],
    ['idempotency key race', sqlError('23505', 'duplicate key value violates unique constraint "wager_transactions_idempotency_key"')],
    ['external id race', sqlError('23505', 'duplicate key value violates unique constraint "wager_transactions_external_id"')],
    ['double reversal race', sqlError('23505', 'duplicate key value violates unique constraint "wager_transactions_single_reversal"')],
  ])('retries on %s', async (_name, error) => {
    const { retry } = build();
    const { operation, calls } = flaky([error], 'ok');

    expect(await retry.run(operation)).toBe('ok');
    expect(calls()).toBe(2);
  });

  test.each([
    ['another unique constraint', sqlError('23505', 'duplicate key value violates unique constraint "wallets_player_currency_key"')],
    ['a check violation', sqlError('23514')],
    ['a plain error', new Error('boom')],
    ['a business error', new IdempotencyConflictError('p', 'k')],
  ])('does not retry %s', async (_name, error) => {
    const { retry, metrics } = build();
    const { operation, calls } = flaky([error, error, error], 'never');

    await expect(retry.run(operation)).rejects.toBe(error);
    expect(calls()).toBe(1);
    expect(metrics.counts).toEqual([]);
  });

  test('four failures in a row give up with ConcurrencyConflict, after three waits, counting three retries', async () => {
    const { retry, metrics, sleeps } = build();
    const last = sqlError('40P01');
    const { operation, calls } = flaky([sqlError('55P03'), sqlError('55P03'), sqlError('55P03'), last], 'never');

    const failure = await retry.run(operation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConcurrencyConflictError);
    expect((failure as ConcurrencyConflictError).cause).toBe(last);
    expect(calls()).toBe(4);
    expect(sleeps).toHaveLength(3);
    expect(metrics.counts).toEqual(['lock_conflicts_total', 'retries_total', 'lock_conflicts_total', 'retries_total', 'lock_conflicts_total', 'retries_total']);
  });

  test('waits 20, 60 and 180 ms at the middle of the jitter range', async () => {
    const { retry, sleeps } = build(() => 0.5);
    const failures = [sqlError('55P03'), sqlError('55P03'), sqlError('55P03'), sqlError('55P03')];

    await retry.run(flaky(failures, 'never').operation).catch(() => undefined);

    expect(sleeps).toEqual([20, 60, 180]);
  });

  test('jitter spreads each wait between 75% and 125% of its base', async () => {
    const low = build(() => 0);
    const high = build(() => 1);
    const failures = () => [sqlError('55P03'), sqlError('55P03'), sqlError('55P03'), sqlError('55P03')];

    await low.retry.run(flaky(failures(), 'never').operation).catch(() => undefined);
    await high.retry.run(flaky(failures(), 'never').operation).catch(() => undefined);

    expect(low.sleeps).toEqual([15, 45, 135]);
    expect(high.sleeps).toEqual([25, 75, 225]);
  });

  test('a different error after a transient one stops the retries and surfaces', async () => {
    const { retry, metrics } = build();
    const fatal = new Error('fatal');
    const { operation, calls } = flaky([sqlError('55P03'), fatal], 'never');

    await expect(retry.run(operation)).rejects.toBe(fatal);
    expect(calls()).toBe(2);
    expect(metrics.counts).toEqual(['lock_conflicts_total', 'retries_total']);
  });
});
