import type { INestApplication } from '@nestjs/common';
import { createApp } from './app.factory';
import type { AppConfig } from './config/env';
import { OutboxPublisher } from './messaging/outbox-publisher';
import { PendingReferenceWorker } from './messaging/pending-reference-worker';
import { SqsConsumer } from './messaging/sqs-consumer';

export interface RunningApplication {
  /** `undefined` when the HTTP runner is switched off. */
  readonly httpPort: number | undefined;
  /** The background runners this instance started, by name. */
  readonly runners: readonly string[];
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

  // Background runners. Stopped in this order on shutdown: stop taking work first, then stop the producers.
  const stoppable: { name: string; stop: () => Promise<void> }[] = [];
  if (config.runners.sqsConsumer) {
    const consumer = app.get(SqsConsumer);
    consumer.start();
    stoppable.push({ name: 'sqs-consumer', stop: () => consumer.stop() });
  }
  if (config.runners.pendingWorker) {
    const worker = app.get(PendingReferenceWorker);
    worker.start();
    stoppable.push({ name: 'pending-worker', stop: () => worker.stop() });
  }
  if (config.runners.outboxPublisher) {
    const publisher = app.get(OutboxPublisher);
    publisher.start();
    stoppable.push({ name: 'outbox-publisher', stop: () => publisher.stop() });
  }

  return {
    httpPort,
    runners: stoppable.map((runner) => runner.name),
    app,
    async stop() {
      for (const runner of stoppable) {
        await runner.stop();
      }
      await app.close();
    },
  };
}
