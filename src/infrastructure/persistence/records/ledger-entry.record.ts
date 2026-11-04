import { EntitySchema } from '@mikro-orm/core';

export interface LedgerEntryRecord {
  id: string;
  walletId: string;
  currency: string;
  transactionId: string;
  direction: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  name: 'LedgerEntryRecord',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    currency: { type: 'string', length: 3 },
    transactionId: { type: 'uuid', fieldName: 'transaction_id' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' },
    balanceBefore: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string', fieldName: 'balance_before' },
    balanceAfter: { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string', fieldName: 'balance_after' },
    walletVersion: { type: 'integer', fieldName: 'wallet_version' },
    createdAt: { type: 'Date', fieldName: 'created_at' },
  },
});
