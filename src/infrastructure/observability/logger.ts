import pino from 'pino';
import type { LogContext, LoggerPort } from '../../application/ports';
import { currentLogScope } from './log-context';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Keys that never reach a log line, whatever the caller passes: money, balances, the player and whole payloads.
 * Compared in lower case without separators, so `playerId`, `player_id` and `PlayerID` are the same key.
 */
const FORBIDDEN_KEYS = new Set([
  'amount',
  'money',
  'balance',
  'storedbalance',
  'calculatedbalance',
  'difference',
  'playerid',
  'payload',
  'body',
  'data',
  'headers',
  'authorization',
]);

const normalise = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Copy of `value` without forbidden keys, at any depth. Errors are reduced to name and code. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code;
    return { name: value.name, ...(typeof code === 'string' ? { code } : {}) };
  }
  if (Array.isArray(value)) {
    return depth > 4 ? '[truncated]' : value.map((item) => scrub(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    if (depth > 4) {
      return '[truncated]';
    }
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(normalise(key))) {
        clean[key] = scrub(item, depth + 1);
      }
    }
    return clean;
  }
  return typeof value === 'bigint' ? value.toString() : value;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Anything with `write(line)`; defaults to stdout. Tests pass a collector. */
  readonly destination?: { write(line: string): unknown };
  readonly service?: string;
}

/** JSON logs through pino. Every line carries the ids of the surrounding scope; forbidden keys are dropped. */
export function createLogger(options: LoggerOptions): LoggerPort {
  const base = pino(
    {
      level: options.level,
      base: { service: options.service ?? 'wagering-processor' },
      messageKey: 'message',
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    options.destination ?? pino.destination(1),
  );

  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string, context?: LogContext) => {
    const fields = { ...currentLogScope(), ...(scrub(context ?? {}) as Record<string, unknown>) };
    base[level](fields, message);
  };

  return {
    debug: (message, context) => log('debug', message, context),
    info: (message, context) => log('info', message, context),
    warn: (message, context) => log('warn', message, context),
    error: (message, context) => log('error', message, context),
  };
}
