import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, startTestApp, type TestApp } from '../../support/app';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet, post, submission } from '../../support/http';
import { drainOutbox, parkPendingTransactions } from '../../support/messaging';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let app: TestApp;

beforeAll(async () => {
  orm = await getTestOrm();
});
afterAll(async () => {
  await closeTestOrm();
});
beforeEach(async () => {
  await drainOutbox(orm);
  await parkPendingTransactions(orm);
  app = await startTestApp();
});
afterEach(async () => {
  await app.close();
});

/** Sum of one sample (name + exact labels) in the Prometheus text; labels may be given in any order. */
async function sample(name: string, labels: Record<string, string> = {}): Promise<number> {
  const text = await (await fetch(`${app.url}/metrics`)).text();
  let total = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const match = line.match(/^([a-z_]+)(?:\{(.*)\})? ([0-9.e+-]+|NaN)$/);
    if (match?.[1] !== name) continue;
    const found = Object.fromEntries([...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (Object.entries(labels).every(([key, value]) => found[key] === value) && Object.keys(found).length === Object.keys(labels).length) {
      total += Number(match[3]);
    }
  }
  return total;
}

describe('GET /metrics (OBS-04, OBS-07)', () => {
  test('answers 200 in the Prometheus text format with no credentials', async () => {
    const response = await fetch(`${app.url}/metrics`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('# TYPE lock_conflicts_total counter');
  });

  test('lists every metric of the spec, with the labels the spec names', async () => {
    const text = await (await fetch(`${app.url}/metrics`)).text();

    const types: Record<string, string> = {
      wager_transactions_total: 'counter',
      wager_rejected_unpersisted_total: 'counter',
      idempotent_replays_total: 'counter',
      idempotency_conflicts_total: 'counter',
      inbox_duplicates_total: 'counter',
      inbox_payload_conflict_total: 'counter',
      retries_total: 'counter',
      dlq_messages_total: 'counter',
      lock_conflicts_total: 'counter',
      reconciliation_mismatches_total: 'counter',
      processing_duration_seconds: 'histogram',
      outbox_pending: 'gauge',
      outbox_lag_seconds: 'gauge',
      outbox_messages_high_attempts: 'gauge',
    };
    for (const [name, type] of Object.entries(types)) {
      expect(text).toContain(`# TYPE ${name} ${type}`);
    }
  });

  test('counters without labels exist at 0 from the first scrape, so rate() works before the first event', async () => {
    expect(await sample('reconciliation_mismatches_total')).toBe(0);
    expect((await (await fetch(`${app.url}/metrics`)).text()).split('\n')).toContain('lock_conflicts_total 0');
  });

  test('a processed bet counts wager_transactions_total{kind=BET,status=PROCESSED} once, and times the call', async () => {
    const wallet = await createWallet(app.url);
    const before = await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });
    const timed = await sample('processing_duration_seconds_count', { source: 'http' });

    expect((await post(app.url, submission(wallet))).status).toBe(201);

    expect(await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(before + 1);
    expect(await sample('processing_duration_seconds_count', { source: 'http' })).toBe(timed + 1);
  });

  test('a business rejection counts as REJECTED and a reversal without its reference as PENDING_REFERENCE', async () => {
    const wallet = await createWallet(app.url, '10.00');
    const rejected = await sample('wager_transactions_total', { kind: 'BET', status: 'REJECTED' });
    const pending = await sample('wager_transactions_total', { kind: 'ROLLBACK', status: 'PENDING_REFERENCE' });

    expect((await post(app.url, submission(wallet, { money: { amount: '99.00', currency: 'BRL' } }))).status).toBe(422);
    expect((await post(app.url, submission(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `nope-${uuid()}` }))).status).toBe(202);

    expect(await sample('wager_transactions_total', { kind: 'BET', status: 'REJECTED' })).toBe(rejected + 1);
    expect(await sample('wager_transactions_total', { kind: 'ROLLBACK', status: 'PENDING_REFERENCE' })).toBe(pending + 1);
  });

  test('a replay counts idempotent_replays_total and not a second transaction', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet);
    await post(app.url, body, 'replay-key');
    const replays = await sample('idempotent_replays_total');
    const processed = await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });

    expect((await post(app.url, body, 'replay-key')).body.idempotentReplay).toBe(true);

    expect(await sample('idempotent_replays_total')).toBe(replays + 1);
    expect(await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(processed);
  });

  test('the same key with another content counts idempotency_conflicts_total (409)', async () => {
    const wallet = await createWallet(app.url);
    const first = submission(wallet);
    await post(app.url, first, 'conflict-key');
    const before = await sample('idempotency_conflicts_total');

    const other = submission(wallet, { providerId: first.providerId });
    expect((await post(app.url, other, 'conflict-key')).status).toBe(409);

    expect(await sample('idempotency_conflicts_total')).toBe(before + 1);
  });

  test('a reconciliation that finds a divergence counts reconciliation_mismatches_total', async () => {
    const wallet = await createWallet(app.url);
    const before = await sample('reconciliation_mismatches_total');
    await sql(orm, 'update wallets set balance = balance + 1 where id = ?', [wallet.id]);

    await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);

    expect(await sample('reconciliation_mismatches_total')).toBe(before + 1);
  });

  test('a request refused before anything is stored (unknown wallet) counts nothing as processed', async () => {
    const before = await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' });

    const response = await post(app.url, submission({ id: uuid(), playerId: uuid() }));

    expect(response.status).toBe(422);
    expect(await sample('wager_transactions_total', { kind: 'BET', status: 'PROCESSED' })).toBe(before);
  });
});

describe('outbox gauges come from the database (OBS-04)', () => {
  test('pending, lag and high attempts follow what the table holds', async () => {
    const wallet = await createWallet(app.url);
    await drainOutbox(orm);
    const base = { pending: await sample('outbox_pending'), high: await sample('outbox_messages_high_attempts') };

    await post(app.url, submission(wallet));
    expect(await sample('outbox_pending')).toBe(base.pending + 2);
    expect(await sample('outbox_lag_seconds')).toBeGreaterThanOrEqual(0);

    await sql(orm, `update outbox_messages set attempts = 10 where aggregate_id = ? and published_at is null`, [wallet.id]);
    expect(await sample('outbox_messages_high_attempts')).toBe(base.high + 2);

    await sql(orm, `update outbox_messages set published_at = now() where aggregate_id = ?`, [wallet.id]);
    expect(await sample('outbox_pending')).toBe(base.pending);
    expect(await sample('outbox_messages_high_attempts')).toBe(base.high);
  });

  test('with nothing pending the lag is 0', async () => {
    await drainOutbox(orm);

    expect(await sample('outbox_pending')).toBe(0);
    expect(await sample('outbox_lag_seconds')).toBe(0);
  });

  test('the lag grows with the age of the oldest unpublished event', async () => {
    const wallet = await createWallet(app.url);
    await drainOutbox(orm);
    await post(app.url, submission(wallet));
    await sql(orm, `update outbox_messages set occurred_at = now() - interval '90 seconds' where aggregate_id = ? and published_at is null`, [wallet.id]);

    const lag = await sample('outbox_lag_seconds');

    expect(lag).toBeGreaterThanOrEqual(89);
    expect(lag).toBeLessThan(120);
  });
});
