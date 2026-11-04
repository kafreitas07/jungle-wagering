import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { failure, insertTransaction, insertWallet, sql, uuid } from '../../support/sql';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

describe('wallets constraints (WAL-04, WAL-08, WAL-09)', () => {
  test('balance can never be negative (CHECK)', async () => {
    const error = await failure(
      orm,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', -0.01, 1, now(), now())`,
      [uuid(), uuid()],
    );

    expect(error.code).toBe('23514');
    expect(error.message).toContain('wallets_balance_non_negative');
  });

  test('an UPDATE that would make the balance negative is rejected by the database', async () => {
    const wallet = await insertWallet(orm, { balance: '10.00' });

    const error = await failure(orm, `update wallets set balance = balance - 10.01 where id = ?`, [wallet.id]);

    expect(error.message).toContain('wallets_balance_non_negative');
    expect((await sql(orm, 'select balance from wallets where id = ?', [wallet.id]))[0]?.balance).toBe('10.00');
  });

  test('one wallet per player and currency (UNIQUE)', async () => {
    const wallet = await insertWallet(orm);

    const error = await failure(
      orm,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, ?, 0, 1, now(), now())`,
      [uuid(), wallet.playerId, wallet.currency],
    );

    expect(error.code).toBe('23505');
    expect(error.message).toContain('wallets_player_currency_key');
  });

  test('the same player may hold wallets in different currencies', async () => {
    const wallet = await insertWallet(orm);

    await insertWallet(orm, { playerId: wallet.playerId, currency: 'USD' });
  });

  test('version starts at 1 (CHECK)', async () => {
    const error = await failure(
      orm,
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', 0, 0, now(), now())`,
      [uuid(), uuid()],
    );

    expect(error.message).toContain('wallets_version_positive');
  });
});

describe('wager_transactions constraints', () => {
  test('(provider, idempotency key) is unique (IDEM-02)', async () => {
    const wallet = await insertWallet(orm);
    const idempotencyKey = `key-${uuid()}`;
    await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, idempotencyKey });

    const duplicate = await failure(
      orm,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id, round_id,
          game_id, kind, amount, currency, status, balance_after, created_at, updated_at)
       values (?, 'provider-a', ?, ?, ?, ?, ?, 'r', 'g', 'BET', 1, 'BRL', 'PROCESSED', 1, now(), now())`,
      [uuid(), `ext-${uuid()}`, idempotencyKey, 'a'.repeat(64), wallet.id, wallet.playerId],
    );

    expect(duplicate.code).toBe('23505');
    expect(duplicate.message).toContain('wager_transactions_idempotency_key');
  });

  test('the same idempotency key is allowed for another provider', async () => {
    const wallet = await insertWallet(orm);
    const idempotencyKey = `key-${uuid()}`;
    await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, idempotencyKey, providerId: 'p1' });

    await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, idempotencyKey, providerId: 'p2' });
  });

  test('(provider, external transaction id) is unique (TXN-06)', async () => {
    const wallet = await insertWallet(orm);
    const externalTransactionId = `ext-${uuid()}`;
    await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId });

    await expect(
      insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId }),
    ).rejects.toThrow(/wager_transactions_external_id/);
  });

  test('a reference can be reversed only once among PROCESSED reversals (REV-08)', async () => {
    const wallet = await insertWallet(orm);
    const betExternalId = `bet-${uuid()}`;
    const bet = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternalId });
    const reversal = {
      walletId: wallet.id,
      playerId: wallet.playerId,
      referenceExternalTransactionId: betExternalId,
      referenceTransactionId: bet,
    };
    await insertTransaction(orm, { ...reversal, kind: 'REFUND' });

    await expect(insertTransaction(orm, { ...reversal, kind: 'ROLLBACK' })).rejects.toThrow(
      /wager_transactions_single_reversal/,
    );
  });

  test('a REJECTED reversal does not consume the reference', async () => {
    const wallet = await insertWallet(orm);
    const betExternalId = `bet-${uuid()}`;
    const bet = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: betExternalId });
    const reversal = {
      walletId: wallet.id,
      playerId: wallet.playerId,
      referenceExternalTransactionId: betExternalId,
      referenceTransactionId: bet,
      kind: 'REFUND',
    };
    await insertTransaction(orm, { ...reversal, status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS' });

    await insertTransaction(orm, { ...reversal, status: 'PROCESSED' });
  });

  test('REFUND and ROLLBACK require a reference (CHECK)', async () => {
    const wallet = await insertWallet(orm);

    for (const kind of ['REFUND', 'ROLLBACK']) {
      await expect(
        insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, kind }),
      ).rejects.toThrow(/wager_transactions_reference_required/);
    }
  });

  test('kind and status only accept the known values (CHECK)', async () => {
    const wallet = await insertWallet(orm);

    await expect(insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, kind: 'DEPOSIT' })).rejects.toThrow(
      /wager_transactions_kind_valid/,
    );
    await expect(
      insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, status: 'DONE' }),
    ).rejects.toThrow(/wager_transactions_status_valid/);
  });

  test('failure_code is present exactly when the status is REJECTED or FAILED (CHECK)', async () => {
    const wallet = await insertWallet(orm);
    const base = { walletId: wallet.id, playerId: wallet.playerId };

    await expect(insertTransaction(orm, { ...base, status: 'REJECTED' })).rejects.toThrow(/wager_transactions_failure_code_matches_status/);
    await expect(
      insertTransaction(orm, { ...base, status: 'PROCESSED', failureCode: 'INSUFFICIENT_FUNDS' }),
    ).rejects.toThrow(/wager_transactions_failure_code_matches_status/);
    await insertTransaction(orm, { ...base, status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    await insertTransaction(orm, { ...base, status: 'FAILED', failureCode: 'PROCESSING_FAILED' });
  });

  test('failure_code only accepts known codes (CHECK)', async () => {
    const wallet = await insertWallet(orm);

    await expect(
      insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, status: 'REJECTED', failureCode: 'BAD_LUCK' }),
    ).rejects.toThrow(/wager_transactions_failure_code_valid/);
  });

  test('amount must be positive except for LOSS (CHECK)', async () => {
    const wallet = await insertWallet(orm);
    const base = { walletId: wallet.id, playerId: wallet.playerId };

    for (const kind of ['BET', 'WIN']) {
      await expect(insertTransaction(orm, { ...base, kind, amount: '0.00' })).rejects.toThrow(
        /wager_transactions_amount_positive/,
      );
    }
    await insertTransaction(orm, { ...base, kind: 'LOSS', amount: '0.00' });
    await expect(insertTransaction(orm, { ...base, kind: 'LOSS', amount: '-1.00' })).rejects.toThrow(
      /wager_transactions_amount_positive|wager_transactions_amount_non_negative/,
    );
  });

  test('player and currency must match the wallet (composite FK, WAL-07)', async () => {
    const wallet = await insertWallet(orm);

    await expect(insertTransaction(orm, { walletId: wallet.id, playerId: uuid() })).rejects.toThrow(
      /wager_transactions_wallet_identity_fkey/,
    );
    await expect(insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, currency: 'USD' })).rejects.toThrow(
      /wager_transactions_wallet_identity_fkey/,
    );
  });
});

describe('terminal states are immutable (TXN-11)', () => {
  const terminal: [string, string | null][] = [
    ['PROCESSED', null],
    ['REJECTED', 'INSUFFICIENT_FUNDS'],
    ['FAILED', 'PROCESSING_FAILED'],
  ];

  test.each(terminal)('an UPDATE of a %s row fails', async (status, failureCode) => {
    const wallet = await insertWallet(orm);
    const id = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, status, failureCode });

    const error = await failure(orm, `update wager_transactions set balance_after = 1 where id = ?`, [id]);

    expect(error.message).toContain('terminal');
  });

  test('a PENDING_REFERENCE row can still move to a terminal status', async () => {
    const wallet = await insertWallet(orm);
    const id = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, status: 'PENDING_REFERENCE' });

    await sql(orm, `update wager_transactions set status = 'PROCESSED', balance_after = 90 where id = ?`, [id]);

    expect((await sql(orm, 'select status from wager_transactions where id = ?', [id]))[0]?.status).toBe('PROCESSED');
  });
});
