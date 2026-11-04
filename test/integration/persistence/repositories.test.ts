import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { WalletBalanceChanged } from '../../../src/domain/messaging/integration-events';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { Money } from '../../../src/domain/money/money';
import { WagerTransaction } from '../../../src/domain/wager/wager-transaction';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/unit-of-work';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { insertTransaction, insertWallet, sql, uuid } from '../../support/sql';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  orm = await getTestOrm();
  uow = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 2000 });
});

afterAll(async () => {
  await closeTestOrm();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

interface Seed {
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  kind?: 'BET' | 'REFUND';
  reference?: string;
}

function build(wallet: { id: string; playerId: string }, seed: Seed = {}) {
  return WagerTransaction.create({
    providerId: seed.providerId ?? 'provider-a',
    externalTransactionId: seed.externalTransactionId ?? `ext-${uuid()}`,
    idempotencyKey: seed.idempotencyKey ?? `key-${uuid()}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: seed.kind ?? 'BET',
    money: brl('10.00'),
    ...(seed.reference === undefined ? {} : { referenceExternalTransactionId: seed.reference }),
    at,
  });
}

async function store(transaction: WagerTransaction): Promise<void> {
  await uow.run((tx) => tx.transactions.insert(transaction));
}

describe('transaction repository: lookups', () => {
  test('findByIdempotencyKey finds by (provider, key) and nothing else', async () => {
    const wallet = await insertWallet(orm);
    const transaction = build(wallet, { idempotencyKey: 'key-find', providerId: 'provider-find' });
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });
    await store(transaction);

    const found = await uow.run((tx) => tx.transactions.findByIdempotencyKey('provider-find', 'key-find'));
    const otherProvider = await uow.run((tx) => tx.transactions.findByIdempotencyKey('someone-else', 'key-find'));
    const otherKey = await uow.run((tx) => tx.transactions.findByIdempotencyKey('provider-find', 'nope'));

    expect(found?.id).toBe(transaction.id);
    expect(found?.status).toBe('PROCESSED');
    expect(found?.balanceAfter?.toString()).toBe('90.00');
    expect(otherProvider).toBeNull();
    expect(otherKey).toBeNull();
  });

  test('findByExternalId finds by (provider, external id); it is also how a reference is resolved', async () => {
    const wallet = await insertWallet(orm);
    const transaction = build(wallet, { externalTransactionId: 'ext-find', providerId: 'provider-ext' });
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });
    await store(transaction);

    expect((await uow.run((tx) => tx.transactions.findByExternalId('provider-ext', 'ext-find')))?.id).toBe(transaction.id);
    expect(await uow.run((tx) => tx.transactions.findByExternalId('other', 'ext-find'))).toBeNull();
    expect(await uow.run((tx) => tx.transactions.findByExternalId('provider-ext', 'missing'))).toBeNull();
  });

  test('findById returns the transaction or null', async () => {
    const wallet = await insertWallet(orm);
    const transaction = build(wallet);
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });
    await store(transaction);

    expect((await uow.run((tx) => tx.transactions.findById(transaction.id)))?.id).toBe(transaction.id);
    expect(await uow.run((tx) => tx.transactions.findById(uuid()))).toBeNull();
  });

  test('hasProcessedReversal is true only for a PROCESSED REFUND/ROLLBACK of that reference', async () => {
    const wallet = await insertWallet(orm);
    const bet = build(wallet, { externalTransactionId: 'bet-rev' });
    bet.markProcessed({ balanceAfter: brl('90.00'), at });
    await store(bet);
    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet.id))).toBe(false);

    const rejected = build(wallet, { kind: 'REFUND', reference: 'bet-rev' });
    rejected.reject({ failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balanceAfter: brl('90.00'), at });
    await store(rejected);
    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet.id))).toBe(false);

    const refund = build(wallet, { kind: 'REFUND', reference: 'bet-rev' });
    refund.markProcessed({ balanceAfter: brl('100.00'), at, referenceTransactionId: bet.id });
    await store(refund);
    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet.id))).toBe(true);
  });
});

describe('hasProcessedReversal: only PROCESSED REFUND/ROLLBACK rows count', () => {
  async function betWithReversal(kind: string, status: string, failureCode: string | null) {
    const wallet = await insertWallet(orm);
    const bet = await insertTransaction(orm, { walletId: wallet.id, playerId: wallet.playerId, externalTransactionId: `bet-${uuid()}` });
    await insertTransaction(orm, {
      walletId: wallet.id,
      playerId: wallet.playerId,
      kind,
      status,
      failureCode,
      referenceExternalTransactionId: 'whatever',
      referenceTransactionId: bet,
    });
    return bet;
  }

  test('a ROLLBACK that was PROCESSED counts', async () => {
    const bet = await betWithReversal('ROLLBACK', 'PROCESSED', null);

    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet))).toBe(true);
  });

  test.each([
    ['REFUND', 'REJECTED', 'REVERSAL_INSUFFICIENT_FUNDS'],
    ['ROLLBACK', 'REJECTED', 'REVERSAL_INSUFFICIENT_FUNDS'],
    ['REFUND', 'FAILED', 'PROCESSING_FAILED'],
  ])('a %s in status %s does not count', async (kind, status, failureCode) => {
    const bet = await betWithReversal(kind, status, failureCode);

    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet))).toBe(false);
  });

  test('a processed row of another kind that points at the bet does not count', async () => {
    const bet = await betWithReversal('WIN', 'PROCESSED', null);

    expect(await uow.run((tx) => tx.transactions.hasProcessedReversal(bet))).toBe(false);
  });
});

describe('transaction repository: writes', () => {
  test('save moves a PENDING_REFERENCE transaction to its final state', async () => {
    const wallet = await insertWallet(orm);
    const refund = build(wallet, { kind: 'REFUND', reference: 'bet-later' });
    refund.markPendingReference({ balanceAfter: brl('100.00'), at, policy });
    await store(refund);

    await uow.run(async (tx) => {
      const pending = (await tx.transactions.findById(refund.id))!;
      pending.reject({ failureCode: 'REFERENCE_NOT_FOUND', balanceAfter: brl('100.00'), at: new Date(at.getTime() + 1000) });
      await tx.transactions.save(pending);
    });

    const stored = await uow.run((tx) => tx.transactions.findById(refund.id));
    expect(stored?.status).toBe('REJECTED');
    expect(stored?.failureCode).toBe('REFERENCE_NOT_FOUND');
  });

  test('a duplicated idempotency key is refused by the database with 23505', async () => {
    const wallet = await insertWallet(orm);
    await store(build(wallet, { idempotencyKey: 'dup-key', providerId: 'provider-dup' }));

    const error = await store(build(wallet, { idempotencyKey: 'dup-key', providerId: 'provider-dup' })).then(
      () => undefined,
      (e: unknown) => e as { code?: string; message: string },
    );

    expect(error?.code).toBe('23505');
    expect(error?.message).toContain('wager_transactions_idempotency_key');
  });
});

describe('inbox.tryRecord (SQS-02)', () => {
  const message = (messageId: string, payloadHash = 'a'.repeat(64), consumerName = 'wagering') =>
    InboxMessage.receive({ messageId, consumerName, payloadHash, at });

  test('first time → recorded; same message and hash → duplicate; same message, other hash → conflict', async () => {
    const id = `msg-${uuid()}`;

    expect(await uow.run((tx) => tx.inbox.tryRecord(message(id)))).toBe('recorded');
    expect(await uow.run((tx) => tx.inbox.tryRecord(message(id)))).toBe('duplicate');
    expect(await uow.run((tx) => tx.inbox.tryRecord(message(id, 'b'.repeat(64))))).toBe('conflict');
  });

  test('the same message id is new for another consumer', async () => {
    const id = `msg-${uuid()}`;
    await uow.run((tx) => tx.inbox.tryRecord(message(id)));

    expect(await uow.run((tx) => tx.inbox.tryRecord(message(id, 'a'.repeat(64), 'other-consumer')))).toBe('recorded');
  });

  test('a conflict leaves the original record untouched', async () => {
    const id = `msg-${uuid()}`;
    await uow.run((tx) => tx.inbox.tryRecord(message(id)));
    await uow.run((tx) => tx.inbox.tryRecord(message(id, 'b'.repeat(64))));

    const rows = await sql(orm, `select payload_hash from inbox_messages where message_id = ?`, [id]);
    expect(rows).toEqual([{ payload_hash: 'a'.repeat(64) }]);
  });

  test('concurrent deliveries of the same message record it exactly once', async () => {
    const id = `msg-${uuid()}`;

    const results = await Promise.all(Array.from({ length: 6 }, () => uow.run((tx) => tx.inbox.tryRecord(message(id)))));

    expect(results.filter((r) => r === 'recorded')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(5);
  });
});

describe('ledger and outbox repositories', () => {
  test('ledger.append stores the entry; a second entry for the same transaction is refused', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });
    const transaction = build(wallet);
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });

    await uow.run(async (tx) => {
      await tx.transactions.insert(transaction);
      const locked = (await tx.wallets.lockById(wallet.id))!;
      const entry = locked.debit(brl('10.00'), transaction.id, at);
      await tx.wallets.save(locked, 1);
      await tx.ledger.append(entry);
    });

    expect(await sql(orm, 'select direction, amount::text as amount from wallet_ledger_entries where wallet_id = ?', [wallet.id])).toEqual([
      { direction: 'DEBIT', amount: '10.00' },
    ]);
  });

  test('outbox.enqueue stores the envelope as jsonb', async () => {
    const wallet = await insertWallet(orm);
    const domainWallet = await uow.run((tx) => tx.wallets.lockById(wallet.id));
    const entry = domainWallet!.credit(brl('1.00'), uuid(), at);
    const outbox = OutboxMessage.enqueue(WalletBalanceChanged.from(domainWallet!, entry, { correlationId: 'c-1', at }));

    await uow.run((tx) => tx.outbox.enqueue(outbox));

    const row = (await sql(orm, 'select event_type, group_key, payload from outbox_messages where id = ?', [outbox.id]))[0];
    expect(row?.event_type).toBe('WalletBalanceChanged');
    expect(row?.group_key).toBe(wallet.id);
    expect(row?.payload).toEqual(outbox.toState().payload);
  });
});

describe('atomicity: wallet + transaction + ledger + inbox + outbox (OUT-01, LEDG-01)', () => {
  test('a failure after ledger.append persists nothing in any table', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });
    const transaction = build(wallet, { idempotencyKey: 'atomic-key', providerId: 'provider-atomic' });
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });
    const messageId = `msg-${uuid()}`;
    let eventId = '';

    const attempt = uow.run(async (tx) => {
      await tx.inbox.tryRecord(InboxMessage.receive({ messageId, consumerName: 'wagering', payloadHash: 'a'.repeat(64), at }));
      const locked = (await tx.wallets.lockById(wallet.id))!;
      await tx.transactions.insert(transaction);
      const entry = locked.debit(brl('10.00'), transaction.id, at);
      await tx.wallets.save(locked, 1);
      await tx.ledger.append(entry);
      const outbox = OutboxMessage.enqueue(WalletBalanceChanged.from(locked, entry, { correlationId: 'c', at }));
      eventId = outbox.id;
      await tx.outbox.enqueue(outbox);
      throw new Error('crash after the ledger append');
    });

    await expect(attempt).rejects.toThrow('crash after the ledger append');
    expect(await sql(orm, 'select balance::text as b, version from wallets where id = ?', [wallet.id])).toEqual([{ b: '100.00', version: 1 }]);
    expect(await sql(orm, 'select 1 from wager_transactions where id = ?', [transaction.id])).toHaveLength(0);
    expect(await sql(orm, 'select 1 from wallet_ledger_entries where wallet_id = ?', [wallet.id])).toHaveLength(0);
    expect(await sql(orm, 'select 1 from inbox_messages where message_id = ?', [messageId])).toHaveLength(0);
    expect(await sql(orm, 'select 1 from outbox_messages where id = ?', [eventId])).toHaveLength(0);
  });

  test('without the failure everything is committed together and reconciles', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });
    const transaction = build(wallet);
    transaction.markProcessed({ balanceAfter: brl('90.00'), at });

    await uow.run(async (tx) => {
      const locked = (await tx.wallets.lockById(wallet.id))!;
      await tx.transactions.insert(transaction);
      const entry = locked.debit(brl('10.00'), transaction.id, at);
      await tx.wallets.save(locked, 1);
      await tx.ledger.append(entry);
      await tx.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(locked, entry, { correlationId: 'c', at })));
    });

    expect(await sql(orm, 'select balance::text as b, version from wallets where id = ?', [wallet.id])).toEqual([{ b: '90.00', version: 2 }]);
    expect(await sql(orm, 'select 1 from outbox_messages where aggregate_id = ?', [wallet.id])).toHaveLength(1);
  });
});
