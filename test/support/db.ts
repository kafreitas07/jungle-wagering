import { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig, type DatabaseConfig } from '../../src/infrastructure/persistence/orm.config';

const DEFAULT_TEST_URL = 'postgres://wagering:wagering@localhost:5440/wagering_test';

/** Integration tests must never touch the development database. */
export function assertTestDatabase(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, '');
  if (name !== 'wagering_test') {
    throw new Error(`Refusing to run against database "${name}": integration tests require wagering_test`);
  }
}

export function testDatabaseConfig(): DatabaseConfig {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
  assertTestDatabase(url);
  return { url, poolMax: 10, lockTimeoutMs: 2000 };
}

let shared: MikroORM | undefined;
const closers: (() => Promise<void>)[] = [];

/** Registers something to shut down together with the shared ORM (e.g. an app started lazily by a helper). */
export function onTestOrmClose(close: () => Promise<void>): void {
  closers.push(close);
}
let schemaRecreated = false;

/**
 * One ORM per test file. The first call of a `bun test` process recreates the schema (down → up), so a run never
 * sees rows left by a previous one: the ledger is append-only, so tests cannot clean up after themselves.
 */
export async function getTestOrm(): Promise<MikroORM> {
  if (!shared) {
    const orm = await MikroORM.init(createOrmConfig(testDatabaseConfig()));
    if (!schemaRecreated) {
      await orm.migrator.down({ to: 0 });
      schemaRecreated = true;
    }
    await orm.migrator.up();
    shared = orm;
  }
  return shared;
}

export async function closeTestOrm(): Promise<void> {
  for (const close of closers.splice(0)) {
    await close();
  }
  if (shared) {
    await shared.close();
    shared = undefined;
  }
}
