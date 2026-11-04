import { testDatabaseConfig } from './db';
import type { TestQueues } from './queues';

export interface AppProcess {
  readonly url: string;
  readonly proc: ReturnType<typeof Bun.spawn>;
  /** Resolves with the exit code when the process ends (null when killed by a signal). */
  readonly exited: Promise<number | null>;
  kill(signal?: NodeJS.Signals): void;
  /** SIGTERM and wait: the graceful path. */
  stop(): Promise<void>;
}

export function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  void server.stop(true);
  return port;
}

export interface SpawnOptions {
  readonly queues: TestQueues;
  readonly env?: Record<string, string>;
}

async function waitUntilLive(url: string, proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`process exited with ${proc.exitCode} before becoming live`);
    }
    try {
      if ((await fetch(`${url}/health/live`)).status === 200) {
        return;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`process at ${url} did not become live`);
}

/**
 * A real `bun run src/main.ts` against the test database and the given test queues. Short intervals make
 * recovery visible within a test; every runner is on unless `env` says otherwise.
 */
export async function spawnApp(options: SpawnOptions): Promise<AppProcess> {
  const port = freePort();
  const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_PORT: String(port),
      DATABASE_URL: testDatabaseConfig().url,
      SQS_ENDPOINT: 'http://localhost:4566',
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      SQS_WAGER_QUEUE: options.queues.wager,
      SQS_WAGER_DLQ: options.queues.dlq,
      SQS_EVENTS_QUEUE: options.queues.events,
      SQS_POLL_WAIT_SECONDS: '1',
      SQS_SHUTDOWN_GRACE_MS: '5000',
      OUTBOX_POLL_INTERVAL_MS: '100',
      OUTBOX_LEASE_MS: '3000',
      PENDING_WORKER_INTERVAL_MS: '100',
      PENDING_REF_BASE_DELAY_MS: '200',
      ...options.env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitUntilLive(url, proc);
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }
  return {
    url,
    proc,
    exited: proc.exited.then(() => proc.exitCode),
    kill: (signal = 'SIGKILL') => void proc.kill(signal),
    async stop() {
      if (proc.exitCode === null) {
        proc.kill('SIGTERM');
      }
      await proc.exited;
    },
  };
}
