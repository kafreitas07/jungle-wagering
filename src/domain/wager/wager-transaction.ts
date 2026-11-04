import { InvalidTransactionStateError, InvalidWagerTransactionError } from '../errors/domain-errors';
import type { Money } from '../money/money';

export type WagerKind = 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type TransactionKind = WagerKind | 'OPENING';

export type TransactionStatus = 'PENDING' | 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';

/** Business rejections that are persisted with the transaction. */
export type RejectionCode =
  | 'INSUFFICIENT_FUNDS'
  | 'REVERSAL_INSUFFICIENT_FUNDS'
  | 'REFERENCE_NOT_FOUND'
  | 'REFERENCE_MISMATCH'
  | 'INVALID_REFERENCE_KIND'
  | 'REFERENCE_NOT_PROCESSED'
  | 'REFERENCE_ALREADY_REVERSED'
  | 'AMOUNT_MISMATCH';

export type FailureCode = RejectionCode | 'PROCESSING_FAILED';

export interface ReferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
}

export type RetryDecision = { readonly exhausted: false } | { readonly exhausted: true };

export const INTERNAL_PROVIDER_ID = 'internal';

export interface WagerTransactionState {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;
  readonly status: TransactionStatus;
  readonly failureCode: FailureCode | null;
  readonly balanceAfter: Money | null;
  readonly referenceTransactionId: string | null;
  readonly referenceAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly processedAt: Date | null;
  readonly updatedAt: Date;
}

export interface CreateWagerTransactionProps {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string;
  readonly at: Date;
}

export interface CreateOpeningProps {
  readonly id: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly money: Money;
  readonly payloadHash: string;
  readonly at: Date;
}

type MutableState = Pick<
  WagerTransactionState,
  | 'status'
  | 'failureCode'
  | 'balanceAfter'
  | 'referenceTransactionId'
  | 'referenceAttempts'
  | 'nextAttemptAt'
  | 'processedAt'
  | 'updatedAt'
>;

/**
 * A provider operation and its outcome.
 * PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
 * PENDING_REFERENCE → PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED and FAILED are terminal.
 */
export class WagerTransaction {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: TransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | null;
  readonly createdAt: Date;

  private current: MutableState;

  private constructor(state: WagerTransactionState) {
    this.id = state.id;
    this.providerId = state.providerId;
    this.externalTransactionId = state.externalTransactionId;
    this.idempotencyKey = state.idempotencyKey;
    this.payloadHash = state.payloadHash;
    this.walletId = state.walletId;
    this.playerId = state.playerId;
    this.roundId = state.roundId;
    this.gameId = state.gameId;
    this.kind = state.kind;
    this.money = state.money;
    this.referenceExternalTransactionId = state.referenceExternalTransactionId;
    this.createdAt = state.createdAt;
    this.current = {
      status: state.status,
      failureCode: state.failureCode,
      balanceAfter: state.balanceAfter,
      referenceTransactionId: state.referenceTransactionId,
      referenceAttempts: state.referenceAttempts,
      nextAttemptAt: state.nextAttemptAt,
      processedAt: state.processedAt,
      updatedAt: state.updatedAt,
    };
  }

  /** New provider operation, born PENDING (in memory only). OPENING and the reserved provider are refused. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if ((props.kind as TransactionKind) === 'OPENING') {
      throw new InvalidWagerTransactionError('OPENING can only be built with createOpening');
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(`Provider id "${INTERNAL_PROVIDER_ID}" is reserved`);
    }
    return new WagerTransaction({
      id: Bun.randomUUIDv7(),
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      idempotencyKey: props.idempotencyKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money,
      referenceExternalTransactionId: props.referenceExternalTransactionId ?? null,
      createdAt: props.at,
      status: 'PENDING',
      failureCode: null,
      balanceAfter: null,
      referenceTransactionId: null,
      referenceAttempts: 0,
      nextAttemptAt: null,
      processedAt: null,
      updatedAt: props.at,
    });
  }

  /** The only way to build an OPENING: internal provider, already PROCESSED. */
  static createOpening(props: CreateOpeningProps): WagerTransaction {
    const openingKey = `opening:${props.walletId}`;
    return new WagerTransaction({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: openingKey,
      idempotencyKey: openingKey,
      payloadHash: props.payloadHash,
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: 'opening',
      gameId: 'opening',
      kind: 'OPENING',
      money: props.money,
      referenceExternalTransactionId: null,
      createdAt: props.at,
      status: 'PROCESSED',
      failureCode: null,
      balanceAfter: props.money,
      referenceTransactionId: null,
      referenceAttempts: 0,
      nextAttemptAt: null,
      processedAt: props.at,
      updatedAt: props.at,
    });
  }

  /** Rebuilds a stored transaction. Trusts the database: no revalidation. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(state);
  }

  get status(): TransactionStatus {
    return this.current.status;
  }

  get failureCode(): FailureCode | null {
    return this.current.failureCode;
  }

  get balanceAfter(): Money | null {
    return this.current.balanceAfter;
  }

  get referenceTransactionId(): string | null {
    return this.current.referenceTransactionId;
  }

  get referenceAttempts(): number {
    return this.current.referenceAttempts;
  }

  get nextAttemptAt(): Date | null {
    return this.current.nextAttemptAt;
  }

  get processedAt(): Date | null {
    return this.current.processedAt;
  }

  get updatedAt(): Date {
    return this.current.updatedAt;
  }

  markProcessed(props: { balanceAfter: Money; at: Date; referenceTransactionId?: string }): void {
    this.assertCanLeavePending('mark as PROCESSED');
    this.current = {
      ...this.current,
      status: 'PROCESSED',
      balanceAfter: props.balanceAfter,
      referenceTransactionId: props.referenceTransactionId ?? this.current.referenceTransactionId,
      nextAttemptAt: null,
      processedAt: props.at,
      updatedAt: props.at,
    };
  }

  reject(props: { failureCode: RejectionCode; balanceAfter: Money; at: Date }): void {
    this.assertCanLeavePending('reject');
    this.current = {
      ...this.current,
      status: 'REJECTED',
      failureCode: props.failureCode,
      balanceAfter: props.balanceAfter,
      nextAttemptAt: null,
      updatedAt: props.at,
    };
  }

  fail(props: { at: Date }): void {
    this.assertCanLeavePending('fail');
    this.current = {
      ...this.current,
      status: 'FAILED',
      failureCode: 'PROCESSING_FAILED',
      nextAttemptAt: null,
      updatedAt: props.at,
    };
  }

  /** PENDING → PENDING_REFERENCE: 0 attempts so far, first retry after the base delay. */
  markPendingReference(props: { balanceAfter: Money; at: Date; policy: ReferenceRetryPolicy }): void {
    if (this.current.status !== 'PENDING') {
      throw this.invalidTransition('mark as PENDING_REFERENCE');
    }
    this.current = {
      ...this.current,
      status: 'PENDING_REFERENCE',
      balanceAfter: props.balanceAfter,
      referenceAttempts: 0,
      nextAttemptAt: new Date(props.at.getTime() + retryDelayMs(1, props.policy)),
      updatedAt: props.at,
    };
  }

  /**
   * Records a retry that still did not find the reference. Schedules the next one,
   * or reports `exhausted` when `maxAttempts` was reached; the caller then rejects
   * the transaction with REFERENCE_NOT_FOUND.
   */
  scheduleReferenceRetry(now: Date, policy: ReferenceRetryPolicy): RetryDecision {
    if (this.current.status !== 'PENDING_REFERENCE') {
      throw this.invalidTransition('schedule a reference retry');
    }
    const attempts = this.current.referenceAttempts + 1;
    if (attempts >= policy.maxAttempts) {
      this.current = { ...this.current, referenceAttempts: attempts, updatedAt: now };
      return { exhausted: true };
    }
    this.current = {
      ...this.current,
      referenceAttempts: attempts,
      nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts + 1, policy)),
      updatedAt: now,
    };
    return { exhausted: false };
  }

  private assertCanLeavePending(action: string): void {
    if (this.current.status !== 'PENDING' && this.current.status !== 'PENDING_REFERENCE') {
      throw this.invalidTransition(action);
    }
  }

  private invalidTransition(action: string): InvalidTransactionStateError {
    return new InvalidTransactionStateError(`Cannot ${action} a transaction in status ${this.current.status}`);
  }
}

/** Wait before attempt `attempt` (1-based): base · factor^(attempt − 1), capped. */
function retryDelayMs(attempt: number, policy: ReferenceRetryPolicy): number {
  return Math.min(policy.baseDelayMs * policy.factor ** (attempt - 1), policy.maxDelayMs);
}
