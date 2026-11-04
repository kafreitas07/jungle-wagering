import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletAlreadyExistsError } from '../../../src/application/errors/application-errors';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { InvalidMoneyError } from '../../../src/domain/errors/domain-errors';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, outboxEventTypes, testUnitOfWork } from '../../support/context';
import { assertReconciled } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
const clock = new FakeClock();

beforeAll(async () => {
  orm = await getTestOrm();
  openWallet = new OpenWallet({ unitOfWork: testUnitOfWork(orm), clock });
});

afterAll(async () => {
  await closeTestOrm();
});

const open = (playerId = uuid(), amount = '1000.00', currency = 'BRL') =>
  openWallet.execute({ playerId, initialBalance: { amount, currency }, correlationId: 'corr-open' });

describe('OpenWallet with a positive initial balance (WAL-01, OUT-03, LEDG-01)', () => {
  test('creates the wallet at version 1 with the initial balance', async () => {
    const wallet = await open(undefined, '1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(await sql(orm, 'select balance::text as b, version, currency from wallets where id = ?', [wallet.id])).toEqual([
      { b: '1000.00', version: 1, currency: 'BRL' },
    ]);
  });

  test('records one OPENING transaction, PROCESSED, from the internal provider', async () => {
    const wallet = await open();

    const rows = await sql(
      orm,
      `select provider_id, external_transaction_id, idempotency_key, kind, status, amount::text as amount, balance_after::text as after
         from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );

    expect(rows).toEqual([
      {
        provider_id: 'internal',
        external_transaction_id: `opening:${wallet.id}`,
        idempotency_key: `opening:${wallet.id}`,
        kind: 'OPENING',
        status: 'PROCESSED',
        amount: '1000.00',
        after: '1000.00',
      },
    ]);
  });

  test('records one CREDIT ledger entry from 0.00 at wallet version 1', async () => {
    const wallet = await open();

    expect(
      await sql(
        orm,
        `select direction, amount::text as amount, balance_before::text as before, balance_after::text as after, wallet_version
           from wallet_ledger_entries where wallet_id = ?`,
        [wallet.id],
      ),
    ).toEqual([{ direction: 'CREDIT', amount: '1000.00', before: '0.00', after: '1000.00', wallet_version: 1 }]);
  });

  test('enqueues WagerTransactionProcessed and WalletBalanceChanged, grouped by wallet', async () => {
    const wallet = await open();

    expect((await outboxEventTypes(orm, wallet.id)).sort()).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    const groups = await sql(orm, 'select distinct group_key, published_at from outbox_messages where aggregate_id = ?', [wallet.id]);
    expect(groups).toEqual([{ group_key: wallet.id, published_at: null }]);
    const correlation = await sql(orm, `select payload->>'correlationId' as c from outbox_messages where aggregate_id = ?`, [wallet.id]);
    expect(correlation.map((row) => row.c)).toEqual(['corr-open', 'corr-open']);
  });

  test('the ledger reconciles with the balance', async () => {
    const wallet = await open();

    await assertReconciled(orm, [wallet.id]);
  });
});

describe('OpenWallet with a zero initial balance (WAL-02)', () => {
  test('creates the wallet without transaction, ledger entry or balance event', async () => {
    const wallet = await open(undefined, '0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(await sql(orm, 'select 1 from wager_transactions where wallet_id = ?', [wallet.id])).toHaveLength(0);
    expect(await sql(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [wallet.id])).toHaveLength(0);
    expect(await outboxEventTypes(orm, wallet.id)).toEqual([]);
    await assertReconciled(orm, [wallet.id]);
  });
});

describe('OpenWallet uniqueness per player and currency (WAL-03, WAL-04)', () => {
  test('a second wallet for the same player and currency fails with WalletAlreadyExists and writes nothing', async () => {
    const playerId = uuid();
    const first = await open(playerId);

    await expect(open(playerId, '50.00')).rejects.toBeInstanceOf(WalletAlreadyExistsError);

    expect(await sql(orm, 'select id from wallets where player_id = ?', [playerId])).toEqual([{ id: first.id }]);
  });

  test('the same player may open a wallet in another currency', async () => {
    const playerId = uuid();
    await open(playerId, '10.00', 'BRL');

    const usd = await open(playerId, '10.00', 'USD');

    expect(usd.currency).toBe('USD');
  });

  test('10 concurrent creations for the same player and currency: exactly one wins', async () => {
    const playerId = uuid();

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => open(playerId)));

    const winners = results.filter((r) => r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    for (const loser of losers) {
      expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(WalletAlreadyExistsError);
    }
    const wallets = await sql(orm, 'select id from wallets where player_id = ?', [playerId]);
    expect(wallets).toHaveLength(1);
    expect(await sql(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [wallets[0]?.id])).toHaveLength(1);
    await assertReconciled(orm, [String(wallets[0]?.id)]);
  });
});

describe('OpenWallet invalid input', () => {
  test('a negative initial balance is refused and nothing is written', async () => {
    const playerId = uuid();

    await expect(open(playerId, '-1.00')).rejects.toBeInstanceOf(InvalidMoneyError);

    expect(await sql(orm, 'select 1 from wallets where player_id = ?', [playerId])).toHaveLength(0);
  });
});
