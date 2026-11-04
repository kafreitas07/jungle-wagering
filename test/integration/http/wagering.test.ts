import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ProviderIdentityMismatchError, type ProviderIdentityPort } from '../../../src/application/ports';
import { ReprocessPendingReference } from '../../../src/application/use-cases/reprocess-pending-reference';
import { api, denyAllProviders, startTestApp, type TestApp } from '../../support/app';
import { FakeClock, testUnitOfWork } from '../../support/context';
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

describe('POST /wagering/transactions: success and replay (TXN-05, IDEM-01, IDEM-03)', () => {
  test('a valid BET → 201 with transaction id, PROCESSED, balance after and idempotentReplay false', async () => {
    const wallet = await createWallet(app.url, '1000.00');

    const response = await post(app.url, submission(wallet));

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the same request again → the same status and transaction, idempotentReplay true, balance unchanged', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const body = submission(wallet);
    const key = `key-${uuid()}`;
    const first = await post(app.url, body, key);

    const replay = await post(app.url, body, key);

    expect(replay.status).toBe(201);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect((await api(app.url, 'GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('975.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the key may be anything: it does not have to follow provider:externalId', async () => {
    const wallet = await createWallet(app.url);

    expect((await post(app.url, submission(wallet), `any-shape-${uuid()}`)).status).toBe(201);
  });

  test('BET → WIN → REFUND chain moves the balance and reconciles', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const providerId = `provider-${uuid()}`;
    const roundId = `round-${uuid()}`;
    const base = { providerId, roundId };
    const betId = `bet-${uuid()}`;
    await post(app.url, submission(wallet, { ...base, externalTransactionId: betId, money: { amount: '40.00', currency: 'BRL' } }));
    const win = await post(app.url, submission(wallet, { ...base, kind: 'WIN', referenceExternalTransactionId: betId, money: { amount: '90.00', currency: 'BRL' } }));
    const refund = await post(app.url, submission(wallet, { ...base, kind: 'REFUND', referenceExternalTransactionId: betId, money: { amount: '40.00', currency: 'BRL' } }));

    expect(win.body.balance.amount).toBe('150.00');
    expect(refund.status).toBe(201);
    expect(refund.body.balance.amount).toBe('190.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the correlation id header reaches the events of the transaction', async () => {
    const wallet = await createWallet(app.url);
    const correlationId = `corr-${uuid()}`;

    const response = await post(app.url, submission(wallet), undefined, { 'x-correlation-id': correlationId });

    const rows = await sql(orm, `select payload->>'correlationId' as c from outbox_messages where (payload->'data'->>'transactionId') = ?`, [response.body.transactionId]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.c === correlationId)).toBe(true);
  });
});

describe('POST /wagering/transactions: conflicts (IDEM-04, IDEM-05)', () => {
  test('the same key with another amount → 409 IDEMPOTENCY_KEY_REUSED, and nothing is applied', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const body = submission(wallet);
    const key = `key-${uuid()}`;
    await post(app.url, body, key);

    const conflict = await post(app.url, { ...body, money: { amount: '30.00', currency: 'BRL' } }, key);

    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await api(app.url, 'GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('975.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the same external id under another key → 409 EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet);
    await post(app.url, body, `key-${uuid()}`);

    const conflict = await post(app.url, body, `key-${uuid()}`);

    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe('EXTERNAL_ID_CONFLICT');
  });
});

describe('POST /wagering/transactions: business outcomes (TXN-07, PREF-01)', () => {
  test('a BET above the balance → 422 with the failure code, the transaction id and the unchanged balance', async () => {
    const wallet = await createWallet(app.url, '10.00');

    const response = await post(app.url, submission(wallet, { money: { amount: '10.01', currency: 'BRL' } }));

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      failureCode: 'INSUFFICIENT_FUNDS',
      message: expect.any(String),
      transactionId: expect.any(String),
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('replaying a rejection answers 422 again with idempotentReplay true', async () => {
    const wallet = await createWallet(app.url, '10.00');
    const body = submission(wallet, { money: { amount: '99.00', currency: 'BRL' } });
    const key = `key-${uuid()}`;
    const first = await post(app.url, body, key);

    const replay = await post(app.url, body, key);

    expect(replay.status).toBe(422);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('a reversal whose reference has not arrived → 202 PENDING_REFERENCE, and its replay is 202 too', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet, { kind: 'REFUND', referenceExternalTransactionId: `bet-${uuid()}` });
    const key = `key-${uuid()}`;

    const first = await post(app.url, body, key);
    const replay = await post(app.url, body, key);

    expect(first.status).toBe(202);
    expect(first.body.status).toBe('PENDING_REFERENCE');
    expect(first.body.balance.amount).toBe('1000.00');
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('a second reversal of the same BET → 422 REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await createWallet(app.url);
    const providerId = `provider-${uuid()}`;
    const roundId = `round-${uuid()}`;
    const betId = `bet-${uuid()}`;
    await post(app.url, submission(wallet, { providerId, roundId, externalTransactionId: betId }));
    const reverse = (kind: string) => post(app.url, submission(wallet, { providerId, roundId, kind, referenceExternalTransactionId: betId }));
    await reverse('REFUND');

    const second = await reverse('ROLLBACK');

    expect(second.status).toBe(422);
    expect(second.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('an unknown wallet → 422 WALLET_NOT_FOUND, not 404', async () => {
    const wallet = await createWallet(app.url);

    const response = await post(app.url, submission(wallet, { walletId: uuid() }));

    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('another player → 422 WALLET_PLAYER_MISMATCH and another currency → 422 CURRENCY_MISMATCH, nothing stored', async () => {
    const wallet = await createWallet(app.url);
    const otherPlayer = submission(wallet, { playerId: uuid() });
    const otherCurrency = submission(wallet, { money: { amount: '5.00', currency: 'USD' } });

    const player = await post(app.url, otherPlayer);
    const currency = await post(app.url, otherCurrency);

    expect(player.status).toBe(422);
    expect(player.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
    expect(currency.status).toBe(422);
    expect(currency.body.failureCode).toBe('CURRENCY_MISMATCH');
    expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id in (?, ?)', [otherPlayer.externalTransactionId, otherCurrency.externalTransactionId])).toHaveLength(0);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});

describe('POST /wagering/transactions: invalid input is 400 (TXN-13, TXN-14, MON-08)', () => {
  test('a missing Idempotency-Key → 400 IDEMPOTENCY_KEY_REQUIRED, and a blank one too', async () => {
    const wallet = await createWallet(app.url);

    const missing = await post(app.url, submission(wallet), null);
    const blank = await post(app.url, submission(wallet), '   ');

    expect(missing.status).toBe(400);
    expect(missing.body.failureCode).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(blank.body.failureCode).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  test('an Idempotency-Key longer than 255 characters → 400', async () => {
    const wallet = await createWallet(app.url);

    const response = await post(app.url, submission(wallet), 'k'.repeat(256));

    expect(response.status).toBe(400);
  });

  test.each([
    ['kind OPENING', { kind: 'OPENING' }, 'kind'],
    ['the reserved provider "internal"', { providerId: 'internal' }, 'providerId'],
    ['a BET of 0.00', { money: { amount: '0.00', currency: 'BRL' } }, 'money.amount'],
    ['an amount without two decimals', { money: { amount: '25', currency: 'BRL' } }, 'money.amount'],
    ['an exponent amount', { money: { amount: '1e3', currency: 'BRL' } }, 'money.amount'],
    ['a REFUND without reference', { kind: 'REFUND' }, 'referenceExternalTransactionId'],
    ['an external id above 255 characters', { externalTransactionId: 'x'.repeat(256) }, 'externalTransactionId'],
    ['a walletId that is not a UUID', { walletId: 'wallet-1' }, 'walletId'],
  ])('%s → 400 VALIDATION_ERROR naming the field', async (_name, change, path) => {
    const wallet = await createWallet(app.url);

    const response = await post(app.url, submission(wallet, change));

    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('VALIDATION_ERROR');
    expect(response.body.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  test('a rejected request leaves no transaction behind', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet, { kind: 'OPENING' });

    await post(app.url, body);

    expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [body.externalTransactionId])).toHaveLength(0);
  });
});

describe('GET transaction by id and by external id (TXN-10)', () => {
  test('by id → 200 with status, kind, money, reference and balance', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const body = submission(wallet, { money: { amount: '40.00', currency: 'BRL' } });
    const created = await post(app.url, body);

    const response = await api(app.url, 'GET', `/wagering/transactions/${created.body.transactionId}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      status: 'PROCESSED',
      failureCode: null,
      money: { amount: '40.00', currency: 'BRL' },
      balance: { amount: '60.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
    });
  });

  test('a rejected transaction shows its failure code', async () => {
    const wallet = await createWallet(app.url, '1.00');
    const rejected = await post(app.url, submission(wallet));

    const response = await api(app.url, 'GET', `/wagering/transactions/${rejected.body.transactionId}`);

    expect(response.body.status).toBe('REJECTED');
    expect(response.body.failureCode).toBe('INSUFFICIENT_FUNDS');
  });

  test('by provider and external id → the same transaction', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet);
    const created = await post(app.url, body);

    const response = await api(app.url, 'GET', `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`);

    expect(response.status).toBe(200);
    expect(response.body.transactionId).toBe(created.body.transactionId);
  });

  test('unknown transactions → 404 TRANSACTION_NOT_FOUND, scoped by provider; a malformed id → 400', async () => {
    const wallet = await createWallet(app.url);
    const body = submission(wallet);
    await post(app.url, body);

    const unknownId = await api(app.url, 'GET', `/wagering/transactions/${uuid()}`);
    const otherProvider = await api(app.url, 'GET', `/providers/${uuid()}/wagering/transactions/${body.externalTransactionId}`);
    const malformed = await api(app.url, 'GET', '/wagering/transactions/nope');

    expect(unknownId.status).toBe(404);
    expect(unknownId.body.failureCode).toBe('TRANSACTION_NOT_FOUND');
    expect(otherProvider.status).toBe(404);
    expect(malformed.status).toBe(400);
  });
});

describe('a FAILED transaction answers 500 PROCESSING_FAILED, on replay and on lookup (API-04)', () => {
  test('after the worker gives up on a pending reversal, the same request replays as 500 with failureCode PROCESSING_FAILED', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const body = submission(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: `missing-${uuid()}` });
    const key = `key-${uuid()}`;
    const pending = await post(app.url, body, key);
    expect(pending.status).toBe(202);
    const markFailed = new ReprocessPendingReference({
      unitOfWork: testUnitOfWork(orm),
      clock: new FakeClock(),
      referencePolicy: { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 },
    });
    expect(await markFailed.markFailed({ id: pending.body.transactionId, walletId: wallet.id, kind: 'ROLLBACK' })).toBe(true);

    const replay = await post(app.url, body, key);

    expect(replay.status).toBe(500);
    expect(replay.body).toMatchObject({
      transactionId: pending.body.transactionId,
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      idempotentReplay: true,
    });
    const lookup = await api(app.url, 'GET', `/wagering/transactions/${pending.body.transactionId}`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ status: 'FAILED', failureCode: 'PROCESSING_FAILED' });
    expect(await sql(orm, 'select balance::text from wallets where id = ?', [wallet.id])).toEqual([{ balance: '1000.00' }]);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});

describe('provider identity (AUTH-02)', () => {
  test('a port that denies the provider of the body → 403 PROVIDER_IDENTITY_MISMATCH and nothing is written', async () => {
    const guarded = await startTestApp(undefined, { providerIdentity: denyAllProviders });
    try {
      const wallet = await createWallet(guarded.url);
      const body = submission(wallet);

      const response = await post(guarded.url, body);

      expect(response.status).toBe(403);
      expect(response.body.failureCode).toBe('PROVIDER_IDENTITY_MISMATCH');
      expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [body.externalTransactionId])).toHaveLength(0);
    } finally {
      await guarded.close();
    }
  });

  test('the provider-scoped query goes through the same port', async () => {
    const guarded = await startTestApp(undefined, { providerIdentity: denyAllProviders });
    try {
      const response = await api(guarded.url, 'GET', `/providers/${uuid()}/wagering/transactions/${uuid()}`);

      expect(response.status).toBe(403);
    } finally {
      await guarded.close();
    }
  });

  test('a port that knows the token passes only its own provider', async () => {
    const allowed = `provider-${uuid()}`;
    const onlyOne: ProviderIdentityPort = {
      async assertCanActAs(providerId) {
        if (providerId !== allowed) {
          throw new ProviderIdentityMismatchError(providerId);
        }
      },
    };
    const guarded = await startTestApp(undefined, { providerIdentity: onlyOne });
    try {
      const wallet = await createWallet(guarded.url);

      expect((await post(guarded.url, submission(wallet, { providerId: allowed }))).status).toBe(201);
      expect((await post(guarded.url, submission(wallet, { providerId: `provider-${uuid()}` }))).status).toBe(403);
    } finally {
      await guarded.close();
    }
  });
});
