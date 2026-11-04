import { z } from 'zod';

const boolean = (fallback: boolean) =>
  z
    .enum(['true', 'false'])
    .default(fallback ? 'true' : 'false')
    .transform((value) => value === 'true');

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z.object({
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
});

export interface AppConfig {
  readonly port: number;
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
  };
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
    },
  };
}
