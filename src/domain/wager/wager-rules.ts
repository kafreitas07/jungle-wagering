import { InvalidWagerTransactionError } from '../errors/domain-errors';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import type { Wallet } from '../wallet/wallet';
import type { RejectionCode, TransactionKind, WagerTransaction } from './wager-transaction';

export type Outcome =
  | { readonly type: 'PROCESSED'; readonly entry?: WalletLedgerEntry }
  | { readonly type: 'REJECTED'; readonly code: RejectionCode }
  | { readonly type: 'PENDING_REFERENCE' };

export interface DecideInput {
  /** The wallet, already locked by the caller. Changed only when the outcome is PROCESSED. */
  readonly wallet: Wallet;
  /** Never modified here: the caller applies the matching transition. */
  readonly transaction: WagerTransaction;
  /** The transaction named by `referenceExternalTransactionId`, resolved by the caller. */
  readonly reference?: WagerTransaction;
  /** A PROCESSED REFUND or ROLLBACK already points at `reference`. */
  readonly alreadyReversed: boolean;
  readonly at: Date;
}

const REJECT = (code: RejectionCode): Outcome => ({ type: 'REJECTED', code });
const PENDING: Outcome = { type: 'PENDING_REFERENCE' };

const FUNDS_BY_REVERSAL: RejectionCode = 'REVERSAL_INSUFFICIENT_FUNDS';

/**
 * Business rules of section 7, one place, no database.
 *
 * Order of the reference checks (the challenge does not fix one): self reference →
 * missing or non-terminal reference (pending) → identity → kind → reference not
 * PROCESSED → amount → already reversed → funds.
 */
export class WagerRules {
  private constructor() {}

  static decide(input: DecideInput): Outcome {
    const { wallet, transaction, at } = input;

    switch (transaction.kind) {
      case 'OPENING':
        throw new InvalidWagerTransactionError('OPENING is internal and is never decided');

      case 'BET':
        return move(wallet, transaction, 'DEBIT', at, 'INSUFFICIENT_FUNDS');

      case 'WIN':
      case 'LOSS': {
        if (transaction.referenceExternalTransactionId !== null) {
          const resolved = resolveReference(transaction, input.reference, ['BET']);
          if ('outcome' in resolved) {
            return resolved.outcome;
          }
        }
        return transaction.kind === 'WIN' ? move(wallet, transaction, 'CREDIT', at, 'INSUFFICIENT_FUNDS') : { type: 'PROCESSED' };
      }

      case 'REFUND':
      case 'ROLLBACK': {
        const allowed: TransactionKind[] = transaction.kind === 'REFUND' ? ['BET'] : ['BET', 'WIN', 'REFUND'];
        const resolved = resolveReference(transaction, input.reference, allowed);
        if ('outcome' in resolved) {
          return resolved.outcome;
        }
        const { reference } = resolved;

        if (!reference.money.equals(transaction.money)) {
          return REJECT('AMOUNT_MISMATCH');
        }
        if (input.alreadyReversed) {
          return REJECT('REFERENCE_ALREADY_REVERSED');
        }
        return move(wallet, transaction, reversalDirection(reference.kind), at, FUNDS_BY_REVERSAL);
      }
    }
  }
}

type Resolution = { readonly outcome: Outcome } | { readonly reference: WagerTransaction };

function resolveReference(
  transaction: WagerTransaction,
  reference: WagerTransaction | undefined,
  allowedKinds: readonly TransactionKind[],
): Resolution {
  if (transaction.referenceExternalTransactionId === transaction.externalTransactionId || reference?.id === transaction.id) {
    return { outcome: REJECT('INVALID_REFERENCE_KIND') };
  }
  if (reference === undefined || reference.status === 'PENDING' || reference.status === 'PENDING_REFERENCE') {
    return { outcome: PENDING };
  }
  if (
    reference.providerId !== transaction.providerId ||
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.roundId !== transaction.roundId ||
    reference.money.currency !== transaction.money.currency
  ) {
    return { outcome: REJECT('REFERENCE_MISMATCH') };
  }
  if (!allowedKinds.includes(reference.kind)) {
    return { outcome: REJECT('INVALID_REFERENCE_KIND') };
  }
  if (reference.status !== 'PROCESSED') {
    return { outcome: REJECT('REFERENCE_NOT_PROCESSED') };
  }
  return { reference };
}

/** A reversal moves the balance the opposite way of the transaction it reverses. */
function reversalDirection(referenceKind: TransactionKind): LedgerDirection {
  switch (referenceKind) {
    case 'BET':
      return 'CREDIT'; // the BET debited
    case 'WIN':
    case 'REFUND':
      return 'DEBIT'; // the WIN and the REFUND credited
    default:
      throw new InvalidWagerTransactionError(`A ${referenceKind} cannot be reversed`);
  }
}

function move(
  wallet: Wallet,
  transaction: WagerTransaction,
  direction: LedgerDirection,
  at: Date,
  insufficientFundsCode: RejectionCode,
): Outcome {
  if (direction === 'DEBIT') {
    if (wallet.balance.isLessThan(transaction.money)) {
      return REJECT(insufficientFundsCode);
    }
    return { type: 'PROCESSED', entry: wallet.debit(transaction.money, transaction.id, at) };
  }
  return { type: 'PROCESSED', entry: wallet.credit(transaction.money, transaction.id, at) };
}
