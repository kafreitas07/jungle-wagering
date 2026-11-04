import { Money } from '../../../domain/money/money';
import {
  type FailureCode,
  type TransactionKind,
  type TransactionStatus,
  WagerTransaction,
} from '../../../domain/wager/wager-transaction';
import type { WagerTransactionRecord } from '../records/wager-transaction.record';

export function transactionToRecord(transaction: WagerTransaction): WagerTransactionRecord {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId,
    referenceTransactionId: transaction.referenceTransactionId,
    status: transaction.status,
    failureCode: transaction.failureCode,
    balanceAfter: transaction.balanceAfter?.toJSON().amount ?? null,
    referenceAttempts: transaction.referenceAttempts,
    nextAttemptAt: transaction.nextAttemptAt,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt,
    updatedAt: transaction.updatedAt,
  };
}

/** The columns a state change rewrites. Terminal rows are never updated (a trigger forbids it). */
export function transactionChanges(
  transaction: WagerTransaction,
): Pick<
  WagerTransactionRecord,
  | 'status'
  | 'failureCode'
  | 'balanceAfter'
  | 'referenceTransactionId'
  | 'referenceAttempts'
  | 'nextAttemptAt'
  | 'processedAt'
  | 'updatedAt'
> {
  const record = transactionToRecord(transaction);
  return {
    status: record.status,
    failureCode: record.failureCode,
    balanceAfter: record.balanceAfter,
    referenceTransactionId: record.referenceTransactionId,
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: record.nextAttemptAt,
    processedAt: record.processedAt,
    updatedAt: record.updatedAt,
  };
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  const money = (amount: string) => Money.from({ amount, currency: record.currency });
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as TransactionKind,
    money: money(record.amount),
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    createdAt: record.createdAt,
    status: record.status as TransactionStatus,
    failureCode: record.failureCode as FailureCode | null,
    balanceAfter: record.balanceAfter === null ? null : money(record.balanceAfter),
    referenceTransactionId: record.referenceTransactionId,
    referenceAttempts: record.referenceAttempts,
    nextAttemptAt: record.nextAttemptAt,
    processedAt: record.processedAt,
    updatedAt: record.updatedAt,
  });
}
