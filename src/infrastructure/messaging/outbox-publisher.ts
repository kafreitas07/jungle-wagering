import type { LoggerPort } from '../../application/ports';
import type { PublishOutboxBatch } from '../../application/use-cases/publish-outbox-batch';
import { PollingLoop } from './polling-loop';

/**
 * The runner of the outbox: calls `PublishOutboxBatch` in a loop. While a round still finds a full batch it goes
 * straight on to the next, so a backlog drains at the speed of the queue instead of one batch per interval.
 */
export class OutboxPublisher {
  private readonly loop: PollingLoop;

  constructor(
    private readonly useCase: PublishOutboxBatch,
    options: { readonly intervalMs: number; readonly batchSize: number; readonly logger?: LoggerPort },
  ) {
    this.loop = new PollingLoop(
      'outbox publisher',
      options.intervalMs,
      async () => {
        for (;;) {
          const result = await this.useCase.execute();
          if (result.claimed < options.batchSize || result.failed > 0) {
            return;
          }
        }
      },
      options.logger,
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  /** One round, for tests and for draining by hand. */
  runOnce() {
    return this.useCase.execute();
  }
}
