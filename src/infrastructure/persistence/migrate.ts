import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../config/env';
import { createOrmConfig } from './orm.config';

/** `bun run migrate`: applies pending migrations and exits. Exit code 1 on any failure. */
async function main(): Promise<void> {
  const { database } = loadEnv();
  const orm = await MikroORM.init(createOrmConfig(database));
  try {
    await orm.migrator.up();
    console.log('migrations applied');
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error('migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
