import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../../src/application/errors/application-errors';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import {
  SubmitWagerTransaction,
  type SubmitWagerTransactionCommand,
} from '../../../src/application/use-cases/submit-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, outboxEventTypes, testUnitOfWork } from '../../support/context';
import { assertReconciledViaApp } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
let submit: SubmitWagerTransaction;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  const unitOfWork = testUnitOfWork(orm, 5000);
  openWallet = new OpenWallet({ unitOfWork, clock });
  submit = new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });
});

afterAll(async () => {
  await closeTestOrm();
});

const newWallet = (balance = '1000.00', currency = 'BRL') =>
  openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency } });

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

const send = (wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}) => submit.execute(command(wallet, overrides));

const walletRow = async (id: string) => (await sql(orm, 'select balance::text as balance, version from wallets where id = ?', [id]))[0];
const ledgerRows = (walletId: string) =>
  sql(orm, 'select direction, amount::text as amount, balance_after::text as after, wallet_version from wallet_ledger_entries where wallet_id = ? order by wallet_version', [walletId]);

describe('BET, WIN and LOSS (TXN-01..04)', () => {
  test('a BET debits the balance, bumps the version and writes one DEBIT entry', async () => {
    const wallet = await newWallet('1000.00');

    const { transaction, replay } = await send(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    expect(replay).toBe(false);
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.balanceAfter?.toString()).toBe('975.00');
    expect(await walletRow(wallet.id)).toEqual({ balance: '975.00', version: 2 });
    expect(await ledgerRows(wallet.id)).toEqual([
      { direction: 'CREDIT', amount: '1000.00', after: '1000.00', wallet_version: 1 },
      { direction: 'DEBIT', amount: '25.00', after: '975.00', wallet_version: 2 },
    ]);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('the ledger entry belongs to the transaction and carries the wallet version after the change', async () => {
    const wallet = await newWallet();

    const { transaction } = await send(wallet);

    const rows = await sql(orm, 'select transaction_id, wallet_version from wallet_ledger_entries where transaction_id = ?', [transaction.id]);
    expect(rows).toEqual([{ transaction_id: transaction.id, wallet_version: 2 }]);
  });

  test('BET → WIN → LOSS: balances, entries and versions follow', async () => {
    const wallet = await newWallet('100.00');
    const bet = await send(wallet, { externalTransactionId: 'bet-1', money: { amount: '40.00', currency: 'BRL' } });
    const win = await send(wallet, { kind: 'WIN', externalTransactionId: 'win-1', referenceExternalTransactionId: 'bet-1', money: { amount: '90.00', currency: 'BRL' } });
    const loss = await send(wallet, { kind: 'LOSS', externalTransactionId: 'loss-1', referenceExternalTransactionId: 'bet-1', money: { amount: '0.00', currency: 'BRL' } });

    expect(bet.transaction.balanceAfter?.toString()).toBe('60.00');
    expect(win.transaction.balanceAfter?.toString()).toBe('150.00');
    expect(loss.transaction.status).toBe('PROCESSED');
    expect(loss.transaction.balanceAfter?.toString()).toBe('150.00');
    expect(await walletRow(wallet.id)).toEqual({ balance: '150.00', version: 3 });
    expect((await ledgerRows(wallet.id)).map((row) => row.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a LOSS moves nothing: no ledger entry, same version, only a transaction event', async () => {
    const wallet = await newWallet('100.00');

    const { transaction } = await send(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } });

    expect(transaction.status).toBe('PROCESSED');
    expect(await walletRow(wallet.id)).toEqual({ balance: '100.00', version: 1 });
    expect(await ledgerRows(wallet.id)).toHaveLength(1);
    expect(await sql(orm, `select 1 from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged' and (payload->'data'->>'transactionId') = ?`, [wallet.id, transaction.id])).toHaveLength(0);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a WIN without reference credits the balance', async () => {
    const wallet = await newWallet('10.00');

    const { transaction } = await send(wallet, { kind: 'WIN', money: { amount: '15.50', currency: 'BRL' } });

    expect(transaction.balanceAfter?.toString()).toBe('25.50');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a BET of exactly the balance leaves 0.00 (the boundary is allowed)', async () => {
    const wallet = await newWallet('25.00');

    const { transaction } = await send(wallet, { money: { amount: '25.00', currency: 'BRL' } });

    expect(transaction.status).toBe('PROCESSED');
    expect(await walletRow(wallet.id)).toEqual({ balance: '0.00', version: 2 });
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a processed BET emits WagerTransactionProcessed and WalletBalanceChanged for the wallet group', async () => {
    const wallet = await newWallet();
    const { transaction } = await send(wallet);

    const rows = await sql(
      orm,
      `select event_type, group_key, payload->>'correlationId' as correlation from outbox_messages
        where aggregate_id = ? and (payload->'data'->>'transactionId') = ? order by event_type`,
      [wallet.id, transaction.id],
    );

    expect(rows.map((row) => row.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(rows.every((row) => row.group_key === wallet.id)).toBe(true);
  });

  test('the correlation and causation ids of the command are carried by its events', async () => {
    const wallet = await newWallet();
    const { transaction } = await send(wallet, { correlationId: 'corr-xyz', causationId: 'msg-123' });

    const rows = await sql(
      orm,
      `select payload->>'correlationId' as c, payload->>'causationId' as k from outbox_messages where (payload->'data'->>'transactionId') = ?`,
      [transaction.id],
    );

    expect(rows).toEqual([
      { c: 'corr-xyz', k: 'msg-123' },
      { c: 'corr-xyz', k: 'msg-123' },
    ]);
  });
});

describe('business rejections are persisted (TXN-07, TXN-08, REV-*)', () => {
  async function expectRejection(wallet: Wallet, result: Awaited<ReturnType<typeof send>>, code: string, balanceBefore: string) {
    const { transaction } = result;
    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode as string | null).toBe(code);
    expect(transaction.balanceAfter?.toString()).toBe(balanceBefore);
    const stored = await sql(orm, 'select status, failure_code from wager_transactions where id = ?', [transaction.id]);
    expect(stored).toEqual([{ status: 'REJECTED', failure_code: code }]);
    expect((await walletRow(wallet.id))?.balance).toBe(balanceBefore);
    expect(await sql(orm, 'select 1 from wallet_ledger_entries where transaction_id = ?', [transaction.id])).toHaveLength(0);
    expect(await sql(orm, `select 1 from outbox_messages where event_type = 'WagerTransactionRejected' and (payload->'data'->>'transactionId') = ?`, [transaction.id])).toHaveLength(1);
    await assertReconciledViaApp(orm, [wallet.id]);
  }

  test('INSUFFICIENT_FUNDS: a BET above the balance', async () => {
    const wallet = await newWallet('10.00');

    await expectRejection(wallet, await send(wallet, { money: { amount: '10.01', currency: 'BRL' } }), 'INSUFFICIENT_FUNDS', '10.00');
    expect((await walletRow(wallet.id))?.version).toBe(1);
  });

  test('REVERSAL_INSUFFICIENT_FUNDS: reversing a WIN the balance can no longer cover', async () => {
    const wallet = await newWallet('100.00');
    await send(wallet, { kind: 'WIN', externalTransactionId: 'win-big', money: { amount: '500.00', currency: 'BRL' } });
    await send(wallet, { externalTransactionId: 'spend', money: { amount: '550.00', currency: 'BRL' } });

    const result = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'win-big', money: { amount: '500.00', currency: 'BRL' } });

    await expectRejection(wallet, result, 'REVERSAL_INSUFFICIENT_FUNDS', '50.00');
  });

  test('REFERENCE_MISMATCH: the reference is from another round', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-r1', roundId: 'round-A' });

    const result = await send(wallet, { kind: 'REFUND', roundId: 'round-B', referenceExternalTransactionId: 'bet-r1' });

    await expectRejection(wallet, result, 'REFERENCE_MISMATCH', '975.00');
  });

  test('INVALID_REFERENCE_KIND: a REFUND of a WIN', async () => {
    const wallet = await newWallet();
    await send(wallet, { kind: 'WIN', externalTransactionId: 'a-win' });

    const result = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'a-win' });

    await expectRejection(wallet, result, 'INVALID_REFERENCE_KIND', '1025.00');
  });

  test('INVALID_REFERENCE_KIND: a WIN that references another WIN', async () => {
    const wallet = await newWallet();
    await send(wallet, { kind: 'WIN', externalTransactionId: 'w1' });

    const result = await send(wallet, { kind: 'WIN', referenceExternalTransactionId: 'w1' });

    await expectRejection(wallet, result, 'INVALID_REFERENCE_KIND', '1025.00');
  });

  test('INVALID_REFERENCE_KIND: a transaction that references itself', async () => {
    const wallet = await newWallet();

    const result = await send(wallet, { kind: 'REFUND', externalTransactionId: 'me', referenceExternalTransactionId: 'me' });

    await expectRejection(wallet, result, 'INVALID_REFERENCE_KIND', '1000.00');
  });

  test('REFERENCE_NOT_PROCESSED: the reference was itself rejected', async () => {
    const wallet = await newWallet('10.00');
    await send(wallet, { externalTransactionId: 'rejected-bet', money: { amount: '99.00', currency: 'BRL' } });

    const result = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'rejected-bet', money: { amount: '99.00', currency: 'BRL' } });

    await expectRejection(wallet, result, 'REFERENCE_NOT_PROCESSED', '10.00');
  });

  test('AMOUNT_MISMATCH: a reversal for another amount than the original', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-amt', money: { amount: '25.00', currency: 'BRL' } });

    const result = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-amt', money: { amount: '20.00', currency: 'BRL' } });

    await expectRejection(wallet, result, 'AMOUNT_MISMATCH', '975.00');
  });

  test('REFERENCE_ALREADY_REVERSED: a BET reversed twice, by REFUND then ROLLBACK', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-twice' });
    const first = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-twice' });
    expect(first.transaction.status).toBe('PROCESSED');

    const second = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-twice' });

    await expectRejection(wallet, second, 'REFERENCE_ALREADY_REVERSED', '1000.00');
  });

  test('REFERENCE_ALREADY_REVERSED: the other order too, ROLLBACK first and REFUND second', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-twice-rb' });
    const first = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-twice-rb' });
    expect(first.transaction.status).toBe('PROCESSED');

    const second = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-twice-rb' });

    await expectRejection(wallet, second, 'REFERENCE_ALREADY_REVERSED', '1000.00');
  });
});

describe('reversals (REV-01..10)', () => {
  test('a REFUND of a BET credits the amount back and links the original transaction', async () => {
    const wallet = await newWallet();
    const bet = await send(wallet, { externalTransactionId: 'bet-ref' });

    const refund = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-ref' });

    expect(refund.transaction.status).toBe('PROCESSED');
    expect(refund.transaction.referenceTransactionId).toBe(bet.transaction.id);
    expect(await walletRow(wallet.id)).toEqual({ balance: '1000.00', version: 3 });
    expect((await ledgerRows(wallet.id)).map((row) => row.direction)).toEqual(['CREDIT', 'DEBIT', 'CREDIT']);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a ROLLBACK of a BET credits the amount back', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-rb' });

    const rollback = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'bet-rb' });

    expect(rollback.transaction.balanceAfter?.toString()).toBe('1000.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a ROLLBACK of a WIN debits the amount', async () => {
    const wallet = await newWallet('100.00');
    await send(wallet, { kind: 'WIN', externalTransactionId: 'win-rb', money: { amount: '60.00', currency: 'BRL' } });

    const rollback = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'win-rb', money: { amount: '60.00', currency: 'BRL' } });

    expect(rollback.transaction.status).toBe('PROCESSED');
    expect(rollback.transaction.balanceAfter?.toString()).toBe('100.00');
    expect((await ledgerRows(wallet.id)).map((row) => row.direction)).toEqual(['CREDIT', 'CREDIT', 'DEBIT']);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a ROLLBACK of a processed REFUND debits what the refund credited', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-x' });
    await send(wallet, { kind: 'REFUND', externalTransactionId: 'refund-x', referenceExternalTransactionId: 'bet-x' });

    const rollback = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'refund-x' });

    expect(rollback.transaction.status).toBe('PROCESSED');
    expect(rollback.transaction.balanceAfter?.toString()).toBe('975.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a rejected reversal does not consume the reference: a correct one still works', async () => {
    const wallet = await newWallet();
    await send(wallet, { externalTransactionId: 'bet-retry' });
    await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-retry', money: { amount: '20.00', currency: 'BRL' } });

    const ok = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-retry' });

    expect(ok.transaction.status).toBe('PROCESSED');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('PENDING_REFERENCE (PREF-01)', () => {
  test('a REFUND whose reference does not exist yet is accepted as pending, without touching the wallet', async () => {
    const wallet = await newWallet();

    const { transaction } = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' });

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.failureCode).toBeNull();
    expect(transaction.balanceAfter?.toString()).toBe('1000.00');
    expect(transaction.nextAttemptAt).toEqual(new Date(clock.now().getTime() + 1000));
    expect(await walletRow(wallet.id)).toEqual({ balance: '1000.00', version: 1 });
    expect(await ledgerRows(wallet.id)).toHaveLength(1);
    expect(await sql(orm, 'select status, next_attempt_at is not null as scheduled from wager_transactions where id = ?', [transaction.id])).toEqual([{ status: 'PENDING_REFERENCE', scheduled: true }]);
    expect(await sql(orm, `select 1 from outbox_messages where event_type = 'WagerTransactionPendingReference' and (payload->'data'->>'transactionId') = ?`, [transaction.id])).toHaveLength(1);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a WIN that names a missing reference is also pending', async () => {
    const wallet = await newWallet();

    const { transaction } = await send(wallet, { kind: 'WIN', referenceExternalTransactionId: 'bet-later' });

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect((await walletRow(wallet.id))?.balance).toBe('1000.00');
  });

  test('a reversal whose reference is itself pending waits too', async () => {
    const wallet = await newWallet();
    await send(wallet, { kind: 'REFUND', externalTransactionId: 'pending-refund', referenceExternalTransactionId: 'nowhere' });

    const { transaction } = await send(wallet, { kind: 'ROLLBACK', referenceExternalTransactionId: 'pending-refund' });

    expect(transaction.status).toBe('PENDING_REFERENCE');
  });
});

describe('inconsistent identity writes nothing (WAL-07, WAL-09)', () => {
  async function expectNothingWritten(wallet: Wallet | undefined, externalTransactionId: string, action: Promise<unknown>, error: new (...args: never[]) => Error) {
    await expect(action).rejects.toBeInstanceOf(error);
    expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [externalTransactionId])).toHaveLength(0);
    if (wallet !== undefined) {
      expect(await walletRow(wallet.id)).toEqual({ balance: '1000.00', version: 1 });
      expect(await outboxEventTypes(orm, wallet.id)).toHaveLength(2);
      await assertReconciledViaApp(orm, [wallet.id]);
    }
  }

  test('WALLET_NOT_FOUND', async () => {
    const wallet = await newWallet();

    await expectNothingWritten(undefined, 'ghost-wallet', submit.execute(command(wallet, { walletId: uuid(), externalTransactionId: 'ghost-wallet' })), WalletNotFoundError);
  });

  test('WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await newWallet();

    await expectNothingWritten(wallet, 'other-player', submit.execute(command(wallet, { playerId: uuid(), externalTransactionId: 'other-player' })), WalletPlayerMismatchError);
  });

  test('CURRENCY_MISMATCH', async () => {
    const wallet = await newWallet();

    await expectNothingWritten(wallet, 'other-currency', submit.execute(command(wallet, { externalTransactionId: 'other-currency', money: { amount: '5.00', currency: 'USD' } })), WalletCurrencyMismatchError);
  });
});

describe('concurrency (CONC-02, CONC-03, CONC-06)', () => {
  test('many BETs on the same wallet serialize: no lost update, one entry per BET', async () => {
    const wallet = await newWallet('1000.00');

    const results = await Promise.all(Array.from({ length: 12 }, () => send(wallet, { money: { amount: '10.00', currency: 'BRL' } })));

    expect(results.every((r) => r.transaction.status === 'PROCESSED')).toBe(true);
    expect(await walletRow(wallet.id)).toEqual({ balance: '880.00', version: 13 });
    expect(await ledgerRows(wallet.id)).toHaveLength(13);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('different wallets are processed in parallel and each reconciles', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet('500.00')));

    await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 5 }, () => send(wallet, { money: { amount: '20.00', currency: 'BRL' } }))));

    for (const wallet of wallets) {
      expect(await walletRow(wallet.id)).toEqual({ balance: '400.00', version: 6 });
    }
    await assertReconciledViaApp(orm, wallets.map((wallet) => wallet.id));
  });

  test('concurrent BETs that exceed the balance: exactly the affordable ones pass, the rest are REJECTED', async () => {
    const wallet = await newWallet('100.00');

    const results = await Promise.all(Array.from({ length: 5 }, () => send(wallet, { money: { amount: '30.00', currency: 'BRL' } })));

    expect(results.filter((r) => r.transaction.status === 'PROCESSED')).toHaveLength(3);
    expect(results.filter((r) => r.transaction.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(2);
    expect(await walletRow(wallet.id)).toEqual({ balance: '10.00', version: 4 });
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});
