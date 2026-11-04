import { GetQueueUrlCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

export interface DependencyProbe {
  readonly name: 'postgres' | 'sqs';
  /** Resolves when the dependency answers; rejects with a short, safe description otherwise. */
  check(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 2000;

async function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not answer within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The text a probe reports. Names and codes only: never a connection string, credential or stack. */
export function safeDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const label = typeof code === 'string' ? code : error.name;
    return `${label}: ${error.message.split('\n')[0]?.replace(/\/\/[^@\s/]*@/g, '//***@') ?? ''}`.slice(0, 200);
  }
  return 'unknown error';
}

export class PostgresProbe implements DependencyProbe {
  readonly name = 'postgres';

  constructor(private readonly orm: MikroORM) {}

  async check(): Promise<void> {
    // MikroORM 7 connects on demand, so only a real query proves the database answers.
    await withTimeout(this.orm.em.fork().execute('select 1'), 'postgres');
  }
}

export class SqsProbe implements DependencyProbe {
  readonly name = 'sqs';

  constructor(
    private readonly client: SQSClient,
    private readonly queues: readonly string[],
  ) {}

  async check(): Promise<void> {
    const failures: string[] = [];
    await Promise.all(
      this.queues.map(async (queue) => {
        try {
          await withTimeout(this.client.send(new GetQueueUrlCommand({ QueueName: queue })), queue);
        } catch (error) {
          failures.push(`${queue}: ${safeDetail(error)}`);
        }
      }),
    );
    if (failures.length > 0) {
      throw new Error(failures.sort().join('; '));
    }
  }
}
