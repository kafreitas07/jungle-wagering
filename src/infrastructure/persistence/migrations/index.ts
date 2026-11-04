import type { MigrationObject } from '@mikro-orm/core';
import { Migration001Wallets } from './Migration001Wallets';
import { Migration002LedgerInboxOutbox } from './Migration002LedgerInboxOutbox';

/** Ordered registry of hand-written migrations. Order here is the order they run. */
export const migrationsList: MigrationObject[] = [
  { name: 'Migration001Wallets', class: Migration001Wallets },
  { name: 'Migration002LedgerInboxOutbox', class: Migration002LedgerInboxOutbox },
];
