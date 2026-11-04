import { Money } from '../../../domain/money/money';
import { Wallet } from '../../../domain/wallet/wallet';
import type { WalletRecord } from '../records/wallet.record';

export function walletToRecord(wallet: Wallet): WalletRecord {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toJSON().amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

/** The columns a balance change rewrites. The row is found by `id` and the expected version. */
export function walletChanges(wallet: Wallet): Pick<WalletRecord, 'balance' | 'version' | 'updatedAt'> {
  return { balance: wallet.balance.toJSON().amount, version: wallet.version, updatedAt: wallet.updatedAt };
}

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}
