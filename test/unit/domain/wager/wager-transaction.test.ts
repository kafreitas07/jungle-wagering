import { describe, expect, test } from 'bun:test';
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from '../../../../src/domain/errors/domain-errors';
import { Money } from '../../../../src/domain/money/money';
import {
  type ReferenceRetryPolicy,
  WagerTransaction,
} from '../../../../src/domain/wager/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const t0 = new Date('2026-11-03T12:00:00.000Z');
const t1 = new Date('2026-11-03T12:00:05.000Z');
const policy: ReferenceRetryPolicy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

const betProps = (overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) => ({
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  idempotencyKey: 'key-1',
  payloadHash: 'a'.repeat(64),
  walletId: 'wallet-1',
  playerId: 'player-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET' as const,
  money: brl('10.00'),
  at: t0,
  ...overrides,
});

const pending = () => WagerTransaction.create(betProps());
const pendingReference = () => {
  const transaction = WagerTransaction.create(
    betProps({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ext-original' }),
  );
  transaction.markPendingReference({ balanceAfter: brl('50.00'), at: t0, policy });
  return transaction;
};
const processed = () => {
  const transaction = pending();
  transaction.markProcessed({ balanceAfter: brl('40.00'), at: t1 });
  return transaction;
};
const rejected = () => {
  const transaction = pending();
  transaction.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: brl('5.00'), at: t1 });
  return transaction;
};
const failed = () => {
  const transaction = pendingReference();
  transaction.fail({ at: t1 });
  return transaction;
};

describe('WagerTransaction.create (TXN-11, TXN-12)', () => {
  test('starts PENDING with no outcome and the submitted business fields', () => {
    const transaction = pending();

    expect(transaction.status).toBe('PENDING');
    expect(transaction.failureCode).toBeNull();
    expect(transaction.balanceAfter).toBeNull();
    expect(transaction.referenceTransactionId).toBeNull();
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.nextAttemptAt).toBeNull();
    expect(transaction.processedAt).toBeNull();
    expect(transaction.providerId).toBe('provider-1');
    expect(transaction.externalTransactionId).toBe('ext-1');
    expect(transaction.idempotencyKey).toBe('key-1');
    expect(transaction.payloadHash).toBe('a'.repeat(64));
    expect(transaction.kind).toBe('BET');
    expect(transaction.money.toString()).toBe('10.00');
    expect(transaction.createdAt).toEqual(t0);
    expect(transaction.id.length).toBeGreaterThan(0);
  });

  test('keeps the external reference of a reversal', () => {
    const transaction = WagerTransaction.create(
      betProps({ kind: 'REFUND', referenceExternalTransactionId: 'ext-original' }),
    );

    expect(transaction.referenceExternalTransactionId).toBe('ext-original');
  });

  test('refuses to create an OPENING transaction', () => {
    expect(() => WagerTransaction.create(betProps({ kind: 'OPENING' as never }))).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test("refuses the reserved provider id 'internal'", () => {
    expect(() => WagerTransaction.create(betProps({ providerId: 'internal' }))).toThrow(
      InvalidWagerTransactionError,
    );
  });
});

describe('WagerTransaction.createOpening', () => {
  test('is the only way to build an OPENING: PROCESSED, internal provider, opening:{walletId} ids', () => {
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      money: brl('1000.00'),
      payloadHash: 'b'.repeat(64),
      at: t0,
    });

    expect(opening.id).toBe('opening-1');
    expect(opening.kind).toBe('OPENING');
    expect(opening.status).toBe('PROCESSED');
    expect(opening.providerId).toBe('internal');
    expect(opening.externalTransactionId).toBe('opening:wallet-1');
    expect(opening.idempotencyKey).toBe('opening:wallet-1');
    expect(opening.money.toString()).toBe('1000.00');
    expect(opening.balanceAfter?.toString()).toBe('1000.00');
    expect(opening.processedAt).toEqual(t0);
    expect(opening.failureCode).toBeNull();
  });
});

describe('allowed transitions (TXN-12)', () => {
  test('PENDING → PROCESSED records the balance, the time and the resolved reference', () => {
    const transaction = pending();

    transaction.markProcessed({ balanceAfter: brl('40.00'), at: t1, referenceTransactionId: 'reference-1' });

    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.balanceAfter?.toString()).toBe('40.00');
    expect(transaction.processedAt).toEqual(t1);
    expect(transaction.referenceTransactionId).toBe('reference-1');
    expect(transaction.failureCode).toBeNull();
    expect(transaction.updatedAt).toEqual(t1);
  });

  test('PENDING → REJECTED records the failure code and the observed balance', () => {
    const transaction = pending();

    transaction.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: brl('5.00'), at: t1 });

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(transaction.balanceAfter?.toString()).toBe('5.00');
  });

  test('PENDING → PENDING_REFERENCE starts with 0 attempts and the first retry after the base delay', () => {
    const transaction = WagerTransaction.create(
      betProps({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ext-original' }),
    );

    transaction.markPendingReference({ balanceAfter: brl('50.00'), at: t0, policy });

    expect(transaction.status).toBe('PENDING_REFERENCE');
    expect(transaction.referenceAttempts).toBe(0);
    expect(transaction.nextAttemptAt).toEqual(new Date(t0.getTime() + 1000));
    expect(transaction.balanceAfter?.toString()).toBe('50.00');
  });

  test('PENDING → FAILED records PROCESSING_FAILED', () => {
    const transaction = pending();

    transaction.fail({ at: t1 });

    expect(transaction.status).toBe('FAILED');
    expect(transaction.failureCode).toBe('PROCESSING_FAILED');
  });

  test('PENDING_REFERENCE → PROCESSED clears the schedule and records the reference', () => {
    const transaction = pendingReference();

    transaction.markProcessed({ balanceAfter: brl('60.00'), at: t1, referenceTransactionId: 'reference-1' });

    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.referenceTransactionId).toBe('reference-1');
    expect(transaction.nextAttemptAt).toBeNull();
  });

  test('PENDING_REFERENCE → REJECTED clears the schedule', () => {
    const transaction = pendingReference();

    transaction.reject({ failureCode: 'REFERENCE_NOT_FOUND', balanceAfter: brl('50.00'), at: t1 });

    expect(transaction.status).toBe('REJECTED');
    expect(transaction.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(transaction.nextAttemptAt).toBeNull();
  });

  test('PENDING_REFERENCE → FAILED clears the schedule', () => {
    const transaction = pendingReference();

    transaction.fail({ at: t1 });

    expect(transaction.status).toBe('FAILED');
    expect(transaction.nextAttemptAt).toBeNull();
  });
});

describe('forbidden transitions (TXN-11)', () => {
  const actions: Record<string, (transaction: WagerTransaction) => unknown> = {
    markProcessed: (t) => t.markProcessed({ balanceAfter: brl('1.00'), at: t1 }),
    markPendingReference: (t) => t.markPendingReference({ balanceAfter: brl('1.00'), at: t1, policy }),
    reject: (t) => t.reject({ failureCode: 'AMOUNT_MISMATCH', balanceAfter: brl('1.00'), at: t1 }),
    fail: (t) => t.fail({ at: t1 }),
    scheduleReferenceRetry: (t) => t.scheduleReferenceRetry(t1, policy),
  };

  describe.each([
    ['PROCESSED', processed],
    ['REJECTED', rejected],
    ['FAILED', failed],
  ] as const)('from %s', (status, build) => {
    test.each(Object.keys(actions))('%s throws InvalidTransactionStateError and changes nothing', (name) => {
      const transaction = build();
      const before = {
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: transaction.balanceAfter?.toString(),
        updatedAt: transaction.updatedAt,
      };

      expect(() => actions[name]?.(transaction)).toThrow(InvalidTransactionStateError);
      expect(transaction.status).toBe(status);
      expect({
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: transaction.balanceAfter?.toString(),
        updatedAt: transaction.updatedAt,
      }).toEqual(before);
    });
  });

  test('PENDING_REFERENCE cannot go back to PENDING_REFERENCE', () => {
    expect(() =>
      pendingReference().markPendingReference({ balanceAfter: brl('1.00'), at: t1, policy }),
    ).toThrow(InvalidTransactionStateError);
  });

  test('a PENDING transaction cannot schedule a reference retry', () => {
    expect(() => pending().scheduleReferenceRetry(t1, policy)).toThrow(InvalidTransactionStateError);
  });
});

describe('scheduleReferenceRetry backoff (PREF-02)', () => {
  test('waits 1 s, 2 s, 4 s … capped at 300 s and exhausts on the 10th attempt', () => {
    const transaction = WagerTransaction.create(
      betProps({ kind: 'ROLLBACK', referenceExternalTransactionId: 'ext-original' }),
    );
    transaction.markPendingReference({ balanceAfter: brl('50.00'), at: t0, policy });
    const waits = [transaction.nextAttemptAt!.getTime() - t0.getTime()];

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const decision = transaction.scheduleReferenceRetry(t0, policy);
      expect(decision.exhausted).toBe(false);
      waits.push(transaction.nextAttemptAt!.getTime() - t0.getTime());
      expect(transaction.referenceAttempts).toBe(attempt);
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000]);

    const last = transaction.scheduleReferenceRetry(t0, policy);
    expect(last.exhausted).toBe(true);
    expect(transaction.referenceAttempts).toBe(10);
    expect(transaction.status).toBe('PENDING_REFERENCE');
  });

  test('exhausts at the configured maxAttempts', () => {
    const short: ReferenceRetryPolicy = { ...policy, maxAttempts: 3 };
    const transaction = WagerTransaction.create(
      betProps({ kind: 'REFUND', referenceExternalTransactionId: 'ext-original' }),
    );
    transaction.markPendingReference({ balanceAfter: brl('50.00'), at: t0, policy: short });

    expect(transaction.scheduleReferenceRetry(t0, short).exhausted).toBe(false);
    expect(transaction.scheduleReferenceRetry(t0, short).exhausted).toBe(false);
    expect(transaction.scheduleReferenceRetry(t0, short).exhausted).toBe(true);
  });

  test('schedules from the time of the failed attempt, not from creation', () => {
    const transaction = pendingReference();

    transaction.scheduleReferenceRetry(t1, policy);

    expect(transaction.nextAttemptAt).toEqual(new Date(t1.getTime() + 2000));
  });
});

describe('WagerTransaction.rehydrate', () => {
  test('restores the stored state without revalidating it', () => {
    const transaction = WagerTransaction.rehydrate({
      id: 'transaction-1',
      providerId: 'internal',
      externalTransactionId: 'opening:wallet-1',
      idempotencyKey: 'opening:wallet-1',
      payloadHash: 'c'.repeat(64),
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'game-1',
      kind: 'BET',
      money: brl('10.00'),
      referenceExternalTransactionId: null,
      createdAt: t0,
      status: 'PROCESSED',
      failureCode: 'AMOUNT_MISMATCH', // incoherent on purpose: rehydrate trusts the database
      balanceAfter: brl('1.00'),
      referenceTransactionId: null,
      referenceAttempts: 99,
      nextAttemptAt: null,
      processedAt: t1,
      updatedAt: t1,
    });

    expect(transaction.id).toBe('transaction-1');
    expect(transaction.status).toBe('PROCESSED');
    expect(transaction.failureCode).toBe('AMOUNT_MISMATCH');
    expect(transaction.referenceAttempts).toBe(99);
  });

  test('a rehydrated terminal transaction still refuses transitions', () => {
    const stored = processed();
    const transaction = WagerTransaction.rehydrate({
      id: stored.id,
      providerId: stored.providerId,
      externalTransactionId: stored.externalTransactionId,
      idempotencyKey: stored.idempotencyKey,
      payloadHash: stored.payloadHash,
      walletId: stored.walletId,
      playerId: stored.playerId,
      roundId: stored.roundId,
      gameId: stored.gameId,
      kind: stored.kind,
      money: stored.money,
      referenceExternalTransactionId: stored.referenceExternalTransactionId,
      createdAt: stored.createdAt,
      status: stored.status,
      failureCode: stored.failureCode,
      balanceAfter: stored.balanceAfter,
      referenceTransactionId: stored.referenceTransactionId,
      referenceAttempts: stored.referenceAttempts,
      nextAttemptAt: stored.nextAttemptAt,
      processedAt: stored.processedAt,
      updatedAt: stored.updatedAt,
    });

    expect(() => transaction.fail({ at: t1 })).toThrow(InvalidTransactionStateError);
  });
});
