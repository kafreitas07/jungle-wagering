import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { ExternalIdConflictError, IdempotencyConflictError } from '../../../src/application/errors/application-errors';
import { isUniqueViolation } from '../../../src/application/services/sql-errors';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction, type SubmitWagerTransactionCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import { Money } from '../../../src/domain/money/money';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, testUnitOfWork } from '../../support/context';
import { assertReconciledViaApp } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
let submit: SubmitWagerTransaction;
let unitOfWork: ReturnType<typeof testUnitOfWork>;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  unitOfWork = testUnitOfWork(orm, 5000);
  openWallet = new OpenWallet({ unitOfWork, clock });
  submit = new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });
});

afterAll(async () => {
  await closeTestOrm();
});

const newWallet = (balance = '1000.00') => openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' } });

function command(wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand {
  const n = uuid();
  return {
    idempotencyKey: `key-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

const state = async (walletId: string) => ({
  wallet: (await sql(orm, 'select balance::text as balance, version from wallets where id = ?', [walletId]))[0],
  ledger: (await sql(orm, 'select count(*)::int as n from wallet_ledger_entries where wallet_id = ?', [walletId]))[0]?.n,
  outbox: (await sql(orm, 'select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]))[0]?.n,
  transactions: (await sql(orm, 'select count(*)::int as n from wager_transactions where wallet_id = ?', [walletId]))[0]?.n,
});

describe('replay of the same key and payload (IDEM-02, IDEM-03)', () => {
  test('returns the same transaction with the persisted state, and changes nothing', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    const first = await submit.execute(original);
    const before = await state(wallet.id);

    const second = await submit.execute(original);

    expect(first.replay).toBe(false);
    expect(second.replay).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect(second.transaction.status).toBe('PROCESSED');
    expect(second.transaction.balanceAfter?.toString()).toBe('975.00');
    expect(await state(wallet.id)).toEqual(before);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a replay reports the balance of the original processing, not the current one', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);
    await submit.execute(command(wallet, { money: { amount: '100.00', currency: 'BRL' } }));

    const replay = await submit.execute(original);

    expect(replay.transaction.balanceAfter?.toString()).toBe('975.00');
  });

  test('a replay of a REJECTED transaction returns the rejection', async () => {
    const wallet = await newWallet('10.00');
    const original = command(wallet, { money: { amount: '99.00', currency: 'BRL' } });
    await submit.execute(original);

    const replay = await submit.execute(original);

    expect(replay.replay).toBe(true);
    expect(replay.transaction.status).toBe('REJECTED');
    expect(replay.transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await state(wallet.id)).transactions).toBe(2);
  });

  test('a replay of a PENDING_REFERENCE transaction returns it as pending', async () => {
    const wallet = await newWallet();
    const original = command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-missing' });
    const first = await submit.execute(original);

    const replay = await submit.execute(original);

    expect(first.transaction.status).toBe('PENDING_REFERENCE');
    expect(replay.replay).toBe(true);
    expect(replay.transaction.status).toBe('PENDING_REFERENCE');
    expect(replay.transaction.id).toBe(first.transaction.id);
  });

  test('a replay of a transaction that left PENDING_REFERENCE reflects the current state', async () => {
    const wallet = await newWallet();
    const original = command(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-missing' });
    const first = await submit.execute(original);
    await unitOfWork.run(async (tx) => {
      const pending = (await tx.transactions.findById(first.transaction.id))!;
      pending.reject({ failureCode: 'REFERENCE_NOT_FOUND', balanceAfter: Money.from({ amount: '1000.00', currency: 'BRL' }), at: clock.now() });
      await tx.transactions.save(pending);
    });

    const replay = await submit.execute(original);

    expect(replay.replay).toBe(true);
    expect(replay.transaction.status).toBe('REJECTED');
    expect(replay.transaction.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test('metadata outside the business payload (correlation id) does not change the identity of the request', async () => {
    const wallet = await newWallet();
    const original = command(wallet, { correlationId: 'first' });
    await submit.execute(original);

    const replay = await submit.execute({ ...original, correlationId: 'second', causationId: 'other' });

    expect(replay.replay).toBe(true);
  });

  test('20 simultaneous identical requests create one transaction, one ledger entry and 19 replays', async () => {
    const wallet = await newWallet();
    const original = command(wallet);

    const results = await Promise.all(Array.from({ length: 20 }, () => submit.execute(original)));

    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(results.filter((r) => r.replay)).toHaveLength(19);
    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(await state(wallet.id)).toMatchObject({ wallet: { balance: '975.00', version: 2 }, ledger: 2, transactions: 2 });
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('conflicts (IDEM-04, IDEM-05)', () => {
  test('the same key with another amount is a conflict and applies nothing', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);
    const before = await state(wallet.id);

    await expect(submit.execute({ ...original, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await state(wallet.id)).toEqual(before);
  });

  test.each([
    ['kind', { kind: 'WIN' as const }],
    ['round', { roundId: 'round-2' }],
    ['game', { gameId: 'game-2' }],
    ['external transaction id', { externalTransactionId: 'another-external' }],
  ])('the same key with another %s is a conflict', async (_name, change) => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);

    await expect(submit.execute({ ...original, ...change })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test('the same external id under another key is an external id conflict', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);
    const before = await state(wallet.id);

    await expect(submit.execute({ ...original, idempotencyKey: 'a-different-key' })).rejects.toBeInstanceOf(ExternalIdConflictError);

    expect(await state(wallet.id)).toEqual(before);
  });

  test('providers are independent: the same key and external id under another provider both succeed', async () => {
    const wallet = await newWallet();
    const original = command(wallet);
    await submit.execute(original);

    const other = await submit.execute({ ...original, providerId: 'provider-b' });

    expect(other.replay).toBe(false);
    expect((await state(wallet.id)).wallet?.balance).toBe('950.00');
  });

  test('the same key used for two wallets: the second is refused and only the first is debited', async () => {
    const [first, second] = await Promise.all([newWallet(), newWallet()]);
    const original = command(first);
    await submit.execute(original);

    await expect(submit.execute({ ...original, walletId: second.id, playerId: second.playerId })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect((await state(second.id)).wallet?.balance).toBe('1000.00');
  });

  test('simultaneous requests with one key for two wallets: the unique constraint lets exactly one through', async () => {
    const [first, second] = await Promise.all([newWallet(), newWallet()]);
    const key = `shared-${uuid()}`;
    const externalA = `ext-${uuid()}`;

    const results = await Promise.allSettled([
      submit.execute(command(first, { idempotencyKey: key, externalTransactionId: externalA })),
      submit.execute(command(second, { idempotencyKey: key, externalTransactionId: `ext-${uuid()}` })),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected[0]!.reason instanceof IdempotencyConflictError || isUniqueViolation(rejected[0]!.reason, 'wager_transactions_idempotency_key'),
    ).toBe(true);
    expect(await sql(orm, `select 1 from wager_transactions where provider_id = 'provider-a' and idempotency_key = ?`, [key])).toHaveLength(1);
    await assertReconciledViaApp(orm, [first.id, second.id]);
  });
});
