import { describe, expect, test } from 'bun:test';
import { InvalidWagerTransactionError } from '../../../../src/domain/errors/domain-errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../../src/domain/messaging/integration-events';
import { Money } from '../../../../src/domain/money/money';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import {
  type ReferenceRetryPolicy,
  WagerTransaction,
} from '../../../../src/domain/wager/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');
const later = new Date('2026-11-03T12:00:07.000Z');
const policy: ReferenceRetryPolicy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };
const context = { correlationId: 'correlation-1', causationId: 'cause-1', at: later };

const wallet = () => Wallet.open({ playerId: 'player-1', initialBalance: brl('100.00'), openingTransactionId: 'o', at }).wallet;

const bet = (walletId: string, kind: 'BET' | 'ROLLBACK' = 'BET') =>
  WagerTransaction.create({
    providerId: 'provider-1',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'key-1',
    payloadHash: 'a'.repeat(64),
    walletId,
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('30.00'),
    ...(kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'ext-origin' } : {}),
    at,
  });

describe('WalletBalanceChanged (OUT-04, OUT-07)', () => {
  test('carries type, version and the entry as MoneyProps strings', () => {
    const w = wallet();
    const entry = w.debit(brl('30.00'), 'transaction-1', later);

    const event = WalletBalanceChanged.from(w, entry, context);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(w.id);
    expect(event.correlationId).toBe('correlation-1');
    expect(event.causationId).toBe('cause-1');
    expect(event.occurredAt).toEqual(later);
    expect(event.data).toEqual({
      walletId: w.id,
      transactionId: 'transaction-1',
      direction: 'DEBIT',
      money: { amount: '30.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('toJSON is the stable envelope: ISO date, version, string amounts, no Money instance', () => {
    const w = wallet();
    const event = WalletBalanceChanged.from(w, w.credit(brl('5.00'), 'transaction-1', later), context);

    const json = event.toJSON();

    expect(Object.keys(json).sort()).toEqual(
      ['aggregateId', 'causationId', 'correlationId', 'data', 'eventId', 'eventType', 'occurredAt', 'version'].sort(),
    );
    expect(json.eventId).toBe(event.eventId);
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.occurredAt).toBe('2026-11-03T12:00:07.000Z');
    expect(json.version).toBe(1);
    expect(JSON.parse(JSON.stringify(event))).toEqual(JSON.parse(JSON.stringify(json)));
    expect(typeof json.data.money.amount).toBe('string');
  });

  test('toJSON omits causationId when there is none', () => {
    const w = wallet();
    const entry = w.credit(brl('5.00'), 'transaction-1', later);

    const json = WalletBalanceChanged.from(w, entry, { correlationId: 'correlation-1', at: later }).toJSON();

    expect('causationId' in json).toBe(false);
  });

  test('each event gets its own eventId', () => {
    const w = wallet();
    const entry = w.credit(brl('5.00'), 'transaction-1', later);

    const first = WalletBalanceChanged.from(w, entry, context);
    const second = WalletBalanceChanged.from(w, entry, context);

    expect(first.eventId.length).toBeGreaterThan(0);
    expect(first.eventId).not.toBe(second.eventId);
  });

  test('data cannot be changed after creation', () => {
    const w = wallet();
    const event = WalletBalanceChanged.from(w, w.credit(brl('5.00'), 'transaction-1', later), context);

    expect(() => {
      (event.data as { walletVersion: number }).walletVersion = 99;
    }).toThrow();
    expect(event.data.walletVersion).toBe(2);
  });
});

describe('WagerTransactionProcessed (OUT-03)', () => {
  test('describes a PROCESSED transaction with its observed balance', () => {
    const w = wallet();
    const transaction = bet(w.id);
    transaction.markProcessed({ balanceAfter: brl('70.00'), at: later });

    const event = WagerTransactionProcessed.from(transaction, context);

    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(w.id);
    expect(event.data).toEqual({
      transactionId: transaction.id,
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      walletId: w.id,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
      balanceAfter: { amount: '70.00', currency: 'BRL' },
    });
  });

  test('refuses a transaction that is not PROCESSED, even one that carries a balance', () => {
    const rejected = bet('wallet-1');
    rejected.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: brl('100.00'), at: later });

    expect(() => WagerTransactionProcessed.from(bet('wallet-1'), context)).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransactionProcessed.from(rejected, context)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransactionRejected (OUT-05)', () => {
  test('carries the failure code of a REJECTED transaction', () => {
    const w = wallet();
    const transaction = bet(w.id);
    transaction.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: brl('100.00'), at: later });

    const event = WagerTransactionRejected.from(transaction, context);

    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(w.id);
    expect(event.data).toEqual({
      transactionId: transaction.id,
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      walletId: w.id,
      kind: 'BET',
      money: { amount: '30.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  test('refuses a transaction that is not REJECTED, even one that carries a failure code', () => {
    const failed = bet('wallet-1');
    failed.fail({ at: later });

    expect(() => WagerTransactionRejected.from(bet('wallet-1'), context)).toThrow(InvalidWagerTransactionError);
    expect(() => WagerTransactionRejected.from(failed, context)).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransactionPendingReference (OUT-06)', () => {
  test('names the reference the transaction is waiting for', () => {
    const w = wallet();
    const transaction = bet(w.id, 'ROLLBACK');
    transaction.markPendingReference({ balanceAfter: brl('100.00'), at: later, policy });

    const event = WagerTransactionPendingReference.from(transaction, context);

    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.version).toBe(1);
    expect(event.aggregateId).toBe(w.id);
    expect(event.data).toEqual({
      transactionId: transaction.id,
      providerId: 'provider-1',
      externalTransactionId: 'ext-1',
      walletId: w.id,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: 'ext-origin',
    });
  });

  test('refuses a transaction that is not PENDING_REFERENCE', () => {
    expect(() => WagerTransactionPendingReference.from(bet('wallet-1', 'ROLLBACK'), context)).toThrow(
      InvalidWagerTransactionError,
    );
  });
});
