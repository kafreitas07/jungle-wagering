import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { sql } from '../../support/sql';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

const existingTables = async () =>
  (
    await sql(
      orm,
      `select table_name from information_schema.tables where table_schema = 'public' and table_name in (${TABLES.map(() => '?').join(',')}) order by table_name`,
      TABLES,
    )
  ).map((row) => row.table_name);

describe('migrations are reversible (DB-01)', () => {
  test('up → down → up leaves every table in place and nothing behind after down', async () => {
    expect(await existingTables()).toEqual([...TABLES].sort());

    await orm.migrator.down({ to: 0 });
    expect(await existingTables()).toEqual([]);
    const leftovers = await sql(
      orm,
      `select proname from pg_proc where proname in ('wager_transactions_guard_terminal','wallet_ledger_entries_forbid_change')`,
    );
    expect(leftovers).toEqual([]);

    await orm.migrator.up();
    expect(await existingTables()).toEqual([...TABLES].sort());
  });

  test('running up twice is a no-op', async () => {
    await orm.migrator.up();

    expect(await existingTables()).toEqual([...TABLES].sort());
  });
});
