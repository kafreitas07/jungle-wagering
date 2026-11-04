import { describe, expect, test } from 'bun:test';
import { InvalidWagerTransactionError } from '../../../../src/domain/errors/domain-errors';
import { Money } from '../../../../src/domain/money/money';
import { Wallet } from '../../../../src/domain/wallet/wallet';
import { type Outcome, WagerRules } from '../../../../src/domain/wager/wager-rules';
import {
  type ReferenceRetryPolicy,
  type TransactionStatus,
  WagerTransaction,
  type WagerKind,
} from '../../../../src/domain/wager/wager-transaction';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const at = new Date('2026-11-03T12:00:00.000Z');
const policy: ReferenceRetryPolicy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const walletWith = (balance: string) =>
  Wallet.open({ playerId: 'player-1', initialBalance: brl(balance), openingTransactionId: 'opening', at }).wallet;

const submitted = (
  wallet: Wallet,
  kind: WagerKind,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) => {
  const externalTransactionId = nextId(`ext-${kind.toLowerCase()}`);
  return WagerTransaction.create({
    providerId: 'provider-1',
    externalTransactionId,
    idempotencyKey: `key-${externalTransactionId}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind,
    money: brl('10.00'),
    at,
    ...overrides,
  });
};

/** A transaction already settled as PROCESSED, usable as a reference. */
const processedReference = (
  wallet: Wallet,
  kind: WagerKind,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) => {
  const reference = submitted(wallet, kind, overrides);
  reference.markProcessed({ balanceAfter: wallet.balance, at });
  return reference;
};

const referencing = (
  wallet: Wallet,
  kind: WagerKind,
  reference: WagerTransaction,
  overrides: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) => submitted(wallet, kind, { referenceExternalTransactionId: reference.externalTransactionId, ...overrides });

const decide = (
  wallet: Wallet,
  transaction: WagerTransaction,
  options: { reference?: WagerTransaction; alreadyReversed?: boolean } = {},
): Outcome =>
  WagerRules.decide({
    wallet,
    transaction,
    reference: options.reference,
    alreadyReversed: options.alreadyReversed ?? false,
    at,
  });

const expectRejected = (outcome: Outcome, code: string) => {
  expect(outcome.type).toBe('REJECTED');
  if (outcome.type === 'REJECTED') {
    expect(outcome.code).toBe(code as never);
  }
};

const expectUntouched = (wallet: Wallet, balance: string, version = 1) => {
  expect(wallet.balance.toString()).toBe(balance);
  expect(wallet.version).toBe(version);
};

describe('BET (TXN-01, TXN-02)', () => {
  test('debits the wallet and returns the DEBIT entry', () => {
    const wallet = walletWith('100.00');
    const bet = submitted(wallet, 'BET', { money: brl('30.00') });

    const outcome = decide(wallet, bet);

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('DEBIT');
      expect(outcome.entry?.amount.toString()).toBe('30.00');
      expect(outcome.entry?.balanceBefore.toString()).toBe('100.00');
      expect(outcome.entry?.balanceAfter.toString()).toBe('70.00');
      expect(outcome.entry?.transactionId).toBe(bet.id);
      expect(outcome.entry?.createdAt).toEqual(at);
    }
    expectUntouched(wallet, '70.00', 2);
  });

  test('a bet equal to the whole balance is accepted and leaves exactly 0.00', () => {
    const wallet = walletWith('100.00');

    const outcome = decide(wallet, submitted(wallet, 'BET', { money: brl('100.00') }));

    expect(outcome.type).toBe('PROCESSED');
    expectUntouched(wallet, '0.00', 2);
  });

  test('one cent above the balance is rejected INSUFFICIENT_FUNDS and nothing changes', () => {
    const wallet = walletWith('100.00');

    const outcome = decide(wallet, submitted(wallet, 'BET', { money: brl('100.01') }));

    expectRejected(outcome, 'INSUFFICIENT_FUNDS');
    expectUntouched(wallet, '100.00');
  });
});

describe('WIN (TXN-03)', () => {
  test('credits the wallet and returns the CREDIT entry', () => {
    const wallet = walletWith('100.00');
    const win = submitted(wallet, 'WIN', { money: brl('45.50') });

    const outcome = decide(wallet, win);

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('CREDIT');
      expect(outcome.entry?.balanceAfter.toString()).toBe('145.50');
    }
    expectUntouched(wallet, '145.50', 2);
  });

  test('a WIN may reference the BET of the same round', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');

    const outcome = decide(wallet, referencing(wallet, 'WIN', bet), { reference: bet });

    expect(outcome.type).toBe('PROCESSED');
    expectUntouched(wallet, '110.00', 2);
  });

  test('several WINs may reference the same BET', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');

    const first = decide(wallet, referencing(wallet, 'WIN', bet), { reference: bet });
    const second = decide(wallet, referencing(wallet, 'WIN', bet), { reference: bet });

    expect(first.type).toBe('PROCESSED');
    expect(second.type).toBe('PROCESSED');
    expectUntouched(wallet, '120.00', 3);
  });
});

describe('LOSS (TXN-04)', () => {
  test('is processed without moving the balance, without an entry and without a version bump', () => {
    const wallet = walletWith('100.00');

    const outcome = decide(wallet, submitted(wallet, 'LOSS', { money: brl('10.00') }));

    expect(outcome).toEqual({ type: 'PROCESSED' });
    expectUntouched(wallet, '100.00');
  });

  test('a LOSS of 0.00 is a legitimate result', () => {
    const wallet = walletWith('100.00');

    const outcome = decide(wallet, submitted(wallet, 'LOSS', { money: brl('0.00') }));

    expect(outcome).toEqual({ type: 'PROCESSED' });
    expectUntouched(wallet, '100.00');
  });

  test('a LOSS may reference the BET of the same round', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');

    const outcome = decide(wallet, referencing(wallet, 'LOSS', bet), { reference: bet });

    expect(outcome).toEqual({ type: 'PROCESSED' });
    expectUntouched(wallet, '100.00');
  });
});

describe('WIN and LOSS with a reference use the same reference rules', () => {
  test('a reference that was not found yet leaves the WIN PENDING_REFERENCE', () => {
    const wallet = walletWith('100.00');
    const win = submitted(wallet, 'WIN', { referenceExternalTransactionId: 'ext-not-here-yet' });

    const outcome = decide(wallet, win);

    expect(outcome).toEqual({ type: 'PENDING_REFERENCE' });
    expectUntouched(wallet, '100.00');
  });

  test('a WIN that references another WIN is INVALID_REFERENCE_KIND', () => {
    const wallet = walletWith('100.00');
    const other = processedReference(wallet, 'WIN');

    expectRejected(decide(wallet, referencing(wallet, 'WIN', other), { reference: other }), 'INVALID_REFERENCE_KIND');
    expectUntouched(wallet, '100.00');
  });

  test('a LOSS that references a BET of another round is REFERENCE_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET', { roundId: 'round-2' });

    expectRejected(decide(wallet, referencing(wallet, 'LOSS', bet), { reference: bet }), 'REFERENCE_MISMATCH');
  });

  test('a WIN that references a REJECTED BET is REFERENCE_NOT_PROCESSED', () => {
    const wallet = walletWith('100.00');
    const bet = submitted(wallet, 'BET');
    bet.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: wallet.balance, at });

    expectRejected(decide(wallet, referencing(wallet, 'WIN', bet), { reference: bet }), 'REFERENCE_NOT_PROCESSED');
    expectUntouched(wallet, '100.00');
  });
});

describe('REFUND (REV-06, REV-03, REV-04)', () => {
  test('refunding a PROCESSED BET credits the wallet', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');
    wallet.debit(bet.money, bet.id, at);

    const outcome = decide(wallet, referencing(wallet, 'REFUND', bet), { reference: bet });

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('CREDIT');
      expect(outcome.entry?.amount.toString()).toBe('10.00');
    }
    expectUntouched(wallet, '100.00', 3);
  });

  test.each(['WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const)(
    'a REFUND that references a %s is INVALID_REFERENCE_KIND',
    (kind) => {
      const wallet = walletWith('100.00');
      const other = processedReference(
        wallet,
        kind,
        kind === 'REFUND' || kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'ext-origin' } : {},
      );

      expectRejected(decide(wallet, referencing(wallet, 'REFUND', other), { reference: other }), 'INVALID_REFERENCE_KIND');
      expectUntouched(wallet, '100.00');
    },
  );

  test('a REFUND of a different amount is AMOUNT_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET', { money: brl('10.00') });

    const outcome = decide(wallet, referencing(wallet, 'REFUND', bet, { money: brl('9.99') }), { reference: bet });

    expectRejected(outcome, 'AMOUNT_MISMATCH');
    expectUntouched(wallet, '100.00');
  });
});

describe('ROLLBACK (REV-07, REV-03, REV-04)', () => {
  test('rolling back a BET credits the wallet', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', bet), { reference: bet });

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('CREDIT');
    }
    expectUntouched(wallet, '110.00', 2);
  });

  test('rolling back a WIN debits the wallet', () => {
    const wallet = walletWith('100.00');
    const win = processedReference(wallet, 'WIN');

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', win), { reference: win });

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('DEBIT');
    }
    expectUntouched(wallet, '90.00', 2);
  });

  test('rolling back a REFUND debits the wallet', () => {
    const wallet = walletWith('100.00');
    const refund = processedReference(wallet, 'REFUND', { referenceExternalTransactionId: 'ext-origin' });

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', refund), { reference: refund });

    expect(outcome.type).toBe('PROCESSED');
    if (outcome.type === 'PROCESSED') {
      expect(outcome.entry?.direction).toBe('DEBIT');
    }
    expectUntouched(wallet, '90.00', 2);
  });

  test.each(['LOSS', 'ROLLBACK'] as const)('a ROLLBACK that references a %s is INVALID_REFERENCE_KIND', (kind) => {
    const wallet = walletWith('100.00');
    const other = processedReference(
      wallet,
      kind,
      kind === 'ROLLBACK' ? { referenceExternalTransactionId: 'ext-origin' } : {},
    );

    expectRejected(decide(wallet, referencing(wallet, 'ROLLBACK', other), { reference: other }), 'INVALID_REFERENCE_KIND');
    expectUntouched(wallet, '100.00');
  });

  test('a ROLLBACK of a different amount is AMOUNT_MISMATCH', () => {
    const wallet = walletWith('100.00');
    const win = processedReference(wallet, 'WIN', { money: brl('10.00') });

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', win, { money: brl('10.01') }), { reference: win });

    expectRejected(outcome, 'AMOUNT_MISMATCH');
    expectUntouched(wallet, '100.00');
  });
});

describe('reference identity (REV-02)', () => {
  test.each([
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-other' }],
    ['provider', { providerId: 'provider-2' }],
    ['round', { roundId: 'round-2' }],
    ['currency', { money: usd('10.00') }],
  ] as const)('a reference from another %s is REFERENCE_MISMATCH', (_dimension, difference) => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET', difference);

    const outcome = decide(wallet, referencing(wallet, 'REFUND', bet), { reference: bet });

    expectRejected(outcome, 'REFERENCE_MISMATCH');
    expectUntouched(wallet, '100.00');
  });
});

describe('reference state (REV-05, PREF-01)', () => {
  test.each(['REJECTED', 'FAILED'] as const)('a %s reference is REFERENCE_NOT_PROCESSED', (state) => {
    const wallet = walletWith('100.00');
    const bet = submitted(wallet, 'BET');
    if (state === 'REJECTED') {
      bet.reject({ failureCode: 'INSUFFICIENT_FUNDS', balanceAfter: wallet.balance, at });
    } else {
      bet.fail({ at });
    }

    const outcome = decide(wallet, referencing(wallet, 'REFUND', bet), { reference: bet });

    expectRejected(outcome, 'REFERENCE_NOT_PROCESSED');
    expectUntouched(wallet, '100.00');
  });

  test.each(['REFUND', 'ROLLBACK'] as const)('a %s whose reference does not exist yet is PENDING_REFERENCE', (kind) => {
    const wallet = walletWith('100.00');
    const dependent = submitted(wallet, kind, { referenceExternalTransactionId: 'ext-not-here-yet' });

    const outcome = decide(wallet, dependent);

    expect(outcome).toEqual({ type: 'PENDING_REFERENCE' });
    expectUntouched(wallet, '100.00');
  });

  test.each(['PENDING', 'PENDING_REFERENCE'] as const satisfies readonly TransactionStatus[])(
    'a reference still in %s is treated as absent: PENDING_REFERENCE',
    (state) => {
      const wallet = walletWith('100.00');
      const bet = submitted(wallet, 'BET');
      if (state === 'PENDING_REFERENCE') {
        bet.markPendingReference({ balanceAfter: wallet.balance, at, policy });
      }

      const outcome = decide(wallet, referencing(wallet, 'REFUND', bet), { reference: bet });

      expect(outcome).toEqual({ type: 'PENDING_REFERENCE' });
      expectUntouched(wallet, '100.00');
    },
  );
});

describe('single reversal (REV-08)', () => {
  test.each(['REFUND', 'ROLLBACK'] as const)(
    'a %s of a reference that already has a PROCESSED reversal is REFERENCE_ALREADY_REVERSED',
    (kind) => {
      const wallet = walletWith('100.00');
      const bet = processedReference(wallet, 'BET');

      const outcome = decide(wallet, referencing(wallet, kind, bet), { reference: bet, alreadyReversed: true });

      expectRejected(outcome, 'REFERENCE_ALREADY_REVERSED');
      expectUntouched(wallet, '100.00');
    },
  );

  test('the same BET cannot be reversed by both a REFUND and a ROLLBACK', () => {
    const wallet = walletWith('100.00');
    const bet = processedReference(wallet, 'BET');

    const refund = decide(wallet, referencing(wallet, 'REFUND', bet), { reference: bet });
    const rollback = decide(wallet, referencing(wallet, 'ROLLBACK', bet), { reference: bet, alreadyReversed: true });

    expect(refund.type).toBe('PROCESSED');
    expectRejected(rollback, 'REFERENCE_ALREADY_REVERSED');
    expectUntouched(wallet, '110.00', 2);
  });
});

describe('reversal without funds (REV-09)', () => {
  test('rolling back a WIN the player already spent is REVERSAL_INSUFFICIENT_FUNDS, not INSUFFICIENT_FUNDS', () => {
    const wallet = walletWith('5.00');
    const win = processedReference(wallet, 'WIN', { money: brl('10.00') });

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', win), { reference: win });

    expectRejected(outcome, 'REVERSAL_INSUFFICIENT_FUNDS');
    expect(outcome.type === 'REJECTED' && outcome.code).not.toBe('INSUFFICIENT_FUNDS');
    expectUntouched(wallet, '5.00');
  });

  test('rolling back a REFUND without funds is REVERSAL_INSUFFICIENT_FUNDS', () => {
    const wallet = walletWith('9.99');
    const refund = processedReference(wallet, 'REFUND', { referenceExternalTransactionId: 'ext-origin' });

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', refund), { reference: refund });

    expectRejected(outcome, 'REVERSAL_INSUFFICIENT_FUNDS');
    expectUntouched(wallet, '9.99');
  });

  test('a reversal that takes the balance to exactly 0.00 is accepted', () => {
    const wallet = walletWith('10.00');
    const win = processedReference(wallet, 'WIN', { money: brl('10.00') });

    const outcome = decide(wallet, referencing(wallet, 'ROLLBACK', win), { reference: win });

    expect(outcome.type).toBe('PROCESSED');
    expectUntouched(wallet, '0.00', 2);
  });
});

describe('self reference (REV-10)', () => {
  test('a REFUND that references its own external id is INVALID_REFERENCE_KIND even if nothing was resolved', () => {
    const wallet = walletWith('100.00');
    const refund = submitted(wallet, 'REFUND', {
      externalTransactionId: 'ext-self',
      referenceExternalTransactionId: 'ext-self',
    });

    expectRejected(decide(wallet, refund), 'INVALID_REFERENCE_KIND');
    expectUntouched(wallet, '100.00');
  });

  test('a PENDING_REFERENCE ROLLBACK that resolves to itself is INVALID_REFERENCE_KIND', () => {
    const wallet = walletWith('100.00');
    const rollback = submitted(wallet, 'ROLLBACK', {
      externalTransactionId: 'ext-self',
      referenceExternalTransactionId: 'ext-self',
    });
    rollback.markPendingReference({ balanceAfter: wallet.balance, at, policy });

    expectRejected(decide(wallet, rollback, { reference: rollback }), 'INVALID_REFERENCE_KIND');
    expectUntouched(wallet, '100.00');
  });
});

describe('decide leaves the transaction to the caller', () => {
  test('the transaction stays PENDING after a decision', () => {
    const wallet = walletWith('100.00');
    const bet = submitted(wallet, 'BET');

    decide(wallet, bet);

    expect(bet.status).toBe('PENDING');
  });

  test('an OPENING transaction is internal and never decided', () => {
    const wallet = walletWith('100.00');
    const opening = WagerTransaction.createOpening({
      id: 'opening-1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      money: brl('100.00'),
      payloadHash: 'b'.repeat(64),
      at,
    });

    expect(() => decide(wallet, opening)).toThrow(InvalidWagerTransactionError);
  });
});
