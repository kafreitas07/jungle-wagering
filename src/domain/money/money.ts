import { CurrencyMismatchError, InvalidMoneyError } from '../errors/domain-errors';

export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Optional sign, integer part, at most 2 decimals. More decimals are rejected, never rounded.
const AMOUNT_PATTERN = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

/** Immutable monetary value: bigint cents, fixed scale of 2. Never a JavaScript number. */
export class Money {
  private constructor(
    readonly cents: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    assertCurrency(props.currency);
    if (typeof props.amount !== 'string') {
      throw new InvalidMoneyError('Money amount must be a decimal string');
    }
    const match = AMOUNT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(`Invalid money amount: "${props.amount}"`);
    }
    const [, sign, integer = '0', decimals = ''] = match;
    const magnitude = BigInt(integer) * 100n + BigInt(decimals.padEnd(2, '0'));
    return new Money(sign ? -magnitude : magnitude, props.currency);
  }

  static fromCents(cents: bigint, currency: string): Money {
    assertCurrency(currency);
    if (typeof cents !== 'bigint') {
      throw new InvalidMoneyError('Money cents must be a bigint');
    }
    return new Money(cents, currency);
  }

  static zero(currency: string): Money {
    return Money.fromCents(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const integer = absolute / 100n;
    const decimals = (absolute % 100n).toString().padStart(2, '0');
    return `${this.cents < 0n ? '-' : ''}${integer}.${decimals}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

function assertCurrency(currency: unknown): asserts currency is string {
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    throw new InvalidMoneyError(`Invalid currency: "${String(currency)}"`);
  }
}
