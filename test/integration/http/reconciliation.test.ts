import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, startTestApp, testConfig, type TestApp } from '../../support/app';
import { RecordingLogger, RecordingMetrics } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet, post, submission } from '../../support/http';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let app: TestApp;
const logger = new RecordingLogger();
const metrics = new RecordingMetrics();

beforeAll(async () => {
  orm = await getTestOrm();
  app = await startTestApp(testConfig(), { logger, metrics });
});

afterAll(async () => {
  await app.close();
  await closeTestOrm();
});

describe('POST /wallets/:walletId/reconciliation (REC-01, REC-04)', () => {
  test('a consistent wallet → 200 with stored, calculated, difference, consistent and checked entries', async () => {
    const wallet = await createWallet(app.url, '100.00');
    await post(app.url, submission(wallet, { money: { amount: '30.00', currency: 'BRL' } }));

    const response = await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '70.00', currency: 'BRL' },
      calculatedBalance: { amount: '70.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('a balance changed by SQL → 200 with consistent false and the difference; the balance is not corrected', async () => {
    const wallet = await createWallet(app.url, '100.00');
    await sql(orm, `update wallets set balance = 120.50 where id = ?`, [wallet.id]);
    const before = metrics.total('reconciliation_mismatches_total');

    const response = await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);

    expect(response.status).toBe(200);
    expect(response.body.consistent).toBe(false);
    expect(response.body.difference).toEqual({ amount: '20.50', currency: 'BRL' });
    expect(metrics.total('reconciliation_mismatches_total')).toBe(before + 1);
    expect(logger.at('error').some((entry) => entry.context?.walletId === wallet.id)).toBe(true);
    expect((await api(app.url, 'GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('120.50');
  });

  test('an unknown wallet → 404 WALLET_NOT_FOUND', async () => {
    const response = await api(app.url, 'POST', `/wallets/${uuid()}/reconciliation`);

    expect(response.status).toBe(404);
    expect(response.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('a malformed id → 400', async () => {
    const response = await api(app.url, 'POST', '/wallets/not-a-uuid/reconciliation');

    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('VALIDATION_ERROR');
  });

  test('it only reads: calling it twice changes nothing', async () => {
    const wallet = await createWallet(app.url, '100.00');

    const first = await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);
    const second = await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);

    expect(second.body).toEqual(first.body);
    expect((await api(app.url, 'GET', `/wallets/${wallet.id}`)).body.version).toBe(1);
  });
});
