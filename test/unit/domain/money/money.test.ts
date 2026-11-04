import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError } from '../../../../src/domain/errors/domain-errors';
import { Money } from '../../../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money.from — exact representation (MON-01, MON-02)', () => {
  test.each([
    ['10', '10.00'],
    ['10.5', '10.50'],
    ['10.50', '10.50'],
    ['0', '0.00'],
    ['0.10', '0.10'],
    ['0.01', '0.01'],
    ['007.5', '7.50'],
    ['-1.5', '-1.50'],
  ])('normalizes %s to %s with exactly 2 decimals', (input, expected) => {
    const money = brl(input);

    expect(money.toString()).toBe(expected);
    expect(money.toJSON().amount).toBe(expected);
  });

  test('preserves values beyond double precision', () => {
    expect(brl('999999999999999999.99').toString()).toBe('999999999999999999.99');
    expect(brl('1234567890123456789012.34').toString()).toBe('1234567890123456789012.34');
  });

  test('0.10 + 0.20 is exactly 0.30 (no float drift)', () => {
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  test('toJSON returns string amount and currency; JSON.stringify uses it', () => {
    const money = brl('25.00');

    expect(money.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(JSON.stringify(money)).toBe('{"amount":"25.00","currency":"BRL"}');
  });

  test('stores cents as bigint', () => {
    expect(brl('12.34').cents).toBe(1234n);
    expect(typeof brl('12.34').cents).toBe('bigint');
  });

  test('rejects a JavaScript number as amount', () => {
    expect(() => Money.from({ amount: 10.5 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test('fromCents builds from bigint and rejects number', () => {
    expect(Money.fromCents(1050n, 'BRL').toString()).toBe('10.50');
    expect(() => Money.fromCents(1050 as unknown as bigint, 'BRL')).toThrow(InvalidMoneyError);
  });

  test('zero builds 0.00', () => {
    expect(Money.zero('BRL').toString()).toBe('0.00');
    expect(Money.zero('BRL').isZero()).toBe(true);
  });
});

describe('Money immutability (MON-03)', () => {
  test('add returns a new instance and leaves both operands unchanged', () => {
    const a = brl('10.00');
    const b = brl('2.50');

    const sum = a.add(b);

    expect(sum.toString()).toBe('12.50');
    expect(sum).not.toBe(a);
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('2.50');
  });

  test('subtract returns a new instance and leaves both operands unchanged', () => {
    const a = brl('10.00');
    const b = brl('2.50');

    const difference = a.subtract(b);

    expect(difference.toString()).toBe('7.50');
    expect(difference).not.toBe(a);
    expect(a.toString()).toBe('10.00');
    expect(b.toString()).toBe('2.50');
  });

  test('negate returns a new instance and leaves the original unchanged', () => {
    const a = brl('10.00');

    const negated = a.negate();

    expect(negated.toString()).toBe('-10.00');
    expect(negated).not.toBe(a);
    expect(a.toString()).toBe('10.00');
  });

  test('instances are frozen: assignment throws', () => {
    const money = brl('1.00');

    expect(Object.isFrozen(money)).toBe(true);
    expect(() => {
      (money as unknown as { cents: bigint }).cents = 5n;
    }).toThrow();
  });
});

describe('Money negatives (MON-04)', () => {
  test('subtract that goes below zero is represented and isNegative', () => {
    const result = brl('3.00').subtract(brl('8.00'));

    expect(result.toString()).toBe('-5.00');
    expect(result.isNegative()).toBe(true);
    expect(result.isPositive()).toBe(false);
  });

  test('negate of a positive is negative', () => {
    expect(brl('5.00').negate().isNegative()).toBe(true);
  });

  test('sub-unit negatives keep the sign and padding', () => {
    expect(brl('-0.05').toString()).toBe('-0.05');
    expect(brl('0.00').subtract(brl('0.05')).toString()).toBe('-0.05');
  });

  test('negative zero does not exist', () => {
    expect(brl('-0.00').toString()).toBe('0.00');
    expect(brl('-0.00').isNegative()).toBe(false);
    expect(brl('0.00').negate().toString()).toBe('0.00');
    expect(brl('0.00').negate().isNegative()).toBe(false);
  });
});

describe('Money comparisons', () => {
  test('isZero, isPositive and isNegative', () => {
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('0.01').isZero()).toBe(false);
    expect(brl('-0.01').isNegative()).toBe(true);
  });

  test('isLessThan and equals', () => {
    expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
    expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').isLessThan(brl('1.00'))).toBe(false);
    expect(brl('1.00').equals(brl('1'))).toBe(true);
    expect(brl('1.00').equals(brl('1.01'))).toBe(false);
  });
});

describe('Money currency mismatch (MON-05)', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });

  test.each([
    ['add', () => brl('1.00').add(usd)],
    ['subtract', () => brl('1.00').subtract(usd)],
    ['isLessThan', () => brl('1.00').isLessThan(usd)],
  ])('%s with another currency throws CurrencyMismatchError', (_name, operation) => {
    expect(operation).toThrow(CurrencyMismatchError);
  });

  // equals is a question, not an operation: different currencies are simply not equal.
  test('equals with another currency returns false, even with the same amount', () => {
    expect(brl('1.00').equals(usd)).toBe(false);
    expect(usd.equals(brl('1.00'))).toBe(false);
  });
});

describe('Money.from — invalid amounts (MON-06)', () => {
  test.each([
    'NaN',
    'Infinity',
    '-Infinity',
    '1e3',
    '1E3',
    '',
    ' ',
    'abc',
    '1.234',
    '0.001',
    '1.',
    '.5',
    '+1.00',
    '1,00',
    '1 .00',
    '0x10',
    ' 1.00',
  ])('rejects %p without rounding', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });
});

describe('Money.from — currency (MON-07)', () => {
  test.each(['brl', 'BR', 'BRLL', '', 'B1L', 'R$ '])('rejects currency %p', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('rejects a non-string currency', () => {
    expect(() => Money.from({ amount: '1.00', currency: 986 as unknown as string })).toThrow(InvalidMoneyError);
  });

  test.each(['BRL', 'USD'])('accepts %s', (currency) => {
    expect(Money.from({ amount: '1.00', currency }).currency).toBe(currency);
  });

  test('fromCents and zero also validate the currency', () => {
    expect(() => Money.fromCents(100n, 'xx')).toThrow(InvalidMoneyError);
    expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
  });
});
