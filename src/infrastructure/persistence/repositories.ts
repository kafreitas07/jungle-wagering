import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  InboxRecordResult,
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  ReconciliationSnapshot,
  TransactionRepository,
  TxRepositories,
} from '../../application/ports';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { Money } from '../../domain/money/money';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import { inboxMessageToRecord } from './mappers/inbox-message.mapper';
import { ledgerEntryToDomain, ledgerEntryToRecord } from './mappers/ledger-entry.mapper';
import { outboxMessageToRecord } from './mappers/outbox-message.mapper';
import { transactionChanges, transactionToDomain, transactionToRecord } from './mappers/wager-transaction.mapper';
import { LedgerEntrySchema } from './records/ledger-entry.record';
import { OutboxMessageSchema } from './records/outbox-message.record';
import { WagerTransactionSchema } from './records/wager-transaction.record';
import { WalletRepositoryImpl } from './wallet-repository';

class TransactionRepositoryImpl implements TransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { id }));
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { providerId, idempotencyKey }));
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.toDomain(await this.em.findOne(WagerTransactionSchema, { providerId, externalTransactionId }));
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute(
      `select 1 from wager_transactions
        where reference_transaction_id = ? and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'
        limit 1`,
      [referenceTransactionId],
    );
    return rows.length > 0;
  }

  async insert(transaction: WagerTransaction): Promise<void> {
    await this.em.insert(WagerTransactionSchema, transactionToRecord(transaction));
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(WagerTransactionSchema, { id: transaction.id }, transactionChanges(transaction));
  }

  private toDomain(record: Parameters<typeof transactionToDomain>[0] | null): WagerTransaction | null {
    return record === null ? null : transactionToDomain(record);
  }
}

class LedgerRepositoryImpl implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry, entry.amount.currency));
  }

  async listByWallet(
    walletId: string,
    options: { readonly beforeVersion?: number; readonly limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntrySchema,
      options.beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: options.beforeVersion } },
      { orderBy: { walletVersion: 'desc' }, limit: options.limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  async reconciliationSnapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    const rows = (await this.em.getConnection().execute(
      `select w.balance::text as stored,
              w.currency as currency,
              coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::text as calculated,
              count(l.id)::int as entries
         from wallets w
         left join wallet_ledger_entries l on l.wallet_id = w.id
        where w.id = ?
        group by w.id, w.balance, w.currency`,
      [walletId],
    )) as { stored: string; currency: string; calculated: string; entries: number }[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      storedBalance: Money.from({ amount: row.stored, currency: row.currency }),
      calculatedBalance: Money.from({ amount: row.calculated, currency: row.currency }),
      checkedEntries: row.entries,
    };
  }
}

class InboxRepositoryImpl implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  /**
   * `ON CONFLICT DO NOTHING` makes a concurrent delivery wait for the first one to commit, then see its row.
   * Same hash → the message was already handled; different hash → the producer reused a message id.
   */
  async tryRecord(message: InboxMessage): Promise<InboxRecordResult> {
    const record = inboxMessageToRecord(message);
    const inserted = await this.em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
       values (?, ?, ?, ?, ?)
       on conflict (consumer_name, message_id) do nothing
       returning 1 as inserted`,
      [record.consumerName, record.messageId, record.payloadHash, record.receivedAt, record.processedAt],
    );
    if (inserted.length > 0) {
      return 'recorded';
    }
    const stored = await this.em.execute(`select payload_hash from inbox_messages where consumer_name = ? and message_id = ?`, [
      record.consumerName,
      record.messageId,
    ]);
    return stored[0]?.payload_hash === record.payloadHash ? 'duplicate' : 'conflict';
  }
}

class OutboxRepositoryImpl implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(OutboxMessageSchema, outboxMessageToRecord(message));
  }
}

export function createTxRepositories(em: EntityManager): TxRepositories {
  return {
    wallets: new WalletRepositoryImpl(em),
    transactions: new TransactionRepositoryImpl(em),
    ledger: new LedgerRepositoryImpl(em),
    inbox: new InboxRepositoryImpl(em),
    outbox: new OutboxRepositoryImpl(em),
  };
}
