import { type LedgerDirection, WalletLedgerEntry } from '../../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../../domain/money/money';
import type { LedgerEntryRecord } from '../records/ledger-entry.record';

export function ledgerEntryToRecord(entry: WalletLedgerEntry, currency: string): LedgerEntryRecord {
  return {
    id: entry.id,
    walletId: entry.walletId,
    currency,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.amount.toJSON().amount,
    balanceBefore: entry.balanceBefore.toJSON().amount,
    balanceAfter: entry.balanceAfter.toJSON().amount,
    walletVersion: entry.walletVersion,
    createdAt: entry.createdAt,
  };
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    amount: money(record.amount),
    balanceBefore: money(record.balanceBefore),
    balanceAfter: money(record.balanceAfter),
    walletVersion: record.walletVersion,
    createdAt: record.createdAt,
  });
}
