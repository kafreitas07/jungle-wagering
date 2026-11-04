import type { MikroORM } from '@mikro-orm/postgresql';
import { sql } from './sql';

/**
 * Final invariant of every test: wallet.balance == Σ CREDIT − Σ DEBIT of its ledger,
 * and the last entry's balance_after equals the balance. Computed by the database, in exact numeric.
 */
export async function assertReconciled(orm: MikroORM, walletIds: readonly string[]): Promise<void> {
  if (walletIds.length === 0) {
    throw new Error('assertReconciled needs at least one wallet id');
  }
  const placeholders = walletIds.map(() => '?').join(', ');
  const rows = await sql(
    orm,
    `select w.id,
            w.balance::text as balance,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as rebuilt,
            (select e.balance_after::text from wallet_ledger_entries e
              where e.wallet_id = w.id order by e.wallet_version desc limit 1) as last_balance_after,
            w.balance = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) as sum_matches
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id in (${placeholders})
      group by w.id, w.balance`,
    [...walletIds],
  );

  const missing = walletIds.filter((id) => !rows.some((row) => row.id === id));
  if (missing.length > 0) {
    throw new Error(`Reconciliation: wallets not found: ${missing.join(', ')}`);
  }
  for (const row of rows) {
    if (!row.sum_matches) {
      throw new Error(`Reconciliation failed for ${String(row.id)}: balance ${String(row.balance)} but ledger rebuilds ${String(row.rebuilt)}`);
    }
    if (row.last_balance_after !== null && row.last_balance_after !== row.balance) {
      throw new Error(
        `Reconciliation failed for ${String(row.id)}: balance ${String(row.balance)} but last entry ends at ${String(row.last_balance_after)}`,
      );
    }
  }
}
