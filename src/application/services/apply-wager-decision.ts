import type { EventContext, IntegrationEvent } from '../../domain/messaging/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/integration-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Wallet } from '../../domain/wallet/wallet';
import { WagerRules } from '../../domain/wager/wager-rules';
import type { ReferenceRetryPolicy, WagerTransaction } from '../../domain/wager/wager-transaction';
import type { TxRepositories } from '../ports';

export interface ApplyWagerDecisionInput {
  readonly tx: TxRepositories;
  /** Already locked by the caller (`lockById`) and read inside this transaction. */
  readonly wallet: Wallet;
  readonly transaction: WagerTransaction;
  /**
   * `create`: a new transaction, inserted in its final state.
   * `reprocess`: a PENDING_REFERENCE transaction that already exists and is updated.
   */
  readonly mode: 'create' | 'reprocess';
  readonly context: EventContext;
  readonly policy: ReferenceRetryPolicy;
  readonly at: Date;
}

/**
 * Steps 5 and 6 of the submission, shared by the HTTP/SQS path and the pending-reference worker so the rules are
 * applied identically: resolve the reference, decide (`WagerRules`), persist the transaction in its new state, move
 * the balance with its ledger entry, and enqueue the events, all inside the caller's SQL transaction.
 */
export async function applyWagerDecision(input: ApplyWagerDecisionInput): Promise<void> {
  const { tx, wallet, transaction, mode, context, policy, at } = input;

  const reference =
    transaction.referenceExternalTransactionId === null
      ? undefined
      : ((await tx.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)) ?? undefined);
  const alreadyReversed = reference === undefined ? false : await tx.transactions.hasProcessedReversal(reference.id);

  const expectedVersion = wallet.version;
  const outcome = WagerRules.decide({
    wallet,
    transaction,
    ...(reference === undefined ? {} : { reference }),
    alreadyReversed,
    at,
  });
  const persist = () => (mode === 'create' ? tx.transactions.insert(transaction) : tx.transactions.save(transaction));

  switch (outcome.type) {
    case 'PROCESSED': {
      transaction.markProcessed({
        balanceAfter: wallet.balance,
        at,
        ...(reference === undefined ? {} : { referenceTransactionId: reference.id }),
      });
      await persist();
      await publish(tx, WagerTransactionProcessed.from(transaction, context));
      if (outcome.entry !== undefined) {
        await tx.wallets.save(wallet, expectedVersion);
        await tx.ledger.append(outcome.entry);
        await publish(tx, WalletBalanceChanged.from(wallet, outcome.entry, context));
      }
      return;
    }
    case 'REJECTED': {
      transaction.reject({ failureCode: outcome.code, balanceAfter: wallet.balance, at });
      await persist();
      await publish(tx, WagerTransactionRejected.from(transaction, context));
      return;
    }
    case 'PENDING_REFERENCE': {
      if (mode === 'create') {
        transaction.markPendingReference({ balanceAfter: wallet.balance, at, policy });
        await persist();
        await publish(tx, WagerTransactionPendingReference.from(transaction, context));
        return;
      }
      // Still without its reference: count the attempt; when they run out the reversal is rejected for good.
      if (transaction.scheduleReferenceRetry(at, policy).exhausted) {
        transaction.reject({ failureCode: 'REFERENCE_NOT_FOUND', balanceAfter: wallet.balance, at });
        await persist();
        await publish(tx, WagerTransactionRejected.from(transaction, context));
        return;
      }
      await persist();
      return;
    }
  }
}

function publish(tx: TxRepositories, event: IntegrationEvent<unknown>): Promise<void> {
  return tx.outbox.enqueue(OutboxMessage.enqueue(event));
}
