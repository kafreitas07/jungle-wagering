import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { ConfigError, ENV_VARIABLES, loadEnv } from '../../../src/infrastructure/config/env';

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

describe('messaging settings', () => {
  test('defaults: outbox 500 ms / 25 rows / 30 s lease, consumer 20 s long poll / 5 receives / 20 s grace, worker 1 s', () => {
    const config = loadEnv(base);

    expect(config.outbox).toEqual({ highAttemptsThreshold: 10, pollIntervalMs: 500, batchSize: 25, leaseMs: 30000 });
    expect(config.sqs.consumer).toEqual({ pollWaitSeconds: 20, maxReceiveCount: 5, shutdownGraceMs: 20000 });
    expect(config.pendingWorker).toEqual({ intervalMs: 1000, batchSize: 20 });
    expect(config.faultInjection).toBeUndefined();
  });

  test('every value can be overridden by the environment', () => {
    const config = loadEnv({
      ...base,
      OUTBOX_POLL_INTERVAL_MS: '50',
      OUTBOX_BATCH_SIZE: '10',
      OUTBOX_LEASE_MS: '5000',
      SQS_POLL_WAIT_SECONDS: '1',
      SQS_MAX_RECEIVE_COUNT: '3',
      SQS_SHUTDOWN_GRACE_MS: '1000',
      PENDING_WORKER_INTERVAL_MS: '100',
      PENDING_WORKER_BATCH_SIZE: '5',
      NODE_ENV: 'test',
      FAULT_INJECTION: 'crash-after-commit-before-ack',
    });

    expect(config.outbox).toMatchObject({ pollIntervalMs: 50, batchSize: 10, leaseMs: 5000 });
    expect(config.sqs.consumer).toEqual({ pollWaitSeconds: 1, maxReceiveCount: 3, shutdownGraceMs: 1000 });
    expect(config.pendingWorker).toEqual({ intervalMs: 100, batchSize: 5 });
    expect(config.faultInjection).toBe('crash-after-commit-before-ack');
  });

  test.each([
    ['SQS_POLL_WAIT_SECONDS', '21'],
    ['OUTBOX_BATCH_SIZE', '0'],
    ['OUTBOX_BATCH_SIZE', '101'],
    ['PENDING_WORKER_BATCH_SIZE', '0'],
    ['FAULT_INJECTION', 'explode'],
  ])('rejects %s=%s and names the variable', (name, value) => {
    expect(() => loadEnv({ ...base, [name]: value })).toThrow(new RegExp(name));
  });

  test('a long poll of 0 seconds (short polling) is allowed', () => {
    expect(loadEnv({ ...base, SQS_POLL_WAIT_SECONDS: '0' }).sqs.consumer.pollWaitSeconds).toBe(0);
  });
});

describe('FAULT_INJECTION is allowed only under NODE_ENV=test', () => {
  const crash = 'crash-after-commit-before-ack';

  test('refuses to start when it is set and NODE_ENV is production, naming both variables', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production', FAULT_INJECTION: crash })).toThrow(/FAULT_INJECTION[\s\S]*NODE_ENV=test[\s\S]*production/);
  });

  test('refuses to start when it is set and NODE_ENV is absent', () => {
    expect(() => loadEnv({ ...base, FAULT_INJECTION: crash })).toThrow(/FAULT_INJECTION[\s\S]*unset/);
  });

  test('refuses development too: only "test" opens the crash point', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'development', FAULT_INJECTION: crash })).toThrow(ConfigError);
  });

  test('is accepted under NODE_ENV=test', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'test', FAULT_INJECTION: crash }).faultInjection).toBe(crash);
  });

  test('absent, it never matters what NODE_ENV is', () => {
    expect(loadEnv({ ...base, NODE_ENV: 'production' }).faultInjection).toBeUndefined();
    expect(loadEnv(base).faultInjection).toBeUndefined();
  });

  test('an invalid value is still reported as invalid', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'test', FAULT_INJECTION: 'explode' })).toThrow(/FAULT_INJECTION/);
  });
});

describe('.env.example', () => {
  const text = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const documented = (name: string) => new RegExp(`^#? ?${name}=`, 'm').test(text);
  const active = Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );

  test('lists every variable the application reads', () => {
    expect(ENV_VARIABLES.filter((name) => !documented(name))).toEqual([]);
  });

  test('every active line is a variable the application knows (no stale names)', () => {
    const known = new Set([...ENV_VARIABLES, 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    expect(Object.keys(active).filter((name) => !known.has(name))).toEqual([]);
  });

  test('loads as it is, and gives the defaults the code documents', () => {
    const config = loadEnv(active);

    expect(config.port).toBe(3100);
    expect(config.outbox.batchSize).toBe(25);
    expect(config.faultInjection).toBeUndefined();
    expect(config.runners).toEqual({ http: true, sqsConsumer: true, outboxPublisher: true, pendingWorker: true });
  });

  test('keeps the test-only variables commented out, so a copied .env cannot arm the crash point', () => {
    expect(Object.keys(active)).not.toContain('FAULT_INJECTION');
    expect(Object.keys(active)).not.toContain('NODE_ENV');
  });
});
