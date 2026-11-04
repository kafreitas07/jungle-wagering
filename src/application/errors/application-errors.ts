/** Failures that are the caller's to fix or to retry; none of them leaves a partial effect. */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {
  readonly code = 'WALLET_NOT_FOUND';

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not exist`);
  }
}

export class WalletPlayerMismatchError extends ApplicationError {
  readonly code = 'WALLET_PLAYER_MISMATCH';

  constructor(walletId: string) {
    super(`Wallet ${walletId} does not belong to the informed player`);
  }
}

export class WalletCurrencyMismatchError extends ApplicationError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(walletId: string, currency: string) {
    super(`Wallet ${walletId} does not hold ${currency}`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor(providerId: string, idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" of provider "${providerId}" was already used with a different payload`);
  }
}

export class ExternalIdConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_ID_CONFLICT';

  constructor(providerId: string, externalTransactionId: string) {
    super(`Transaction "${externalTransactionId}" of provider "${providerId}" already exists under another idempotency key`);
  }
}

/** The retries for lock timeout, deadlock or version conflict ran out. Transient: the caller may resend. */
export class ConcurrencyConflictError extends ApplicationError {
  readonly code = 'CONCURRENCY_CONFLICT';

  constructor(attempts: number, cause?: unknown) {
    super(`Gave up after ${attempts} attempts because of concurrent changes`);
    this.cause = cause;
  }
}

export class TransactionNotFoundError extends ApplicationError {
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transaction ${reference} does not exist`);
  }
}

export class InvalidLedgerQueryError extends ApplicationError {
  readonly code = 'INVALID_LEDGER_QUERY';

  constructor(limit: number) {
    super(`Ledger limit must be an integer from 1 to 200, got ${limit}`);
  }
}
