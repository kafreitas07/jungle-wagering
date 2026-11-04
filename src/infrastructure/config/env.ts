import { z } from 'zod';

const boolean = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z
  .object({
  NODE_ENV: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_PORT: positiveInt(3100),
  DATABASE_URL: z.string().min(1),

  AWS_REGION: z.string().min(1).default('us-east-1'),
  // Absent on real AWS; set to the LocalStack endpoint locally.
  SQS_ENDPOINT: z.string().min(1).optional(),
  SQS_WAGER_QUEUE: z.string().min(1).default('wager-transactions.fifo'),
  SQS_WAGER_DLQ: z.string().min(1).default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().min(1).default('wallet-events.fifo'),

  RUN_HTTP: boolean(true),
  RUN_SQS_CONSUMER: boolean(true),
  RUN_OUTBOX_PUBLISHER: boolean(true),
  RUN_PENDING_WORKER: boolean(true),

  DB_POOL_MAX: positiveInt(20),
  LOCK_TIMEOUT_MS: positiveInt(2000),

  PENDING_REF_MAX_ATTEMPTS: positiveInt(10),
  PENDING_REF_BASE_DELAY_MS: positiveInt(1000),
  PENDING_REF_FACTOR: positiveInt(2),
  PENDING_REF_MAX_DELAY_MS: positiveInt(300_000),

  OUTBOX_HIGH_ATTEMPTS_THRESHOLD: positiveInt(10),
  OUTBOX_POLL_INTERVAL_MS: positiveInt(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(25),
  OUTBOX_LEASE_MS: positiveInt(30_000),

  SQS_POLL_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_RECEIVE_COUNT: positiveInt(5),
  SQS_SHUTDOWN_GRACE_MS: positiveInt(20_000),

  PENDING_WORKER_INTERVAL_MS: positiveInt(1000),
  PENDING_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),

  // Test-only crash point. Never set outside tests.
  FAULT_INJECTION: z.enum(['crash-after-commit-before-ack']).optional(),
  })
  .superRefine((env, ctx) => {
    // The crash point kills the process on purpose. A deployment that sets it by mistake must not start.
    if (env.FAULT_INJECTION !== undefined && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['FAULT_INJECTION'],
        message: `is a test-only crash point and requires NODE_ENV=test (NODE_ENV is "${env.NODE_ENV ?? 'unset'}"); refusing to start`,
      });
    }
  });

export interface AppConfig {
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  readonly database: {
    readonly url: string;
    readonly poolMax: number;
    readonly lockTimeoutMs: number;
  };
  readonly sqs: {
    readonly region: string;
    readonly endpoint: string | undefined;
    readonly wagerQueue: string;
    readonly wagerDlq: string;
    readonly eventsQueue: string;
    readonly consumer: {
      readonly pollWaitSeconds: number;
      /** The redrive policy's maxReceiveCount: after this many receives the queue moves the message to the DLQ. */
      readonly maxReceiveCount: number;
      readonly shutdownGraceMs: number;
    };
  };
  readonly runners: {
    readonly http: boolean;
    readonly sqsConsumer: boolean;
    readonly outboxPublisher: boolean;
    readonly pendingWorker: boolean;
  };
  readonly pendingReference: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly factor: number;
    readonly maxDelayMs: number;
  };
  readonly outbox: {
    readonly highAttemptsThreshold: number;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
  };
  readonly pendingWorker: {
    readonly intervalMs: number;
    readonly batchSize: number;
  };
  readonly faultInjection: 'crash-after-commit-before-ack' | undefined;
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadEnv(source: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }
  const env = parsed.data;

  return {
    port: env.APP_PORT,
    database: {
      url: env.DATABASE_URL,
      poolMax: env.DB_POOL_MAX,
      lockTimeoutMs: env.LOCK_TIMEOUT_MS,
    },
    sqs: {
      region: env.AWS_REGION,
      endpoint: env.SQS_ENDPOINT,
      wagerQueue: env.SQS_WAGER_QUEUE,
      wagerDlq: env.SQS_WAGER_DLQ,
      eventsQueue: env.SQS_EVENTS_QUEUE,
      consumer: {
        pollWaitSeconds: env.SQS_POLL_WAIT_SECONDS,
        maxReceiveCount: env.SQS_MAX_RECEIVE_COUNT,
        shutdownGraceMs: env.SQS_SHUTDOWN_GRACE_MS,
      },
    },
    runners: {
      http: env.RUN_HTTP,
      sqsConsumer: env.RUN_SQS_CONSUMER,
      outboxPublisher: env.RUN_OUTBOX_PUBLISHER,
      pendingWorker: env.RUN_PENDING_WORKER,
    },
    pendingReference: {
      maxAttempts: env.PENDING_REF_MAX_ATTEMPTS,
      baseDelayMs: env.PENDING_REF_BASE_DELAY_MS,
      factor: env.PENDING_REF_FACTOR,
      maxDelayMs: env.PENDING_REF_MAX_DELAY_MS,
    },
    outbox: {
      highAttemptsThreshold: env.OUTBOX_HIGH_ATTEMPTS_THRESHOLD,
      pollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      batchSize: env.OUTBOX_BATCH_SIZE,
      leaseMs: env.OUTBOX_LEASE_MS,
    },
    pendingWorker: {
      intervalMs: env.PENDING_WORKER_INTERVAL_MS,
      batchSize: env.PENDING_WORKER_BATCH_SIZE,
    },
    faultInjection: env.FAULT_INJECTION,
    logLevel: env.LOG_LEVEL,
  };
}
