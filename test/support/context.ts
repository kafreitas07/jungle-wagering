import type { MikroORM } from '@mikro-orm/postgresql';
import type { Clock, Labels, LogContext, LoggerPort, MetricsPort } from '../../src/application/ports';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/unit-of-work';
import { sql } from './sql';

/** A clock the test can move. */
export class FakeClock implements Clock {
  constructor(private current = new Date('2026-11-03T12:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function testUnitOfWork(orm: MikroORM, lockTimeoutMs = 2000): MikroOrmUnitOfWork {
  return new MikroOrmUnitOfWork(orm, { lockTimeoutMs });
}

export const outboxEventTypes = async (orm: MikroORM, walletId: string): Promise<string[]> =>
  (await sql(orm, `select event_type from outbox_messages where aggregate_id = ? order by occurred_at, id`, [walletId])).map((row) =>
    String(row.event_type),
  );

export class RecordingMetrics implements MetricsPort {
  readonly counts: { metric: string; labels: Labels | undefined }[] = [];

  increment(metric: string, labels?: Labels): void {
    this.counts.push({ metric, labels });
  }

  observeProcessingDuration(): void {}

  total(metric: string): number {
    return this.counts.filter((entry) => entry.metric === metric).length;
  }
}

/**
 * Holds the row lock of a wallet from its own transaction for `ms`. `acquired` resolves once the lock is really
 * held, so a test never races against the holder's start-up; `released` resolves after it commits.
 */
export function holdWalletLock(orm: MikroORM, walletId: string, ms: number): { acquired: Promise<void>; released: Promise<void> } {
  let markAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => {
    markAcquired = resolve;
  });
  const released = testUnitOfWork(orm).run(async (tx) => {
    await tx.wallets.lockById(walletId);
    markAcquired();
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
  return { acquired, released };
}

export class RecordingLogger implements LoggerPort {
  readonly entries: { level: 'debug' | 'info' | 'warn' | 'error'; message: string; context: LogContext | undefined }[] = [];

  debug(message: string, context?: LogContext): void {
    this.entries.push({ level: 'debug', message, context });
  }
  info(message: string, context?: LogContext): void {
    this.entries.push({ level: 'info', message, context });
  }
  warn(message: string, context?: LogContext): void {
    this.entries.push({ level: 'warn', message, context });
  }
  error(message: string, context?: LogContext): void {
    this.entries.push({ level: 'error', message, context });
  }

  at(level: 'debug' | 'info' | 'warn' | 'error') {
    return this.entries.filter((entry) => entry.level === level);
  }
}
