import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api, startTestApp, type TestApp } from '../support/app';
import { closeTestOrm, getTestOrm } from '../support/db';
import { createWallet, post, submission } from '../support/http';
import { assertReconciledByApi } from '../support/reconcile';
import { sql, uuid } from '../support/sql';

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

const balanceOf = async (walletId: string): Promise<string> => (await api(app.url, 'GET', `/wallets/${walletId}`)).body.balance.amount;

const count = async (statement: string, params: unknown[]): Promise<number> =>
  Number((await sql(orm, statement, params))[0]?.n);

describe('the same request many times at once (CONC-01, IDEM-06)', () => {
  test('50 identical requests create one transaction, one debit and 50 answers about the same transaction', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const body = submission(wallet);
    const key = `key-${uuid()}`;

    const responses = await Promise.all(Array.from({ length: 50 }, () => post(app.url, body, key)));

    expect(responses.map((response) => response.status)).toEqual(Array(50).fill(201));
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(responses.filter((response) => response.body.idempotentReplay === true)).toHaveLength(49);
    expect(await count('select count(*)::int as n from wager_transactions where wallet_id = ? and provider_id <> \'internal\'', [wallet.id])).toBe(1);
    expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id])).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the same external id under 20 different keys: one wins, the rest are EXTERNAL_ID_CONFLICT', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const body = submission(wallet);

    const responses = await Promise.all(Array.from({ length: 20 }, () => post(app.url, body)));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    const losers = responses.filter((response) => response.status !== 201);
    expect(losers).toHaveLength(19);
    expect(losers.every((response) => response.status === 409 && response.body.failureCode === 'EXTERNAL_ID_CONFLICT')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('the same key with different payloads: one is applied, the others are IDEMPOTENCY_KEY_REUSED', async () => {
    const wallet = await createWallet(app.url, '1000.00');
    const providerId = `provider-${uuid()}`;
    const key = `key-${uuid()}`;
    const bodies = [10, 20, 30, 40, 50, 60].map((amount) =>
      submission(wallet, { providerId, externalTransactionId: `ext-${uuid()}`, money: { amount: `${amount}.00`, currency: 'BRL' } }),
    );
    const byAmount = new Map(bodies.map((body) => [body.money.amount, body]));

    const responses = await Promise.all(bodies.map((body) => post(app.url, body, key)));

    const winners = responses.filter((response) => response.status === 201);
    expect(winners).toHaveLength(1);
    const losers = responses.filter((response) => response.status !== 201);
    expect(losers.every((response) => response.status === 409 && response.body.failureCode === 'IDEMPOTENCY_KEY_REUSED')).toBe(true);
    const applied = Number(winners[0]?.body.balance.amount);
    const debited = 1000 - applied;
    expect(byAmount.has(`${debited}.00`)).toBe(true);
    expect(await count('select count(*)::int as n from wager_transactions where wallet_id = ? and provider_id <> \'internal\'', [wallet.id])).toBe(1);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});

describe('competing for the same balance (CONC-02)', () => {
  test('100.00 and two BETs of 80.00: exactly one passes, repeated 20 times', async () => {
    const wallets: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const wallet = await createWallet(app.url, '100.00');
      wallets.push(wallet.id);
      const eighty = { money: { amount: '80.00', currency: 'BRL' } };

      const [first, second] = await Promise.all([post(app.url, submission(wallet, eighty)), post(app.url, submission(wallet, eighty))]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 422]);
      const rejected = first.status === 422 ? first : second;
      expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(wallet.id)).toBe('20.00');
      expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id])).toBe(1);
    }
    await assertReconciledByApi(orm, app.url, wallets);
  });

  test('30 BETs of 1.00 on one wallet with 20.00: exactly 20 pass, the balance ends at zero and never below', async () => {
    const wallet = await createWallet(app.url, '20.00');

    const responses = await Promise.all(Array.from({ length: 30 }, () => post(app.url, submission(wallet, { money: { amount: '1.00', currency: 'BRL' } }))));

    expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
    const rejected = responses.filter((response) => response.status === 422);
    expect(rejected).toHaveLength(10);
    expect(rejected.every((response) => response.body.failureCode === 'INSUFFICIENT_FUNDS')).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('0.00');
    const versions = await sql(orm, 'select wallet_version from wallet_ledger_entries where wallet_id = ? order by wallet_version', [wallet.id]);
    expect(versions.map((row) => Number(row.wallet_version))).toEqual(Array.from({ length: 21 }, (_, index) => index + 1));
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});

describe('independent wallets do not interfere (CONC-03)', () => {
  test('10 wallets receiving 5 BETs each at the same time end with their own balances', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, index) => createWallet(app.url, `${100 + index}.00`)));

    const responses = await Promise.all(
      wallets.flatMap((wallet) => Array.from({ length: 5 }, () => post(app.url, submission(wallet, { money: { amount: '10.00', currency: 'BRL' } })))),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    for (const [index, wallet] of wallets.entries()) {
      expect(await balanceOf(wallet.id)).toBe(`${50 + index}.00`);
    }
    await assertReconciledByApi(orm, app.url, wallets.map((wallet) => wallet.id));
  });

  test('a held lock on one wallet does not delay another', async () => {
    const { holdWalletLock } = await import('../support/context');
    const blocked = await createWallet(app.url, '100.00');
    const free = await createWallet(app.url, '100.00');
    const holder = holdWalletLock(orm, blocked.id, 800);
    await holder.acquired;

    const started = Date.now();
    const response = await post(app.url, submission(free));
    const elapsed = Date.now() - started;
    await holder.released;

    expect(response.status).toBe(201);
    expect(elapsed).toBeLessThan(600);
    await assertReconciledByApi(orm, app.url, [blocked.id, free.id]);
  });
});

describe('a reference is reversed once (REV-08)', () => {
  async function betWith(wallet: { id: string; playerId: string }) {
    const providerId = `provider-${uuid()}`;
    const roundId = `round-${uuid()}`;
    const betId = `bet-${uuid()}`;
    await post(app.url, submission(wallet, { providerId, roundId, externalTransactionId: betId, money: { amount: '40.00', currency: 'BRL' } }));
    return { providerId, roundId, betId };
  }

  test('REFUND and ROLLBACK at the same time: one wins, the other is REFERENCE_ALREADY_REVERSED, repeated 10 times', async () => {
    const wallets: string[] = [];
    for (let round = 0; round < 10; round += 1) {
      const wallet = await createWallet(app.url, '100.00');
      wallets.push(wallet.id);
      const bet = await betWith(wallet);
      const reverse = (kind: string) =>
        post(app.url, submission(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind, referenceExternalTransactionId: bet.betId, money: { amount: '40.00', currency: 'BRL' } }));

      const results = await Promise.all([reverse('REFUND'), reverse('ROLLBACK')]);

      expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
      const loser = results.find((result) => result.status === 422);
      expect(loser?.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
      expect(await balanceOf(wallet.id)).toBe('100.00');
    }
    await assertReconciledByApi(orm, app.url, wallets);
  });

  test('ten refunds of one BET with different keys: exactly one credit', async () => {
    const wallet = await createWallet(app.url, '100.00');
    const bet = await betWith(wallet);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(app.url, submission(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: 'REFUND', referenceExternalTransactionId: bet.betId, money: { amount: '40.00', currency: 'BRL' } })),
      ),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 422 && result.body.failureCode === 'REFERENCE_ALREADY_REVERSED')).toHaveLength(9);
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await count(`select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'CREDIT'`, [wallet.id])).toBe(2);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});
