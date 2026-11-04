import { type LoggerPort, NoopLogger } from '../../application/ports';
import { safeDetail } from '../health/dependency-probes';

/**
 * Runs `tick` again and again, `intervalMs` after the previous one finished (never overlapping itself).
 * A failing tick is logged and the loop goes on: a runner must survive a database or queue outage.
 * `stop()` resolves after the tick in progress, if any, has finished.
 */
export class PollingLoop {
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<void>,
    private readonly logger: LoggerPort = new NoopLogger(),
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.current = this.loop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.current;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        this.logger.error(`${this.name} tick failed`, { errorName: (error as Error)?.name, errorMessage: safeDetail(error) });
      }
      if (!this.running) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }
}
