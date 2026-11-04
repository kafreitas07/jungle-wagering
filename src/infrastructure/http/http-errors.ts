import { HttpException } from '@nestjs/common';
import { ZodError } from 'zod';
import { ProviderIdentityMismatchError } from '../../application/ports';
import { ApplicationError } from '../../application/errors/application-errors';
import { SQLSTATE, sqlState } from '../../application/services/sql-errors';
import { DomainError } from '../../domain/errors/domain-errors';

/** An error the HTTP layer raises on purpose, already carrying its status and stable code. */
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
  WALLET_PLAYER_MISMATCH: { status: 422, message: 'The wallet does not belong to the informed player' },
  CURRENCY_MISMATCH: { status: 422, message: 'The wallet does not hold the informed currency' },
  INVALID_LEDGER_QUERY: { status: 400, message: 'Invalid ledger query' },
  CONCURRENCY_CONFLICT: { status: 503, message: 'Concurrent changes prevented the operation; send the same request again' },
};

const NODE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const DEPENDENCY_ERROR_NAMES = new Set([
  'ConnectionException',
  'ConnectionError',
  'TimeoutError',
  'CredentialsProviderError',
  'UnknownEndpoint',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'QueueDoesNotExist',
]);
const CONNECTION_TEXT = /ECONNREFUSED|ECONNRESET|Connection terminated|Unable to connect|connection timeout|socket hang up/i;

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 4; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

/** PostgreSQL or SQS could not be reached or went away: the caller may resend the same request. */
export function isDependencyFailure(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const code = (link as { code?: unknown }).code;
    const state = sqlState(link);
    return (
      (typeof code === 'string' && NODE_NETWORK_CODES.has(code)) ||
      (state !== undefined && (state.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(state))) ||
      DEPENDENCY_ERROR_NAMES.has((link as Error).name) ||
      (link as { $metadata?: unknown }).$metadata !== undefined ||
      CONNECTION_TEXT.test((link as Error).message)
    );
  });
}

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
