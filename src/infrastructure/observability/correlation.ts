import type { LoggerPort } from '../../application/ports';
import { runWithLogScope } from './log-context';

export const CORRELATION_HEADER = 'x-correlation-id';

/** A caller-chosen id is accepted only if it is short and made of safe characters; anything else is replaced. */
const ACCEPTED = /^[A-Za-z0-9._:-]{1,128}$/;

export function resolveCorrelationId(received: string | string[] | undefined): string {
  const candidate = Array.isArray(received) ? received[0] : received;
  return candidate !== undefined && ACCEPTED.test(candidate) ? candidate : Bun.randomUUIDv7();
}

interface Req {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl?: string;
  url?: string;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): void;
  on(event: 'finish', listener: () => void): unknown;
}

/** Probe and scrape routes hit every few seconds (Docker healthcheck, Prometheus); logging them would drown the real traffic. */
const UNLOGGED_PATHS: ReadonlySet<string> = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Express middleware. Settles the correlation id (received or generated), writes it back on the request, so the
 * controllers forward it to the use cases and from there to the events, and on the response, and runs the rest of the
 * request inside a log scope that carries it. Logs one line per request: method, path without query, status, duration.
 * The health and metrics routes get the id but no request line.
 */
export function correlationMiddleware(logger: LoggerPort) {
  return (req: Req, res: Res, next: () => void): void => {
    const correlationId = resolveCorrelationId(req.headers[CORRELATION_HEADER]);
    req.headers[CORRELATION_HEADER] = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    const started = performance.now();
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';
    if (!UNLOGGED_PATHS.has(path)) {
      res.on('finish', () => {
        runWithLogScope({ correlationId }, () =>
          logger.info('request completed', {
            method: req.method,
            path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          }),
        );
      });
    }
    runWithLogScope({ correlationId }, next);
  };
}
