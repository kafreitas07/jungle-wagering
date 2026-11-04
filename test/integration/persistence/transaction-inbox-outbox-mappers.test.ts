import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { WalletBalanceChanged } from '../../../src/domain/messaging/integration-events';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { inboxMessageToDomain, inboxMessageToRecord } from '../../../src/infrastructure/persistence/mappers/inbox-message.mapper';
import { outboxMessageToDomain, outboxMessageToRecord } from '../../../src/infrastructure/persistence/mappers/outbox-message.mapper';
import {
  transactionChanges,
  transactionToDomain,
  transactionToRecord,
} from '../../../src/infrastructure/persistence/mappers/wager-transaction.mapper';
import { InboxMessageSchema } from '../../../src/infrastructure/persistence/records/inbox-message.record';
import { OutboxMessageSchema } from '../../../src/infrastructure/persistence/records/outbox-message.record';
import { WagerTransactionSchema } from '../../../src/infrastructure/persistence/records/wager-transaction.record';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { insertWallet, uuid } from '../../support/sql';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');
const later = new Date('2026-11-03T12:00:05.000Z');
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

async function newTransaction(overrides: { kind?: 'BET' | 'REFUND'; reference?: string; amount?: string } = {}) {
  const wallet = await insertWallet(orm);
  const transaction = WagerTransaction.create({
    providerId: 'provider-a',
    externalTransactionId: `ext-${uuid()}`,
    idempotencyKey: `key-${uuid()}`,
    payloadHash: 'c'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: overrides.kind ?? 'BET',
    money: brl(overrides.amount ?? '25.00'),
    ...(overrides.reference === undefined ? {} : { referenceExternalTransactionId: overrides.reference }),
    at,
  });
  return { wallet, transaction };
}

async function roundTrip(transaction: WagerTransaction): Promise<WagerTransaction> {
  const em = orm.em.fork();
  await em.insert(WagerTransactionSchema, transactionToRecord(transaction));
  return transactionToDomain(await em.fork().findOneOrFail(WagerTransactionSchema, { id: transaction.id }));
}

const snapshot = (t: WagerTransaction) => ({
  id: t.id,
  providerId: t.providerId,
  externalTransactionId: t.externalTransactionId,
  idempotencyKey: t.idempotencyKey,
  payloadHash: t.payloadHash,
  walletId: t.walletId,
  playerId: t.playerId,
  roundId: t.roundId,
  gameId: t.gameId,
  kind: t.kind,
  money: t.money.toJSON(),
  referenceExternalTransactionId: t.referenceExternalTransactionId,
  createdAt: t.createdAt,
  status: t.status,
  failureCode: t.failureCode,
  balanceAfter: t.balanceAfter?.toJSON() ?? null,
  referenceTransactionId: t.referenceTransactionId,
  referenceAttempts: t.referenceAttempts,
  nextAttemptAt: t.nextAttemptAt,
  processedAt: t.processedAt,
  updatedAt: t.updatedAt,
});

describe('wager transaction mapper (DB-03, DB-04)', () => {
  test('PROCESSED keeps balanceAfter and processedAt', async () => {
    const { transaction } = await newTransaction();
    transaction.markProcessed({ balanceAfter: brl('75.00'), at: later });

    const loaded = await roundTrip(transaction);

    expect(loaded.status).toBe('PROCESSED');
    expect(snapshot(loaded)).toEqual(snapshot(transaction));
  });

  test('REJECTED keeps failureCode and balanceAfter', async () => {
    const { transaction } = await newTransaction();
    transaction.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: brl('10.00'), at: later });

    const loaded = await roundTrip(transaction);

    expect(loaded.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(loaded.balanceAfter?.toString()).toBe('10.00');
    expect(snapshot(loaded)).toEqual(snapshot(transaction));
  });

  test('PENDING_REFERENCE keeps attempts and the next attempt time', async () => {
    const { transaction } = await newTransaction({ kind: 'REFUND', reference: 'bet-1' });
    transaction.markPendingReference({ balanceAfter: brl('100.00'), at: later, policy });

    const loaded = await roundTrip(transaction);

    expect(loaded.status).toBe('PENDING_REFERENCE');
    expect(loaded.nextAttemptAt).toEqual(transaction.nextAttemptAt);
    expect(loaded.nextAttemptAt).not.toBeNull();
    expect(loaded.referenceExternalTransactionId).toBe('bet-1');
    expect(snapshot(loaded)).toEqual(snapshot(transaction));
  });

  test('FAILED keeps PROCESSING_FAILED', async () => {
    const { transaction } = await newTransaction();
    transaction.fail({ at: later });

    const loaded = await roundTrip(transaction);

    expect(loaded.status).toBe('FAILED');
    expect(loaded.failureCode).toBe('PROCESSING_FAILED');
    expect(snapshot(loaded)).toEqual(snapshot(transaction));
  });

  test('a processed reversal keeps the link to the reference transaction', async () => {
    const original = await newTransaction();
    original.transaction.markProcessed({ balanceAfter: brl('75.00'), at: later });
    const em = orm.em.fork();
    await em.insert(WagerTransactionSchema, transactionToRecord(original.transaction));
    const refund = WagerTransaction.create({
      providerId: 'provider-a',
      externalTransactionId: `ext-${uuid()}`,
      idempotencyKey: `key-${uuid()}`,
      payloadHash: 'd'.repeat(64),
      walletId: original.wallet.id,
      playerId: original.wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'REFUND',
      money: brl('25.00'),
      referenceExternalTransactionId: original.transaction.externalTransactionId,
      at,
    });
    refund.markProcessed({ balanceAfter: brl('100.00'), at: later, referenceTransactionId: original.transaction.id });

    const loaded = await roundTrip(refund);

    expect(loaded.referenceTransactionId).toBe(original.transaction.id);
    expect(snapshot(loaded)).toEqual(snapshot(refund));
  });

  test('amounts are exact decimal strings in the record', async () => {
    const { transaction } = await newTransaction({ amount: '999999999999999999.99' });

    const record = transactionToRecord(transaction);

    expect(record.amount).toBe('999999999999999999.99');
    expect(typeof record.amount).toBe('string');
    expect(record.currency).toBe('BRL');
    expect((await roundTrip(transaction)).money.cents).toBe(transaction.money.cents);
  });
});

describe('transaction changes (what a state transition rewrites)', () => {
  test('a retry and then the final outcome of a pending reversal are written with every moving column', async () => {
    const original = await newTransaction();
    original.transaction.markProcessed({ balanceAfter: brl('75.00'), at: later });
    const em = orm.em.fork();
    await em.insert(WagerTransactionSchema, transactionToRecord(original.transaction));
    const refund = WagerTransaction.create({
      providerId: 'provider-a',
      externalTransactionId: `ext-${uuid()}`,
      idempotencyKey: `key-${uuid()}`,
      payloadHash: 'f'.repeat(64),
      walletId: original.wallet.id,
      playerId: original.wallet.playerId,
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'REFUND',
      money: brl('25.00'),
      referenceExternalTransactionId: original.transaction.externalTransactionId,
      at,
    });
    refund.markPendingReference({ balanceAfter: brl('75.00'), at: later, policy });
    await em.insert(WagerTransactionSchema, transactionToRecord(refund));

    refund.scheduleReferenceRetry(new Date(later.getTime() + 2000), policy);
    await em.nativeUpdate(WagerTransactionSchema, { id: refund.id }, transactionChanges(refund));
    const afterRetry = transactionToDomain(await em.fork().findOneOrFail(WagerTransactionSchema, { id: refund.id }));
    expect(afterRetry.referenceAttempts).toBe(refund.referenceAttempts);
    expect(afterRetry.referenceAttempts).toBeGreaterThan(0);
    expect(afterRetry.nextAttemptAt).toEqual(refund.nextAttemptAt);

    refund.markProcessed({ balanceAfter: brl('100.00'), at: new Date(later.getTime() + 9000), referenceTransactionId: original.transaction.id });
    await em.nativeUpdate(WagerTransactionSchema, { id: refund.id }, transactionChanges(refund));
    const done = transactionToDomain(await em.fork().findOneOrFail(WagerTransactionSchema, { id: refund.id }));
    expect(snapshot(done)).toEqual(snapshot(refund));
    expect(done.referenceTransactionId).toBe(original.transaction.id);
    expect(done.processedAt).not.toBeNull();
  });
});

describe('outbox message mapper', () => {
  function outboxMessage(): OutboxMessage {
    const wallet = Wallet.open({ playerId: uuid(), initialBalance: brl('100.00'), openingTransactionId: uuid(), at }).wallet;
    const entry = wallet.credit(brl('5.00'), uuid(), later);
    return OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, { correlationId: 'corr-1', at: later }));
  }

  test('the payload is jsonb and comes back identical, with the lease and retry state', async () => {
    const message = outboxMessage();
    message.scheduleRetry(later, 'sqs down');
    const em = orm.em.fork();
    await em.insert(OutboxMessageSchema, outboxMessageToRecord(message));

    const loaded = outboxMessageToDomain(await em.fork().findOneOrFail(OutboxMessageSchema, { id: message.id }));

    expect(loaded.toState()).toEqual(message.toState());
    expect(loaded.toState().payload).toEqual(message.toState().payload);
    expect(loaded.attempts).toBe(1);
    expect(loaded.toState().lastError).toBe('sqs down');
  });

  test('a claimed message keeps its lease', async () => {
    const claimed = OutboxMessage.rehydrate({ ...outboxMessage().toState(), lockedUntil: new Date(later.getTime() + 30_000) });
    const em = orm.em.fork();
    await em.insert(OutboxMessageSchema, outboxMessageToRecord(claimed));

    const loaded = outboxMessageToDomain(await em.fork().findOneOrFail(OutboxMessageSchema, { id: claimed.id }));

    expect(loaded.toState().lockedUntil).toEqual(new Date(later.getTime() + 30_000));
  });

  test('a published message keeps publishedAt', async () => {
    const message = outboxMessage();
    message.markPublished(later);
    const em = orm.em.fork();
    await em.insert(OutboxMessageSchema, outboxMessageToRecord(message));

    const loaded = outboxMessageToDomain(await em.fork().findOneOrFail(OutboxMessageSchema, { id: message.id }));

    expect(loaded.publishedAt).toEqual(later);
    expect(loaded.isPending()).toBe(false);
  });
});

describe('inbox message mapper', () => {
  test('round-trips the composite key, hash and processing time', async () => {
    const message = InboxMessage.receive({ messageId: `msg-${uuid()}`, consumerName: 'wagering', payloadHash: 'e'.repeat(64), at });
    message.markProcessed(later);
    const em = orm.em.fork();
    await em.insert(InboxMessageSchema, inboxMessageToRecord(message));

    const loaded = inboxMessageToDomain(
      await em.fork().findOneOrFail(InboxMessageSchema, { consumerName: 'wagering', messageId: message.messageId }),
    );

    expect(loaded.messageId).toBe(message.messageId);
    expect(loaded.consumerName).toBe('wagering');
    expect(loaded.payloadHash).toBe('e'.repeat(64));
    expect(loaded.receivedAt).toEqual(at);
    expect(loaded.processedAt).toEqual(later);
  });
});
