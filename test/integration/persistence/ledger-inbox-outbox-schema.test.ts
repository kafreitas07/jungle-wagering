import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { assertReconciled } from '../../support/reconcile';
import { failure, insertLedgerEntry, insertTransaction, insertWallet, sql, uuid } from '../../support/sql';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

async function walletWithTransaction(balance = '100.00') {
  const wallet = await insertWallet(orm, { balance });
  const transactionId = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId });
  return { wallet, transactionId };
}

describe('ledger constraints (LEDG-02, LEDG-04)', () => {
  test('accepts a coherent DEBIT and a coherent CREDIT', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    const second = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId });

    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'DEBIT', amount: '10.00', balanceBefore: '100.00', balanceAfter: '90.00', walletVersion: 2 });
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId: second, direction: 'CREDIT', amount: '5.50', balanceBefore: '90.00', balanceAfter: '95.50', walletVersion: 3 });
  });

  test('amount must be greater than zero', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(
      insertLedgerEntry(orm, { walletId: wallet.id, transactionId, amount: '0.00', balanceBefore: '100.00', balanceAfter: '100.00' }),
    ).rejects.toThrow(/wallet_ledger_entries_amount_positive/);
  });

  test('balance_before can never be negative', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(
      insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'CREDIT', amount: '2.00', balanceBefore: '-1.00', balanceAfter: '1.00' }),
    ).rejects.toThrow(/wallet_ledger_entries_balances_non_negative/);
  });

  test('balance_after can never be negative', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(
      insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'DEBIT', amount: '2.00', balanceBefore: '1.00', balanceAfter: '-1.00' }),
    ).rejects.toThrow(/wallet_ledger_entries_balances_non_negative/);
  });

  test('balance_after must equal balance_before + amount for a CREDIT', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(
      insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'CREDIT', amount: '10.00', balanceBefore: '100.00', balanceAfter: '109.99' }),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
  });

  test('balance_after must equal balance_before - amount for a DEBIT', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(
      insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'DEBIT', amount: '10.00', balanceBefore: '100.00', balanceAfter: '110.00' }),
    ).rejects.toThrow(/wallet_ledger_entries_arithmetic/);
  });

  test('direction only accepts CREDIT and DEBIT', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'SWAP' })).rejects.toThrow(
      /wallet_ledger_entries_direction_valid/,
    );
  });

  test('one ledger entry per transaction (no duplicate debit or credit)', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId, walletVersion: 2 });

    await expect(insertLedgerEntry(orm, { walletId: wallet.id, transactionId, walletVersion: 3 })).rejects.toThrow(
      /wallet_ledger_entries_transaction_key/,
    );
  });

  test('wallet_version is unique per wallet', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    const other = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId });
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId, walletVersion: 2 });

    await expect(insertLedgerEntry(orm, { walletId: wallet.id, transactionId: other, walletVersion: 2 })).rejects.toThrow(
      /wallet_ledger_entries_wallet_version_key/,
    );
  });

  test('the entry currency must be the wallet currency (composite FK)', async () => {
    const { wallet, transactionId } = await walletWithTransaction();

    await expect(insertLedgerEntry(orm, { walletId: wallet.id, transactionId, currency: 'USD' })).rejects.toThrow(
      /wallet_ledger_entries_wallet_currency_fkey/,
    );
  });

  test('the transaction must exist (FK)', async () => {
    const { wallet } = await walletWithTransaction();

    await expect(insertLedgerEntry(orm, { walletId: wallet.id, transactionId: uuid() })).rejects.toThrow(
      /wallet_ledger_entries_transaction_fkey/,
    );
  });
});

describe('ledger is immutable (LEDG-03)', () => {
  test('UPDATE fails', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    const id = await insertLedgerEntry(orm, { walletId: wallet.id, transactionId });

    const error = await failure(orm, `update wallet_ledger_entries set amount = 1 where id = ?`, [id]);

    expect(error.message).toContain('immutable');
  });

  test('DELETE fails', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    const id = await insertLedgerEntry(orm, { walletId: wallet.id, transactionId });

    const error = await failure(orm, `delete from wallet_ledger_entries where id = ?`, [id]);

    expect(error.message).toContain('immutable');
    expect(await sql(orm, 'select 1 from wallet_ledger_entries where id = ?', [id])).toHaveLength(1);
  });

  test('TRUNCATE fails', async () => {
    const error = await failure(orm, `truncate table wallet_ledger_entries`);

    expect(error.message).toContain('immutable');
  });
});

describe('inbox_messages', () => {
  test('(consumer, message id) is the primary key', async () => {
    const messageId = `msg-${uuid()}`;
    const insert = () =>
      sql(orm, `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values ('wagering', ?, ?, now())`, [
        messageId,
        'b'.repeat(64),
      ]);
    await insert();

    await expect(insert()).rejects.toThrow(/inbox_messages_pkey/);
  });

  test('the same message id is independent per consumer', async () => {
    const messageId = `msg-${uuid()}`;
    for (const consumer of ['one', 'two']) {
      await sql(orm, `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())`, [
        consumer,
        messageId,
        'b'.repeat(64),
      ]);
    }
  });
});

describe('outbox_messages (OUT-08)', () => {
  const insertOutbox = (id = uuid(), extra = '') =>
    sql(
      orm,
      `insert into outbox_messages (id, aggregate_id, group_key, event_type, payload, occurred_at, next_attempt_at)
       values (?, ?, ?, 'WalletBalanceChanged', '{"a":1}'::jsonb, now(), now()) ${extra}`,
      [id, uuid(), uuid()],
    );

  test('starts with 0 attempts, no lease, not published and no error', async () => {
    const id = uuid();
    await insertOutbox(id);

    const row = (await sql(orm, 'select * from outbox_messages where id = ?', [id]))[0];

    expect(row).toMatchObject({ attempts: 0, locked_until: null, published_at: null, last_error: null });
    expect(row?.payload).toEqual({ a: 1 });
  });

  test('attempts can never be negative', async () => {
    const id = uuid();
    await insertOutbox(id);

    await expect(sql(orm, `update outbox_messages set attempts = -1 where id = ?`, [id])).rejects.toThrow(
      /outbox_messages_attempts_non_negative/,
    );
  });

  test('has a partial index over unpublished messages', async () => {
    const rows = await sql(orm, `select indexdef from pg_indexes where indexname = 'outbox_messages_unpublished'`);

    expect(rows).toHaveLength(1);
    expect(String(rows[0]?.indexdef)).toContain('published_at IS NULL');
  });
});

describe('assertReconciled (TEST-04, CONC-08)', () => {
  test('passes when balance equals the ledger rebuilt', async () => {
    const wallet = await insertWallet(orm, { balance: '0.00', version: 1 });
    const open = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, kind: 'WIN' });
    const bet = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId });
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId: open, direction: 'CREDIT', amount: '100.00', balanceBefore: '0.00', balanceAfter: '100.00', walletVersion: 1 });
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId: bet, direction: 'DEBIT', amount: '30.25', balanceBefore: '100.00', balanceAfter: '69.75', walletVersion: 2 });
    await sql(orm, `update wallets set balance = 69.75, version = 2 where id = ?`, [wallet.id]);

    await assertReconciled(orm, [wallet.id]);
  });

  test('passes for a wallet without entries and zero balance', async () => {
    const wallet = await insertWallet(orm, { balance: '0.00' });

    await assertReconciled(orm, [wallet.id]);
  });

  test('fails when the balance was changed behind the ledger', async () => {
    const { wallet, transactionId } = await walletWithTransaction();
    await insertLedgerEntry(orm, { walletId: wallet.id, transactionId, direction: 'DEBIT', amount: '10.00', balanceBefore: '100.00', balanceAfter: '90.00', walletVersion: 2 });

    await expect(assertReconciled(orm, [wallet.id])).rejects.toThrow(/Reconciliation failed/);
  });

  test('fails for an unknown wallet', async () => {
    await expect(assertReconciled(orm, [uuid()])).rejects.toThrow(/not found/);
  });
});
