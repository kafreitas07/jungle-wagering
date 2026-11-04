import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { migrationsList } from './migrations';
import { persistenceSchemas } from './records';

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly lockTimeoutMs: number;
}

export function createOrmConfig(database: DatabaseConfig, entities: Options['entities'] = persistenceSchemas): Options {
  return defineConfig({
    clientUrl: database.url,
    entities,
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    pool: { min: 0, max: database.poolMax },
    migrations: {
      migrationsList,
      transactional: true,
      snapshot: false, // migrations are hand-written SQL; there is no schema-diff snapshot
    },
    debug: false,
  });
}
