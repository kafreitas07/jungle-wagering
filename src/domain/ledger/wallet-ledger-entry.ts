import { InvalidLedgerEntryError } from '../errors/domain-errors';
import type { Money } from '../money/money';

export type LedgerDirection = 'CREDIT' | 'DEBIT';

export interface WalletLedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly amount: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  /** Wallet version right after this entry; unique per wallet. */
  readonly walletVersion: number;
  readonly createdAt: Date;
}

export interface CreateWalletLedgerEntryProps {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly walletVersion: number;
  readonly at: Date;
}

/** One immutable line explaining a balance change. There is no way to mutate it. */
export class WalletLedgerEntry implements WalletLedgerEntryState {
  private constructor(
    readonly id: string,
    readonly walletId: string,
    readonly transactionId: string,
    readonly direction: LedgerDirection,
    readonly amount: Money,
    readonly balanceBefore: Money,
    readonly balanceAfter: Money,
    readonly walletVersion: number,
    readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Validates `balanceBefore ± money == balanceAfter`, a positive amount and non-negative balances. */
  static create(props: CreateWalletLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter, direction } = props;

    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError('Ledger entry amount must be greater than 0.00');
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('Ledger entry balances must not be negative');
    }
    const expected = direction === 'CREDIT' ? balanceBefore.add(money) : balanceBefore.subtract(money);
    if (!expected.equals(balanceAfter)) {
      throw new InvalidLedgerEntryError(
        `Ledger arithmetic mismatch: ${balanceBefore} ${direction === 'CREDIT' ? '+' : '-'} ${money} != ${balanceAfter}`,
      );
    }

    return new WalletLedgerEntry(
      Bun.randomUUIDv7(),
      props.walletId,
      props.transactionId,
      direction,
      money,
      balanceBefore,
      balanceAfter,
      props.walletVersion,
      props.at,
    );
  }

  /** Rebuilds a stored entry. Trusts the database: no revalidation. */
  static rehydrate(state: WalletLedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.amount,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }
}
