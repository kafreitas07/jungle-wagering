import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { ProviderIdentityMismatchError } from '../../application/ports';
import { ApplicationError } from '../../application/errors/application-errors';
import { SQLSTATE, sqlState } from '../../application/services/sql-errors';
import { isDependencyFailure } from '../dependency-failure';
import { DomainError } from '../../domain/errors/domain-errors';

/** An error the HTTP layer raises on purpose, already carrying its status and stable code. */
export { isDependencyFailure };

export class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly failureCode: string,
    message: string,
    readonly details?: readonly unknown[],
  ) {
    super(message);
    this.name = 'HttpFailure';
  }
}

export interface HttpErrorBody {
  readonly failureCode: string;
  readonly message: string;
  readonly details?: readonly unknown[];
}

export interface MappedError {
  readonly status: number;
  readonly body: HttpErrorBody;
  /** Seconds. Present on every transient failure: "send the same request again after this". */
  readonly retryAfter?: number;
}

const RETRY_AFTER_SECONDS = 1;

const BY_APPLICATION_CODE: Record<string, { status: number; message: string }> = {
  WALLET_NOT_FOUND: { status: 404, message: 'Wallet not found' },
  TRANSACTION_NOT_FOUND: { status: 404, message: 'Transaction not found' },
  WALLET_ALREADY_EXISTS: { status: 409, message: 'The player already has a wallet in this currency' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: 'The idempotency key was already used with a different payload' },
  EXTERNAL_ID_CONFLICT: { status: 409, message: 'The external transaction id already exists under another idempotency key' },
  INVALID_LEDGER_QUERY: { status: 400, message: 'Invalid ledger query' },
  CONCURRENCY_CONFLICT: { status: 503, message: 'Concurrent changes prevented the operation; send the same request again' },
};

const isLockConflict = (error: unknown): boolean =>
  [SQLSTATE.lockNotAvailable, SQLSTATE.serializationFailure, SQLSTATE.deadlockDetected].some((state) => sqlState(error) === state);

const transient = (failureCode: string, message: string): MappedError => ({
  status: 503,
  body: { failureCode, message },
  retryAfter: RETRY_AFTER_SECONDS,
});

/**
 * One table for every endpoint: payload problem (400), missing resource (404), conflict (409), business rule (422),
 * transient failure (503 + Retry-After) and unexpected (500). Bodies carry a stable `failureCode`, never a stack or SQL.
 */
export function mapError(error: unknown): MappedError {
  if (error instanceof HttpFailure) {
    return {
      status: error.status,
      body: { failureCode: error.failureCode, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        failureCode: 'VALIDATION_ERROR',
        message: 'The request is invalid',
        details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      },
    };
  }
  if (error instanceof ProviderIdentityMismatchError) {
    return { status: 403, body: { failureCode: 'PROVIDER_IDENTITY_MISMATCH', message: 'The credential cannot act as this provider' } };
  }
  if (error instanceof ApplicationError) {
    const known = BY_APPLICATION_CODE[error.code];
    if (known !== undefined) {
      return known.status === 503
        ? transient(error.code, known.message)
        : { status: known.status, body: { failureCode: error.code, message: known.message } };
    }
  }
  if (error instanceof DomainError) {
    return { status: 400, body: { failureCode: 'VALIDATION_ERROR', message: 'The request is invalid' } };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 404) {
      return { status: 404, body: { failureCode: 'ROUTE_NOT_FOUND', message: 'Route not found' } };
    }
    if (status >= 400 && status < 500) {
      return { status: 400, body: { failureCode: 'VALIDATION_ERROR', message: 'The request is malformed' } };
    }
  }
  if (isLockConflict(error)) {
    return transient('CONCURRENCY_CONFLICT', 'Concurrent changes prevented the operation; send the same request again');
  }
  if (isDependencyFailure(error)) {
    return transient('DEPENDENCY_UNAVAILABLE', 'A dependency is temporarily unavailable; send the same request again');
  }
  return { status: 500, body: { failureCode: 'INTERNAL_ERROR', message: 'Unexpected error' } };
}
