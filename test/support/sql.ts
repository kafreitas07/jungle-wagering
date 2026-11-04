import type { MikroORM } from '@mikro-orm/postgresql';

export type Row = Record<string, unknown>;

export const uuid = (): string => Bun.randomUUIDv7();

export async function sql(orm: MikroORM, statement: string, params: unknown[] = []): Promise<Row[]> {
  return (await orm.em.getConnection().execute(statement, params)) as Row[];
}

/** Resolves with the Postgres error (message + SQLSTATE) of a statement expected to fail. */
export async function failure(
  orm: MikroORM,
  statement: string,
  params: unknown[] = [],
): Promise<{ message: string; code: string | undefined }> {
  try {
    await sql(orm, statement, params);
  } catch (error) {
    const e = error as { message?: string; code?: string };
    return { message: e.message ?? String(error), code: e.code };
  }
  throw new Error(`Statement was expected to fail but succeeded: ${statement}`);
}

export async function insertWallet(
  orm: MikroORM,
  overrides: { id?: string; playerId?: string; currency?: string; balance?: string; version?: number } = {},
): Promise<{ id: string; playerId: string; currency: string }> {
  const id = overrides.id ?? uuid();
  const playerId = overrides.playerId ?? uuid();
  const currency = overrides.currency ?? 'BRL';
  await sql(
    orm,
    `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, ?, ?, ?, now(), now())`,
    [id, playerId, currency, overrides.balance ?? '100.00', overrides.version ?? 1],
  );
  return { id, playerId, currency };
}

export interface TransactionRow {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  walletId: string;
  playerId: string;
  currency?: string;
  kind?: string;
  status?: string;
  amount?: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  failureCode?: string | null;
  balanceAfter?: string | null;
}

export async function insertTransaction(orm: MikroORM, row: TransactionRow): Promise<string> {
  const id = row.id ?? uuid();
  const status = row.status ?? 'PROCESSED';
  await sql(
    orm,
    `insert into wager_transactions
       (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
        round_id, game_id, kind, amount, currency, reference_external_transaction_id,
        reference_transaction_id, status, failure_code, balance_after, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'round-1', 'game-1', ?, ?, ?, ?, ?, ?, ?, ?, now(), now())`,
    [
      id,
      row.providerId ?? 'provider-a',
      row.externalTransactionId ?? `ext-${id}`,
      row.idempotencyKey ?? `key-${id}`,
      'a'.repeat(64),
      row.walletId,
      row.playerId,
      row.kind ?? 'BET',
      row.amount ?? '10.00',
      row.currency ?? 'BRL',
      row.referenceExternalTransactionId ?? null,
      row.referenceTransactionId ?? null,
      status,
      row.failureCode ?? null,
      row.balanceAfter ?? (status === 'PENDING_REFERENCE' || status === 'PENDING' ? null : '90.00'),
    ],
  );
  return id;
}

export interface LedgerRow {
  id?: string;
  walletId: string;
  currency?: string;
  transactionId: string;
  direction?: string;
  amount?: string;
  balanceBefore?: string;
  balanceAfter?: string;
  walletVersion?: number;
}

export async function insertLedgerEntry(orm: MikroORM, row: LedgerRow): Promise<string> {
  const id = row.id ?? uuid();
  await sql(
    orm,
    `insert into wallet_ledger_entries
       (id, wallet_id, currency, transaction_id, direction, amount, balance_before, balance_after, wallet_version, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
    [
      id,
      row.walletId,
      row.currency ?? 'BRL',
      row.transactionId,
      row.direction ?? 'DEBIT',
      row.amount ?? '10.00',
      row.balanceBefore ?? '100.00',
      row.balanceAfter ?? '90.00',
      row.walletVersion ?? 2,
    ],
  );
  return id;
}
