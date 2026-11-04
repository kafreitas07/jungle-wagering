import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { FakeClock, testUnitOfWork } from './context';
import { sql, uuid } from './sql';

/**
 * Other test files leave unpublished events in the shared database. A publisher claims every due row, so a test
 * that counts what reaches the queue first marks everything pending as published (rows are never deleted).
 */
export async function drainOutbox(orm: MikroORM): Promise<void> {
  await sql(orm, `update outbox_messages set published_at = now(), locked_until = null where published_at is null`);
}

/** The same for PENDING_REFERENCE rows left by other tests: push their retry time far into the future. */
export async function parkPendingTransactions(orm: MikroORM): Promise<void> {
  await sql(orm, `update wager_transactions set next_attempt_at = now() + interval '10 years' where status = 'PENDING_REFERENCE'`);
}

/** Opens `count` wallets; each leaves two events in the outbox (WagerTransactionProcessed and WalletBalanceChanged). */
export async function openWallets(orm: MikroORM, clock: FakeClock, count: number, balance = '100.00'): Promise<string[]> {
  const openWallet = new OpenWallet({ unitOfWork: testUnitOfWork(orm), clock });
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push((await openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' } })).id);
    clock.advance(1);
  }
  return ids;
}

export const pendingOutbox = async (orm: MikroORM, walletIds?: readonly string[]): Promise<number> => {
  const filter = walletIds === undefined ? '' : `and aggregate_id in (${walletIds.map(() => '?').join(', ')})`;
  return Number((await sql(orm, `select count(*)::int as n from outbox_messages where published_at is null ${filter}`, [...(walletIds ?? [])]))[0]?.n);
};
