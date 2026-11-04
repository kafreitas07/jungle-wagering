import type { INestApplication } from '@nestjs/common';
import { createApp } from './app.factory';
import type { AppConfig } from './config/env';

export interface RunningApplication {
  /** `undefined` when the HTTP runner is switched off. */
  readonly httpPort: number | undefined;
  readonly app: INestApplication;
  stop(): Promise<void>;
}

/**
 * Starts the runners the configuration enables. Every instance runs the same image; which parts it runs is
 * decided only by the environment (RUN_HTTP, RUN_SQS_CONSUMER, RUN_OUTBOX_PUBLISHER, RUN_PENDING_WORKER).
 */
export async function startApplication(config: AppConfig): Promise<RunningApplication> {
  const app = await createApp(config);
  let httpPort: number | undefined;
  if (config.runners.http) {
    await app.listen(config.port);
    httpPort = config.port;
  }
  return { httpPort, app, stop: () => app.close() };
}
