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
import { outboxMessageToDomain, outboxMessageToRecord } from './mappers/outbox-message.mapper';
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

  async findDuePending(now: Date, limit: number): Promise<{ id: string; walletId: string; kind: string }[]> {
    const rows = (await this.em.execute(
      `select id, wallet_id, kind from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= ?
        order by next_attempt_at, id
        limit ?`,
      [now, limit],
    )) as { id: string; wallet_id: string; kind: string }[];
    return rows.map((row) => ({ id: row.id, walletId: row.wallet_id, kind: row.kind }));
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

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<OutboxMessage[]> {
    const rows = (await this.em.execute(
      `with due as (
         select id from outbox_messages
          where published_at is null
            and next_attempt_at <= ?
            and (locked_until is null or locked_until <= ?)
          order by occurred_at, id
          limit ?
          for update skip locked
       )
       update outbox_messages o
          set locked_until = ?
         from due
        where o.id = due.id
        returning o.id, o.aggregate_id, o.group_key, o.event_type, o.payload, o.attempts, o.last_error,
                  to_char(o.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
                  to_char(o.next_attempt_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as next_attempt_at,
                  to_char(o.locked_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as locked_until,
                  to_char(o.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as published_at`,
      [now, now, limit, new Date(now.getTime() + leaseMs)],
    )) as {
      id: string;
      aggregate_id: string;
      group_key: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: string;
      attempts: number;
      next_attempt_at: string;
      locked_until: string | null;
      published_at: string | null;
      last_error: string | null;
    }[];
    return rows
      .map((row) =>
        outboxMessageToDomain({
          id: row.id,
          aggregateId: row.aggregate_id,
          groupKey: row.group_key,
          eventType: row.event_type,
          payload: row.payload,
          occurredAt: new Date(row.occurred_at),
          attempts: row.attempts,
          nextAttemptAt: new Date(row.next_attempt_at),
          lockedUntil: row.locked_until === null ? null : new Date(row.locked_until),
          publishedAt: row.published_at === null ? null : new Date(row.published_at),
          lastError: row.last_error,
        }),
      )
      .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  }

  async save(message: OutboxMessage): Promise<void> {
    const { attempts, nextAttemptAt, lockedUntil, publishedAt, lastError } = outboxMessageToRecord(message);
    await this.em.nativeUpdate(OutboxMessageSchema, { id: message.id }, { attempts, nextAttemptAt, lockedUntil, publishedAt, lastError });
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
