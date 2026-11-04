import { InboxMessageSchema } from './inbox-message.record';
import { LedgerEntrySchema } from './ledger-entry.record';
import { OutboxMessageSchema } from './outbox-message.record';
import { WagerTransactionSchema } from './wager-transaction.record';
import { WalletSchema } from './wallet.record';

/** Every schema the ORM maps. */
export const persistenceSchemas = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
