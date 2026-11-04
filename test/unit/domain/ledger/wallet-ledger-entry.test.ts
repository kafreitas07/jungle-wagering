import { describe, expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../../src/domain/errors/domain-errors';
import { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');

const entryProps = (overrides: Partial<Parameters<typeof WalletLedgerEntry.create>[0]> = {}) => ({
  walletId: 'wallet-1',
  transactionId: 'transaction-1',
  direction: 'CREDIT' as const,
  money: brl('25.00'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('125.00'),
  walletVersion: 2,
  at,
  ...overrides,
});

describe('WalletLedgerEntry.create — arithmetic (LEDG-02)', () => {
  test('accepts a coherent CREDIT and keeps every field', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('transaction-1');
    expect(entry.direction).toBe('CREDIT');
    expect(entry.amount.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.createdAt).toEqual(at);
    expect(entry.id.length).toBeGreaterThan(0);
  });

  test('accepts a coherent DEBIT', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({ direction: 'DEBIT', balanceAfter: brl('75.00') }),
    );

    expect(entry.direction).toBe('DEBIT');
    expect(entry.balanceAfter.toString()).toBe('75.00');
  });

  test('rejects a CREDIT whose balanceAfter is not before + money', () => {
    expect(() => WalletLedgerEntry.create(entryProps({ balanceAfter: brl('124.99') }))).toThrow(
      InvalidLedgerEntryError,
    );
  });

  test('rejects a DEBIT whose balanceAfter is not before - money', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ direction: 'DEBIT', balanceAfter: brl('75.01') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a DEBIT recorded with the arithmetic of a CREDIT', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ direction: 'DEBIT', balanceAfter: brl('125.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('accepts an opening credit from 0.00', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({ balanceBefore: brl('0.00'), money: brl('1000.00'), balanceAfter: brl('1000.00'), walletVersion: 1 }),
    );

    expect(entry.balanceBefore.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('1000.00');
  });
});

describe('WalletLedgerEntry.create — value rules (LEDG-04)', () => {
  test('rejects a zero amount', () => {
    expect(() =>
      WalletLedgerEntry.create(entryProps({ money: brl('0.00'), balanceAfter: brl('100.00') })),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balanceBefore even when the arithmetic holds', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ balanceBefore: brl('-1.00'), money: brl('2.00'), balanceAfter: brl('1.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('rejects a negative balanceAfter even when the arithmetic holds', () => {
    expect(() =>
      WalletLedgerEntry.create(
        entryProps({ direction: 'DEBIT', balanceBefore: brl('1.00'), money: brl('2.00'), balanceAfter: brl('-1.00') }),
      ),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('accepts a DEBIT that brings the balance to exactly 0.00', () => {
    const entry = WalletLedgerEntry.create(
      entryProps({ direction: 'DEBIT', balanceBefore: brl('25.00'), money: brl('25.00'), balanceAfter: brl('0.00') }),
    );

    expect(entry.balanceAfter.toString()).toBe('0.00');
  });
});

describe('WalletLedgerEntry immutability (LEDG-07)', () => {
  test('exposes no mutation: assignment fails to compile and the object is frozen', () => {
    const entry = WalletLedgerEntry.create(entryProps());

    // @ts-expect-error amount is readonly
    expect(() => (entry.amount = brl('1.00'))).toThrow();
    // @ts-expect-error balanceAfter is readonly
    expect(() => (entry.balanceAfter = brl('1.00'))).toThrow();
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.amount.toString()).toBe('25.00');
  });
});

describe('WalletLedgerEntry.rehydrate', () => {
  test('rebuilds the stored state without revalidating the arithmetic', () => {
    const stored = {
      id: 'entry-1',
      walletId: 'wallet-1',
      transactionId: 'transaction-1',
      direction: 'CREDIT' as const,
      amount: brl('5.00'),
      balanceBefore: brl('10.00'),
      balanceAfter: brl('99.00'), // incoherent on purpose: rehydrate trusts the database
      walletVersion: 3,
      createdAt: at,
    };

    const entry = WalletLedgerEntry.rehydrate(stored);

    expect(entry.id).toBe('entry-1');
    expect(entry.balanceAfter.toString()).toBe('99.00');
    expect(entry.walletVersion).toBe(3);
    expect(entry.createdAt).toEqual(at);
  });
});
