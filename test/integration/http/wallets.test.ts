import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, denyAllProviders, startTestApp, type TestApp } from '../../support/app';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet, post, submission } from '../../support/http';
import { assertReconciledByApi } from '../../support/reconcile';
import { uuid } from '../../support/sql';

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

describe('POST /wallets (WAL-01, WAL-04)', () => {
  test('creates the wallet: 201 with id, player, balance and version 1', async () => {
    const playerId = uuid();

    const response = await api(app.url, 'POST', '/wallets', { body: { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } } });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    await assertReconciledByApi(orm, app.url, [response.body.id]);
  });

  test('a second wallet for the same player and currency → 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = uuid();
    const body = { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } };
    await api(app.url, 'POST', '/wallets', { body });

    const response = await api(app.url, 'POST', '/wallets', { body });

    expect(response.status).toBe(409);
    expect(response.body.failureCode).toBe('WALLET_ALREADY_EXISTS');
  });

  test('the same player may hold a wallet in another currency', async () => {
    const playerId = uuid();
    await api(app.url, 'POST', '/wallets', { body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } } });

    const usd = await api(app.url, 'POST', '/wallets', { body: { playerId, initialBalance: { amount: '10.00', currency: 'USD' } } });

    expect(usd.status).toBe(201);
    expect(usd.body.balance.currency).toBe('USD');
  });

  test('a zero initial balance is accepted', async () => {
    const response = await api(app.url, 'POST', '/wallets', { body: { playerId: uuid(), initialBalance: { amount: '0.00', currency: 'BRL' } } });

    expect(response.status).toBe(201);
    expect(response.body.balance.amount).toBe('0.00');
  });

  test.each([
    ['an amount without two decimals', { playerId: uuid(), initialBalance: { amount: '25', currency: 'BRL' } }, 'initialBalance.amount'],
    ['a negative amount', { playerId: uuid(), initialBalance: { amount: '-1.00', currency: 'BRL' } }, 'initialBalance.amount'],
    ['a playerId that is not a UUID', { playerId: 'player-1', initialBalance: { amount: '1.00', currency: 'BRL' } }, 'playerId'],
    ['a missing balance', { playerId: uuid() }, 'initialBalance'],
  ])('%s → 400 VALIDATION_ERROR naming the field', async (_name, body, path) => {
    const response = await api(app.url, 'POST', '/wallets', { body });

    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('VALIDATION_ERROR');
    expect(response.body.details.map((detail: { path: string }) => detail.path)).toContain(path);
  });

  test('a malformed JSON body → 400', async () => {
    const response = await fetch(`${app.url}/wallets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { failureCode: string }).failureCode).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId (WAL-05, WAL-06)', () => {
  test('returns the wallet with its current balance and version', async () => {
    const wallet = await createWallet(app.url, '100.00');
    await post(app.url, submission(wallet, { money: { amount: '30.00', currency: 'BRL' } }));

    const response = await api(app.url, 'GET', `/wallets/${wallet.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: { amount: '70.00', currency: 'BRL' }, version: 2 });
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('an unknown wallet → 404 WALLET_NOT_FOUND', async () => {
    const response = await api(app.url, 'GET', `/wallets/${uuid()}`);

    expect(response.status).toBe(404);
    expect(response.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  test('a malformed id → 400, not 404', async () => {
    const response = await api(app.url, 'GET', '/wallets/not-a-uuid');

    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('VALIDATION_ERROR');
  });
});

describe('GET /wallets/:walletId/ledger (LEDG-05, LEDG-06)', () => {
  async function walletWithBets(bets: number) {
    const wallet = await createWallet(app.url, '1000.00');
    for (let i = 0; i < bets; i += 1) {
      await post(app.url, submission(wallet, { money: { amount: '1.00', currency: 'BRL' } }));
    }
    return wallet;
  }

  test('lists the opening credit of a new wallet', async () => {
    const wallet = await createWallet(app.url, '500.00');

    const response = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger`);

    expect(response.status).toBe(200);
    expect(response.body.nextCursor).toBeNull();
    expect(response.body.items).toEqual([
      {
        id: expect.any(String),
        transactionId: expect.any(String),
        direction: 'CREDIT',
        amount: { amount: '500.00', currency: 'BRL' },
        balanceBefore: { amount: '0.00', currency: 'BRL' },
        balanceAfter: { amount: '500.00', currency: 'BRL' },
        walletVersion: 1,
        createdAt: expect.any(String),
      },
    ]);
  });

  test('pages with an opaque cursor, newest first, without repeating or skipping', async () => {
    const wallet = await walletWithBets(6);

    const first = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=3`);
    const second = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=3&cursor=${first.body.nextCursor}`);
    const third = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=3&cursor=${second.body.nextCursor}`);

    const versions = [first, second, third].flatMap((page) => page.body.items.map((item: { walletVersion: number }) => item.walletVersion));
    expect(versions).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(first.body.nextCursor).toBeString();
    expect(third.body.nextCursor).toBeNull();
  });

  test('the default limit is 50 and 200 is accepted', async () => {
    const wallet = await walletWithBets(2);

    expect((await api(app.url, 'GET', `/wallets/${wallet.id}/ledger`)).body.items).toHaveLength(3);
    expect((await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=200`)).status).toBe(200);
  });

  test.each(['0', '201', '-3', 'abc', '1.5'])('limit=%s → 400', async (limit) => {
    const wallet = await createWallet(app.url);

    const response = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?limit=${limit}`);

    expect(response.status).toBe(400);
    expect(response.body.failureCode).toBe('VALIDATION_ERROR');
  });

  test.each(['garbage', Buffer.from('{"v":0}').toString('base64url'), Buffer.from('[]').toString('base64url')])(
    'an invalid cursor (%s) → 400',
    async (cursor) => {
      const wallet = await createWallet(app.url);

      const response = await api(app.url, 'GET', `/wallets/${wallet.id}/ledger?cursor=${cursor}`);

      expect(response.status).toBe(400);
    },
  );

  test('an unknown wallet → 404 and a malformed id → 400', async () => {
    expect((await api(app.url, 'GET', `/wallets/${uuid()}/ledger`)).status).toBe(404);
    expect((await api(app.url, 'GET', '/wallets/nope/ledger')).status).toBe(400);
  });
});

describe('the auth extension point on wallet routes (AUTH-01)', () => {
  test('the guard is applied but routes that name no provider carry nothing to deny, so they pass', async () => {
    const guarded = await startTestApp(undefined, { providerIdentity: denyAllProviders });
    try {
      const created = await api(guarded.url, 'POST', '/wallets', { body: { playerId: uuid(), initialBalance: { amount: '1.00', currency: 'BRL' } } });

      expect(created.status).toBe(201);
      expect((await api(guarded.url, 'GET', `/wallets/${created.body.id}`)).status).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});
