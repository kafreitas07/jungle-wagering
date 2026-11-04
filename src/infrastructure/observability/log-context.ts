import { AsyncLocalStorage } from 'node:async_hooks';

/** The ids that follow one unit of work (an HTTP request, a queue message, a pending transaction) through every log line. */
export interface LogScope {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: string | undefined;
}

const storage = new AsyncLocalStorage<LogScope>();

/** Runs `work` with `scope` merged over the enclosing scope. Concurrent runs never see each other's ids. */
export function runWithLogScope<T>(scope: LogScope, work: () => T): T {
  return storage.run({ ...storage.getStore(), ...scope }, work);
}

export function currentLogScope(): Readonly<LogScope> {
  return storage.getStore() ?? {};
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
