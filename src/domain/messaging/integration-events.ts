import { InvalidWagerTransactionError } from '../errors/domain-errors';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { MoneyProps } from '../money/money';
import type { Wallet } from '../wallet/wallet';
import type { FailureCode, TransactionKind, WagerTransaction } from '../wager/wager-transaction';
import { type EventContext, IntegrationEvent, type IntegrationEventProps, newEventProps } from './integration-event';

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Only when the balance changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, context: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged(
      newEventProps(wallet.id, context, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.amount.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}

interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  kind: TransactionKind;
}

function transactionData(transaction: WagerTransaction): TransactionEventData {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
  };
}

function assertStatus(transaction: WagerTransaction, expected: string, event: string): void {
  if (transaction.status !== expected) {
    throw new InvalidWagerTransactionError(`${event} needs a ${expected} transaction, got ${transaction.status}`);
  }
}

export interface WagerTransactionProcessedData extends TransactionEventData {
  money: MoneyProps;
  balanceAfter: MoneyProps;
}

/** Any applied transaction, LOSS and OPENING included. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, 'PROCESSED', 'WagerTransactionProcessed');
    const balanceAfter = transaction.balanceAfter;
    if (balanceAfter === null) {
      throw new InvalidWagerTransactionError('A PROCESSED transaction must carry its balanceAfter');
    }
    return new WagerTransactionProcessed(
      newEventProps(transaction.walletId, context, {
        ...transactionData(transaction),
        money: transaction.money.toJSON(),
        balanceAfter: balanceAfter.toJSON(),
      }),
    );
  }
}

export interface WagerTransactionRejectedData extends TransactionEventData {
  money: MoneyProps;
  failureCode: FailureCode;
}

/** Business rejection only. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    assertStatus(transaction, 'REJECTED', 'WagerTransactionRejected');
    const failureCode = transaction.failureCode;
    if (failureCode === null) {
      throw new InvalidWagerTransactionError('A REJECTED transaction must carry its failureCode');
    }
    return new WagerTransactionRejected(
      newEventProps(transaction.walletId, context, {
        ...transactionData(transaction),
        money: transaction.money.toJSON(),
        failureCode,
      }),
    );
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
}

/** A reversal or linked result whose reference has not arrived yet. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, 'PENDING_REFERENCE', 'WagerTransactionPendingReference');
    const referenceExternalTransactionId = transaction.referenceExternalTransactionId;
    if (referenceExternalTransactionId === null) {
      throw new InvalidWagerTransactionError('A PENDING_REFERENCE transaction must name its reference');
    }
    return new WagerTransactionPendingReference(
      newEventProps(transaction.walletId, context, {
        ...transactionData(transaction),
        referenceExternalTransactionId,
      }),
    );
  }
}
