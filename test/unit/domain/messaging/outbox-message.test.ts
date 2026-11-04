import { describe, expect, test } from 'bun:test';
import { WalletBalanceChanged } from '../../../../src/domain/messaging/integration-events';
import { OutboxMessage } from '../../../../src/domain/messaging/outbox-message';
import { Money } from '../../../../src/domain/money/money';
import { Wallet } from '../../../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');
const at1 = new Date('2026-11-03T12:00:10.000Z');

const event = () => {
  const wallet = Wallet.open({ playerId: 'player-1', initialBalance: brl('100.00'), openingTransactionId: 'o', at }).wallet;
  return WalletBalanceChanged.from(wallet, wallet.credit(brl('5.00'), 'transaction-1', at1), {
    correlationId: 'correlation-1',
    at: at1,
  });
};

describe('OutboxMessage.enqueue (OUT-01, OUT-02)', () => {
  test('stores the event envelope, keyed by eventId and grouped by wallet, due immediately', () => {
    const e = event();

    const message = OutboxMessage.enqueue(e);

    expect(message.id).toBe(e.eventId);
    expect(message.aggregateId).toBe(e.aggregateId);
    expect(message.groupKey).toBe(e.aggregateId);
    expect(message.eventType).toBe('WalletBalanceChanged');
    expect(message.payload).toEqual(e.toJSON() as never);
    expect(message.occurredAt).toEqual(at1);
    expect(message.attempts).toBe(0);
    expect(message.publishedAt).toBeNull();
    expect(message.lockedUntil).toBeNull();
    expect(message.lastError).toBeNull();
    expect(message.isPending()).toBe(true);
    expect(message.isDue(at1)).toBe(true);
  });
});

describe('OutboxMessage.markPublished', () => {
  test('stops being pending and due', () => {
    const message = OutboxMessage.enqueue(event());

    message.markPublished(at1);

    expect(message.publishedAt).toEqual(at1);
    expect(message.isPending()).toBe(false);
    expect(message.isDue(new Date(at1.getTime() + 3_600_000))).toBe(false);
  });
});

describe('OutboxMessage.scheduleRetry (OUT-10)', () => {
  test('backs off 1 s, 2 s, 4 s … capped at 60 s, counting attempts and never discarding', () => {
    const message = OutboxMessage.enqueue(event());
    const waits: number[] = [];

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      message.scheduleRetry(at, 'sqs unavailable');
      waits.push(message.nextAttemptAt.getTime() - at.getTime());
      expect(message.attempts).toBe(attempt);
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(message.isPending()).toBe(true);
    expect(message.lastError).toBe('sqs unavailable');
  });

  test('is not due before nextAttemptAt and is due at it', () => {
    const message = OutboxMessage.enqueue(event());

    message.scheduleRetry(at, 'boom');

    expect(message.isDue(new Date(at.getTime() + 999))).toBe(false);
    expect(message.isDue(new Date(at.getTime() + 1000))).toBe(true);
  });

  test('releases the lease so another publisher can take it after the backoff', () => {
    const message = OutboxMessage.rehydrate({
      ...OutboxMessage.enqueue(event()).toState(),
      lockedUntil: new Date(at.getTime() + 30_000),
    });

    message.scheduleRetry(at, 'boom');

    expect(message.lockedUntil).toBeNull();
  });
});

describe('OutboxMessage lease (OUT-08, OUT-09)', () => {
  const claimed = () =>
    OutboxMessage.rehydrate({
      ...OutboxMessage.enqueue(event()).toState(),
      nextAttemptAt: at,
      lockedUntil: new Date(at.getTime() + 30_000),
    });

  test('a message under a valid lease is not due, even past its nextAttemptAt', () => {
    expect(claimed().isDue(new Date(at.getTime() + 29_999))).toBe(false);
  });

  test('once the lease expires another instance may take the message', () => {
    expect(claimed().isDue(new Date(at.getTime() + 30_000))).toBe(true);
  });
});

describe('OutboxMessage.rehydrate', () => {
  test('restores the stored state', () => {
    const original = OutboxMessage.enqueue(event());
    original.scheduleRetry(at, 'boom');

    const restored = OutboxMessage.rehydrate(original.toState());

    expect(restored.toState()).toEqual(original.toState());
    expect(restored.attempts).toBe(1);
  });
});
