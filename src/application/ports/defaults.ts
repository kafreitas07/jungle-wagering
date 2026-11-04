import type { Clock } from './clock.port';
import type { LoggerPort, MetricsPort } from './observability.port';

/** Default wiring until the real implementations of the observability phase replace them. */
export class NoopMetrics implements MetricsPort {
  increment(): void {}
  observeProcessingDuration(): void {}
}

export class NoopLogger implements LoggerPort {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
