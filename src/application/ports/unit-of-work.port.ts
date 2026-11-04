import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { Money } from '../../domain/money/money';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export interface WalletRepository {
  /** Plain read, no lock. For queries; never use it to decide a balance change. */
  findById(id: string): Promise<Wallet | null>;
  /** `SELECT … FOR UPDATE`: serializes every balance change of this wallet. `null` if it does not exist. */
  lockById(id: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  /** `UPDATE … WHERE id = :id AND version = :expectedVersion`; throws an optimistic-lock error on 0 rows. */
  save(wallet: Wallet, expectedVersion: number): Promise<void>;
}

export interface TransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  /** Also resolves a reference: `(providerId, referenceExternalTransactionId)`. */
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** A PROCESSED REFUND or ROLLBACK already points at this transaction. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insert(transaction: WagerTransaction): Promise<void>;
  save(transaction: WagerTransaction): Promise<void>;
  /** PENDING_REFERENCE transactions whose retry time has come, oldest first. Reads only: nothing is locked. */
  findDuePending(now: Date, limit: number): Promise<{ readonly id: string; readonly walletId: string; readonly kind: string }[]>;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Newest first (`wallet_version` descending). `beforeVersion` is exclusive. */
  listByWallet(walletId: string, options: { readonly beforeVersion?: number; readonly limit: number }): Promise<WalletLedgerEntry[]>;
  /**
   * The stored balance and the balance rebuilt from the ledger (Σ CREDIT − Σ DEBIT), read in one statement so both
   * come from the same snapshot even while the wallet is being changed. `null` when the wallet does not exist.
   */
  reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null>;
}

export interface ReconciliationSnapshot {
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  readonly checkedEntries: number;
}

/** `recorded`: first time. `duplicate`: same message, same payload. `conflict`: same message id, different payload. */
export type InboxRecordResult = 'recorded' | 'duplicate' | 'conflict';

export interface InboxRepository {
  tryRecord(message: InboxMessage): Promise<InboxRecordResult>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /**
   * Claims up to `limit` pending messages that are due and not under a live lease, for `leaseMs`. Concurrent claimers
   * skip rows another one holds (`FOR UPDATE SKIP LOCKED`), so no two publishers get the same message. The claim only
   * writes `locked_until`; the caller commits it before any network call.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]>;
  /** Persists the publication result of a claimed message (published, or retry scheduled). */
  save(message: OutboxMessage): Promise<void>;
}

/** Everything that takes part in one SQL transaction. */
export interface TxRepositories {
  readonly wallets: WalletRepository;
  readonly transactions: TransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWork {
  /** Runs `work` in one SQL transaction: commits when it resolves, rolls everything back when it throws. */
  run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T>;
}

/** Thrown by `wallets.save` when the row no longer has the expected version (0 rows updated). */
export class OptimisticLockError extends Error {
  readonly code = 'OPTIMISTIC_LOCK';

  constructor(walletId: string, expectedVersion: number) {
    super(`Wallet ${walletId} is no longer at version ${expectedVersion}`);
    this.name = 'OptimisticLockError';
  }
}
