import { InsufficientFundsError, InvalidMoneyError } from '../errors/domain-errors';
import { type LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly playerId: string;
  readonly initialBalance: Money;
  /** Id of the OPENING transaction; used only when the initial balance is greater than 0.00. */
  readonly openingTransactionId: string;
  readonly at: Date;
}

export interface OpenedWallet {
  readonly wallet: Wallet;
  readonly openingEntry?: WalletLedgerEntry;
}

/**
 * Balance aggregate. The only way to change the balance is `debit`/`credit`,
 * and both return the ledger entry that explains the change.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    private currentBalance: Money,
    private currentVersion: number,
    readonly createdAt: Date,
    private lastUpdatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): OpenedWallet {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('Initial balance must not be negative');
    }

    const wallet = new Wallet(Bun.randomUUIDv7(), props.playerId, initialBalance, 1, at, at);
    if (initialBalance.isZero()) {
      return { wallet };
    }

    const openingEntry = WalletLedgerEntry.create({
      walletId: wallet.id,
      transactionId: props.openingTransactionId,
      direction: 'CREDIT',
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds a stored wallet. Trusts the database: no revalidation. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this.currentBalance;
  }

  get version(): number {
    return this.currentVersion;
  }

  get currency(): string {
    return this.currentBalance.currency;
  }

  get updatedAt(): Date {
    return this.lastUpdatedAt;
  }

  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    assertPositiveMovement(money);
    const balanceAfter = this.currentBalance.subtract(money);
    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(`Debit of ${money} exceeds the balance`);
    }
    return this.apply('DEBIT', money, balanceAfter, transactionId, at);
  }

  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry {
    assertPositiveMovement(money);
    return this.apply('CREDIT', money, this.currentBalance.add(money), transactionId, at);
  }

  /** Creates the entry first: if it is refused, balance and version stay untouched. */
  private apply(
    direction: LedgerDirection,
    money: Money,
    balanceAfter: Money,
    transactionId: string,
    at: Date,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      direction,
      money,
      balanceBefore: this.currentBalance,
      balanceAfter,
      walletVersion: this.currentVersion + 1,
      at,
    });
    this.currentBalance = balanceAfter;
    this.currentVersion += 1;
    this.lastUpdatedAt = at;
    return entry;
  }
}

/** A movement must be greater than 0.00: a negative debit would raise the balance. */
function assertPositiveMovement(money: Money): void {
  if (!money.isPositive()) {
    throw new InvalidMoneyError(`Movement amount must be greater than 0.00, got ${money}`);
  }
}
