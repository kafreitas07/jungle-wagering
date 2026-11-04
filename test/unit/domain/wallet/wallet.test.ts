import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from '../../../../src/domain/errors/domain-errors';
import { WalletLedgerEntry } from '../../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../../src/domain/money/money';
import { Wallet } from '../../../../src/domain/wallet/wallet';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
const opened = new Date('2026-11-03T12:00:00.000Z');
const later = new Date('2026-11-03T12:05:00.000Z');

const openWith = (initial: string) =>
  Wallet.open({
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'opening-transaction',
    at: opened,
  });

describe('Wallet.open (WAL-02, WAL-03)', () => {
  test('with a positive balance starts at version 1 and returns the opening CREDIT entry', () => {
    const { wallet, openingEntry } = openWith('1000.00');

    expect(wallet.playerId).toBe('player-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe('CREDIT');
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.amount.toString()).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
    expect(openingEntry?.walletId).toBe(wallet.id);
    expect(openingEntry?.transactionId).toBe('opening-transaction');
  });

  test('with 0.00 starts at version 1 and returns no ledger entry', () => {
    const { wallet, openingEntry } = openWith('0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('rejects a negative initial balance', () => {
    expect(() => openWith('-1.00')).toThrow(InvalidMoneyError);
  });
});

describe('Wallet.debit (WAL-07, WAL-08)', () => {
  test('lowers the balance, bumps the version and returns the DEBIT entry', () => {
    const { wallet } = openWith('100.00');

    const entry = wallet.debit(brl('30.00'), 'bet-1', later);

    expect(wallet.balance.toString()).toBe('70.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt).toEqual(later);
    expect(entry).toBeInstanceOf(WalletLedgerEntry);
    expect(entry.direction).toBe('DEBIT');
    expect(entry.amount.toString()).toBe('30.00');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.walletId).toBe(wallet.id);
    expect(entry.transactionId).toBe('bet-1');
    expect(entry.createdAt).toEqual(later);
  });

  test('above the balance throws InsufficientFundsError and changes nothing', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(brl('100.01'), 'bet-1', later)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(opened);
  });

  test('that brings the balance to exactly 0.00 is accepted', () => {
    const { wallet } = openWith('100.00');

    const entry = wallet.debit(brl('100.00'), 'bet-1', later);

    expect(wallet.balance.toString()).toBe('0.00');
    expect(entry.balanceAfter.toString()).toBe('0.00');
  });
});

describe('Wallet.credit', () => {
  test('raises the balance, bumps the version and returns the CREDIT entry', () => {
    const { wallet } = openWith('100.00');

    const entry = wallet.credit(brl('25.50'), 'win-1', later);

    expect(wallet.balance.toString()).toBe('125.50');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe('CREDIT');
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('125.50');
    expect(entry.walletVersion).toBe(2);
    expect(entry.transactionId).toBe('win-1');
  });
});

describe('Wallet version and ledger chain (WAL-07)', () => {
  test('each change adds exactly 1 to the version and each entry starts where the previous ended', () => {
    const { wallet, openingEntry } = openWith('100.00');

    const credit = wallet.credit(brl('50.00'), 'win-1', later);
    const debit = wallet.debit(brl('120.00'), 'bet-1', later);

    expect(wallet.version).toBe(3);
    expect(wallet.balance.toString()).toBe('30.00');
    expect(credit.walletVersion).toBe(2);
    expect(debit.walletVersion).toBe(3);
    expect(credit.balanceBefore.toString()).toBe(openingEntry?.balanceAfter.toString() ?? '');
    expect(debit.balanceBefore.toString()).toBe(credit.balanceAfter.toString());
  });
});

describe('Wallet currency (WAL-09)', () => {
  test('debit in another currency throws CurrencyMismatchError and changes nothing', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(usd('10.00'), 'bet-1', later)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('credit in another currency throws CurrencyMismatchError and changes nothing', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.credit(usd('10.00'), 'win-1', later)).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet never changes balance without a ledger entry', () => {
  // The guard sits in the wallet itself and runs before any other check.
  test.each([
    ['debit', '0.00'],
    ['debit', '-50.00'],
    ['credit', '0.00'],
    ['credit', '-200.00'],
  ] as const)('%s of %s throws InvalidMoneyError and changes nothing', (method, amount) => {
    const { wallet } = openWith('100.00');

    expect(() => wallet[method](brl(amount), 'transaction-1', later)).toThrow(InvalidMoneyError);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(opened);
  });

  test('the movement guard runs before the currency check', () => {
    const { wallet } = openWith('100.00');

    expect(() => wallet.debit(usd('0.00'), 'bet-1', later)).toThrow(InvalidMoneyError);
    expect(() => wallet.credit(usd('-1.00'), 'win-1', later)).toThrow(InvalidMoneyError);
  });

  test('balance and version cannot be assigned from outside', () => {
    const { wallet } = openWith('100.00');

    // @ts-expect-error balance is read-only
    expect(() => (wallet.balance = brl('999.00'))).toThrow();
    // @ts-expect-error version is read-only
    expect(() => (wallet.version = 99)).toThrow();
    expect(wallet.balance.toString()).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('restores the stored state and continues from its version', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      balance: brl('50.00'),
      version: 7,
      createdAt: opened,
      updatedAt: opened,
    });

    const entry = wallet.credit(brl('5.00'), 'win-1', later);

    expect(wallet.id).toBe('wallet-1');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.version).toBe(8);
    expect(entry.walletVersion).toBe(8);
    expect(entry.balanceAfter.toString()).toBe('55.00');
  });
});
