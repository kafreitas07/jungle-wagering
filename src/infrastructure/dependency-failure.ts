import { sqlState } from '../application/services/sql-errors';

const NODE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const DEPENDENCY_ERROR_NAMES = new Set([
  'ConnectionException',
  'ConnectionError',
  'TimeoutError',
  'CredentialsProviderError',
  'UnknownEndpoint',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'QueueDoesNotExist',
]);
const CONNECTION_TEXT = /ECONNREFUSED|ECONNRESET|Connection terminated|Unable to connect|connection timeout|socket hang up/i;

function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let current = error; current instanceof Error && chain.length < 4; current = current.cause) {
    chain.push(current);
  }
  return chain;
}

/**
 * PostgreSQL or SQS could not be reached or went away: the same request may succeed later. Shared by the HTTP error
 * mapper (503) and the background runners (retry instead of giving up on the work).
 */
export function isDependencyFailure(error: unknown): boolean {
  return causeChain(error).some((link) => {
    const code = (link as { code?: unknown }).code;
    const state = sqlState(link);
    return (
      (typeof code === 'string' && NODE_NETWORK_CODES.has(code)) ||
      (state !== undefined && (state.startsWith('08') || ['57P01', '57P02', '57P03', '53300'].includes(state))) ||
      DEPENDENCY_ERROR_NAMES.has((link as Error).name) ||
      (link as { $metadata?: unknown }).$metadata !== undefined ||
      CONNECTION_TEXT.test((link as Error).message)
    );
  });
}
