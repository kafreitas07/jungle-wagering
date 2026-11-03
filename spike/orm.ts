import { MikroORM, defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SpikeWalletSchema } from './spike-wallet.record';
import { Migration20261103000000SpikeWallets } from './migrations';

export const ormConfig = defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5440/wagering',
  entities: [SpikeWalletSchema],
  extensions: [Migrator],
  migrations: {
    migrationsList: [{ name: 'Migration20261103000000SpikeWallets', class: Migration20261103000000SpikeWallets }],
    transactional: true,
    snapshot: false, // migrations are hand-written SQL; no schema-diff snapshot needed
  },
  debug: false,
});

export const initOrm = () => MikroORM.init(ormConfig);
