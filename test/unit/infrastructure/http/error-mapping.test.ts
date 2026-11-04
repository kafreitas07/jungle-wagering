import { describe, expect, test } from 'bun:test';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import {
  ConcurrencyConflictError,
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidLedgerQueryError,
  TransactionNotFoundError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../../../src/application/errors/application-errors';
import { OptimisticLockError, ProviderIdentityMismatchError } from '../../../../src/application/ports';
import { InvalidMoneyError } from '../../../../src/domain/errors/domain-errors';
import { HttpFailure, isDependencyFailure, mapError } from '../../../../src/infrastructure/http/http-errors';

const sqlError = (code: string, message = 'db') => Object.assign(new Error(message), { code });

describe('mapError: one table for every endpoint (API-01, API-02)', () => {
  test.each([
    ['wallet not found (query)', new WalletNotFoundError('w'), 404, 'WALLET_NOT_FOUND'],
    ['transaction not found', new TransactionNotFoundError('t'), 404, 'TRANSACTION_NOT_FOUND'],
    ['wallet already exists', new WalletAlreadyExistsError('p', 'BRL'), 409, 'WALLET_ALREADY_EXISTS'],
    ['idempotency key reused', new IdempotencyConflictError('p', 'k'), 409, 'IDEMPOTENCY_KEY_REUSED'],
    ['external id conflict', new ExternalIdConflictError('p', 'e'), 409, 'EXTERNAL_ID_CONFLICT'],
    ['invalid ledger query', new InvalidLedgerQueryError(500), 400, 'INVALID_LEDGER_QUERY'],
    ['provider identity', new ProviderIdentityMismatchError('p'), 403, 'PROVIDER_IDENTITY_MISMATCH'],
    ['domain error', new InvalidMoneyError('bad'), 400, 'VALIDATION_ERROR'],
    ['explicit http failure', new HttpFailure(400, 'IDEMPOTENCY_KEY_REQUIRED', 'needed'), 400, 'IDEMPOTENCY_KEY_REQUIRED'],
    ['unknown route', new HttpException('x', 404), 404, 'ROUTE_NOT_FOUND'],
    ['malformed body', new HttpException('x', 400), 400, 'VALIDATION_ERROR'],
    ['plain error', new Error('boom'), 500, 'INTERNAL_ERROR'],
    ['non-error throw', 'a string', 500, 'INTERNAL_ERROR'],
  ])('%s → %i %s', (_name, error, status, failureCode) => {
    const mapped = mapError(error);

    expect(mapped.status).toBe(status);
    expect(mapped.body.failureCode).toBe(failureCode);
    expect(mapped.retryAfter).toBeUndefined();
  });

  test('a Zod error becomes 400 with the offending paths in details', () => {
    const result = z.object({ money: z.object({ amount: z.string().regex(/^\d+\.\d{2}$/) }) }).safeParse({ money: { amount: '25' } });

    const mapped = mapError(result.error);

    expect(mapped.status).toBe(400);
    expect(mapped.body.failureCode).toBe('VALIDATION_ERROR');
    expect(mapped.body.details).toEqual([{ path: 'money.amount', message: expect.any(String) }]);
  });

  test.each([
    ['concurrency conflict', new ConcurrencyConflictError(4), 'CONCURRENCY_CONFLICT'],
    ['raw lock timeout', sqlError('55P03'), 'CONCURRENCY_CONFLICT'],
    ['deadlock', sqlError('40P01'), 'CONCURRENCY_CONFLICT'],
    ['connection refused', sqlError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'), 'DEPENDENCY_UNAVAILABLE'],
    ['database shutting down', sqlError('57P01'), 'DEPENDENCY_UNAVAILABLE'],
    ['connection class 08', sqlError('08006'), 'DEPENDENCY_UNAVAILABLE'],
    ['too many connections', sqlError('53300'), 'DEPENDENCY_UNAVAILABLE'],
    ['sqs timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'DEPENDENCY_UNAVAILABLE'],
    ['aws error with metadata', Object.assign(new Error('x'), { $metadata: { httpStatusCode: 503 } }), 'DEPENDENCY_UNAVAILABLE'],
    ['wrapped cause', new Error('outer', { cause: sqlError('ECONNRESET') }), 'DEPENDENCY_UNAVAILABLE'],
    ['connection text only', new Error('Connection terminated unexpectedly'), 'DEPENDENCY_UNAVAILABLE'],
  ])('%s → 503 %s with Retry-After: 1 (API-03)', (_name, error, failureCode) => {
    const mapped = mapError(error);

    expect(mapped.status).toBe(503);
    expect(mapped.body.failureCode).toBe(failureCode);
    expect(mapped.retryAfter).toBe(1);
  });

  test('an optimistic lock error is not mapped to a 503 by itself: the retry layer owns it', () => {
    expect(mapError(new OptimisticLockError('w', 1)).status).toBe(500);
  });

  test('a unique violation that reaches the edge is a 500, never a conflict guess', () => {
    expect(mapError(sqlError('23505', 'duplicate key value violates unique constraint "x"')).status).toBe(500);
  });
});

describe('error bodies never expose internals (API-02)', () => {
  test.each([
    ['sql text', new Error('insert into wallets (id) values ($1) -- password=hunter2')],
    ['stack', Object.assign(new Error('boom'), { stack: 'Error: boom\n    at /srv/app/secret.ts:10:5' })],
    ['connection string', new Error('postgres://wagering:hunter2@db:5432/x refused')],
  ])('an unexpected error with %s is replaced by a generic body', (_name, error) => {
    const serialized = JSON.stringify(mapError(error).body);

    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret.ts');
    expect(serialized).not.toContain('insert into');
    expect(mapError(error).body).toEqual({ failureCode: 'INTERNAL_ERROR', message: 'Unexpected error' });
  });

  test('the body has exactly failureCode and message, plus details only when present', () => {
    expect(Object.keys(mapError(new WalletNotFoundError('w')).body).sort()).toEqual(['failureCode', 'message']);
  });
});

describe('isDependencyFailure', () => {
  test('is false for business and unexpected errors', () => {
    expect(isDependencyFailure(new WalletNotFoundError('w'))).toBe(false);
    expect(isDependencyFailure(new Error('boom'))).toBe(false);
    expect(isDependencyFailure(undefined)).toBe(false);
  });
});
