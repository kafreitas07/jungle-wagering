import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { ProviderIdentityPort } from '../../../src/application/ports';
import { api, startTestApp, testConfig, type TestApp } from '../../support/app';
import { holdWalletLock } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet, post, submission } from '../../support/http';
import { assertReconciledByApi } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let app: TestApp;

beforeAll(async () => {
  orm = await getTestOrm();
  app = await startTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestOrm();
});

const errorShape = (body: any) => {
  expect(typeof body.failureCode).toBe('string');
  expect(typeof body.message).toBe('string');
  expect(body.stack).toBeUndefined();
};

describe('one status per class of outcome, on real endpoints (API-01)', () => {
  test('201 created / processed', async () => {
    const wallet = await createWallet(app.url);

    expect((await post(app.url, submission(wallet))).status).toBe(201);
  });

  test('202 accepted, pending', async () => {
    const wallet = await createWallet(app.url);

    const response = await post(app.url, submission(wallet, { kind: 'WIN', referenceExternalTransactionId: `bet-${uuid()}` }));

    expect(response.status).toBe(202);
    expect(response.headers.get('retry-after')).toBeNull();
  });

  test('400 invalid payload, with the same code on every endpoint that validates', async () => {
    const wallet = await createWallet(app.url);

    const submit = await post(app.url, submission(wallet, { money: { amount: '1', currency: 'BRL' } }));
    const create = await api(app.url, 'POST', '/wallets', { body: { playerId: 'x', initialBalance: { amount: '1.00', currency: 'BRL' } } });
    const ledger = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=0`);
    const read = await api(app.url, 'GET', '/wallets/not-a-uuid');

    for (const response of [submit, create, ledger, read]) {
      expect(response.status).toBe(400);
      expect(response.body.failureCode).toBe('VALIDATION_ERROR');
      errorShape(response.body);
    }
  });

  test('404 for a missing resource in a query', async () => {
    const wallet = await api(app.url, 'GET', `/wallets/${uuid()}`);
    const transaction = await api(app.url, 'GET', `/wagering/transactions/${uuid()}`);

    expect([wallet.status, transaction.status]).toEqual([404, 404]);
    expect([wallet.body.failureCode, transaction.body.failureCode]).toEqual(['WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND']);
  });

  test('409 for every kind of conflict', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet);
    const key = `key-${uuid()}`;
    await post(app.url, body, key);
    const reused = await post(app.url, { ...body, gameId: 'another-game' }, key);
    const external = await post(app.url, body, `key-${uuid()}`);
    const duplicateWallet = await api(app.url, 'POST', '/wallets', { body: { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } } });

    expect([reused.status, external.status, duplicateWallet.status]).toEqual([409, 409, 409]);
    expect([reused.body.failureCode, external.body.failureCode, duplicateWallet.body.failureCode]).toEqual([
      'IDEMPOTENCY_KEY_REUSED',
      'EXTERNAL_ID_CONFLICT',
      'WALLET_ALREADY_EXISTS',
    ]);
  });

  test('422 for a business rejection, distinct from 400 and 409', async () => {
    const wallet = await createWallet(app.url, '1.00');

    const response = await post(app.url, submission(wallet));

    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('an unknown route → 404 ROUTE_NOT_FOUND in the same body shape', async () => {
    const response = await api(app.url, 'GET', `/nothing/${uuid()}`);

    expect(response.status).toBe(404);
    expect(response.body.failureCode).toBe('ROUTE_NOT_FOUND');
    errorShape(response.body);
  });

  test('Retry-After appears on no 4xx', async () => {
    const wallet = await createWallet(app.url, '1.00');
    const responses = [
      await post(app.url, submission(wallet)),
      await api(app.url, 'GET', `/wallets/${uuid()}`),
      await post(app.url, submission(wallet), null),
    ];

    for (const response of responses) {
      expect(response.headers.get('retry-after')).toBeNull();
    }
  });
});

describe('transient failures are 503 with Retry-After: 1 (API-03)', () => {
  test('PostgreSQL unreachable → 503 DEPENDENCY_UNAVAILABLE on writes and reads', async () => {
    const broken = await startTestApp(testConfig({ DATABASE_URL: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test' }));
    try {
      const create = await api(broken.url, 'POST', '/wallets', { body: { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } } });
      const read = await api(broken.url, 'GET', `/wallets/${uuid()}`);

      for (const response of [create, read]) {
        expect(response.status).toBe(503);
        expect(response.body.failureCode).toBe('DEPENDENCY_UNAVAILABLE');
        expect(response.headers.get('retry-after')).toBe('1');
        errorShape(response.body);
        expect(JSON.stringify(response.body)).not.toContain('127.0.0.1');
      }
    } finally {
      await broken.close();
    }
  });

  test('a wallet lock held past every retry → 503 CONCURRENCY_CONFLICT, nothing applied, and the same request works afterwards', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const impatient = await startTestApp(testConfig({ LOCK_TIMEOUT_MS: '30' }));
    try {
      const body = submission(wallet);
      const key = `key-${uuid()}`;
      const holder = holdWalletLock(orm, wallet.id, 1500);
      await holder.acquired;

      const conflict = await post(impatient.url, body, key);
      await holder.released;

      expect(conflict.status).toBe(503);
      expect(conflict.body.failureCode).toBe('CONCURRENCY_CONFLICT');
      expect(conflict.headers.get('retry-after')).toBe('1');
      expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [body.externalTransactionId])).toHaveLength(0);

      const retried = await post(impatient.url, body, key);
      expect(retried.status).toBe(201);
      expect(retried.body.idempotentReplay).toBe(false);
      await assertReconciledByApi(orm, app.url, [wallet.id]);
    } finally {
      await impatient.close();
    }
  });

  test('SQS unreachable does not stop the API: the work is accepted and waits in the outbox', async () => {
    const noQueue = await startTestApp(testConfig({ SQS_ENDPOINT: 'http://127.0.0.1:1' }));
    try {
      const wallet = await createWallet(noQueue.url);

      const bet = await post(noQueue.url, submission(wallet));

      expect(bet.status).toBe(201);
      const pending = await sql(orm, 'select count(*)::int as n from outbox_messages where aggregate_id = ? and published_at is null', [wallet.id]);
      expect(pending[0]?.n).toBeGreaterThanOrEqual(2);
      await assertReconciledByApi(orm, app.url, [wallet.id]);
    } finally {
      await noQueue.close();
    }
  });
});

describe('unexpected failures are 500 and leak nothing (API-02)', () => {
  test('an unclassified error → 500 INTERNAL_ERROR with a generic body', async () => {
    const leaky: ProviderIdentityPort = {
      async assertCanActAs() {
        throw new Error('insert into secrets (token) values (\'hunter2\') failed at /srv/app/internal.ts:42');
      },
    };
    const failing = await startTestApp(undefined, { providerIdentity: leaky });
    try {
      const wallet = await createWallet(failing.url);

      const response = await post(failing.url, submission(wallet));

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ failureCode: 'INTERNAL_ERROR', message: 'Unexpected error' });
      expect(JSON.stringify(response.body)).not.toMatch(/hunter2|internal\.ts|insert into/);
      expect(response.headers.get('retry-after')).toBeNull();
    } finally {
      await failing.close();
    }
  });
});
