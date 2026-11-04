import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export const walletView = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const ledgerEntryView = (entry: WalletLedgerEntry) => ({
  id: entry.id,
  transactionId: entry.transactionId,
  direction: entry.direction,
  amount: entry.amount.toJSON(),
  balanceBefore: entry.balanceBefore.toJSON(),
  balanceAfter: entry.balanceAfter.toJSON(),
  walletVersion: entry.walletVersion,
  createdAt: entry.createdAt.toISOString(),
});

export const transactionView = (transaction: WagerTransaction) => ({
  transactionId: transaction.id,
  providerId: transaction.providerId,
  externalTransactionId: transaction.externalTransactionId,
  walletId: transaction.walletId,
  playerId: transaction.playerId,
  roundId: transaction.roundId,
  gameId: transaction.gameId,
  kind: transaction.kind,
  money: transaction.money.toJSON(),
  status: transaction.status,
  failureCode: transaction.failureCode,
  referenceExternalTransactionId: transaction.referenceExternalTransactionId,
  referenceTransactionId: transaction.referenceTransactionId,
  balance: transaction.balanceAfter?.toJSON() ?? null,
  createdAt: transaction.createdAt.toISOString(),
  processedAt: transaction.processedAt?.toISOString() ?? null,
});

/** The response of a submission, derived only from the persisted state (so a replay answers like the original). */
export function submissionStatus(status: WagerTransaction['status']): number {
  switch (status) {
    case 'PROCESSED':
      return 201;
    case 'PENDING_REFERENCE':
    case 'PENDING':
      return 202;
    case 'REJECTED':
      return 422;
    case 'FAILED':
      return 500;
  }
}
