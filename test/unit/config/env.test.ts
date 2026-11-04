import { describe, expect, test } from 'bun:test';
import { ConfigError, loadEnv } from '../../../src/infrastructure/config/env';

const base = { DATABASE_URL: 'postgres://wagering:wagering@localhost:5440/wagering_test' };

describe('loadEnv', () => {
  test('applies the design defaults when optional variables are absent', () => {
    const config = loadEnv(base);

    expect(config.database.poolMax).toBe(20);
    expect(config.database.lockTimeoutMs).toBe(2000);
    expect(config.pendingReference).toEqual({
      maxAttempts: 10,
      baseDelayMs: 1000,
      factor: 2,
      maxDelayMs: 300000,
    });
    expect(config.outbox.highAttemptsThreshold).toBe(10);
  });

  test('enables all four runners by default', () => {
    const config = loadEnv(base);

    expect(config.runners).toEqual({
      http: true,
      sqsConsumer: true,
      outboxPublisher: true,
      pendingWorker: true,
    });
  });

  test('disables each runner individually', () => {
    expect(loadEnv({ ...base, RUN_HTTP: 'false' }).runners).toEqual({
      http: false,
      sqsConsumer: true,
      outboxPublisher: true,
      pendingWorker: true,
    });
    expect(loadEnv({ ...base, RUN_SQS_CONSUMER: 'false' }).runners.sqsConsumer).toBe(false);
    expect(loadEnv({ ...base, RUN_OUTBOX_PUBLISHER: 'false' }).runners.outboxPublisher).toBe(false);
    expect(loadEnv({ ...base, RUN_PENDING_WORKER: 'false' }).runners.pendingWorker).toBe(false);
  });

  test('overrides defaults from the environment', () => {
    const config = loadEnv({
      ...base,
      DB_POOL_MAX: '5',
      LOCK_TIMEOUT_MS: '750',
      PENDING_REF_MAX_ATTEMPTS: '3',
    });

    expect(config.database.poolMax).toBe(5);
    expect(config.database.lockTimeoutMs).toBe(750);
    expect(config.pendingReference.maxAttempts).toBe(3);
  });

  test('rejects an invalid boolean and names the variable', () => {
    expect(() => loadEnv({ ...base, RUN_HTTP: 'maybe' })).toThrow(ConfigError);
    expect(() => loadEnv({ ...base, RUN_HTTP: 'maybe' })).toThrow(/RUN_HTTP/);
  });

  test('rejects a negative number and names the variable', () => {
    expect(() => loadEnv({ ...base, DB_POOL_MAX: '-1' })).toThrow(/DB_POOL_MAX/);
  });

  test('rejects a non-numeric number and names the variable', () => {
    expect(() => loadEnv({ ...base, LOCK_TIMEOUT_MS: 'abc' })).toThrow(/LOCK_TIMEOUT_MS/);
  });

  test('rejects a missing DATABASE_URL and names the variable', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  test('reports every invalid variable in a single error', () => {
    expect(() => loadEnv({ ...base, RUN_HTTP: 'maybe', DB_POOL_MAX: '0' })).toThrow(
      /RUN_HTTP[\s\S]*DB_POOL_MAX|DB_POOL_MAX[\s\S]*RUN_HTTP/,
    );
  });
});
