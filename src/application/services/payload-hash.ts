import { createHash } from 'node:crypto';
import type { MoneyProps } from '../../domain/money/money';
import type { WagerKind } from '../../domain/wager/wager-transaction';

/** The business fields of an operation. The same for an HTTP request and an SQS message. */
export interface PayloadHashInput {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
}

/** JSON with keys sorted recursively and no whitespace. Strings stay UTF-8; `undefined` fields are omitted. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

/**
 * SHA-256 (hex) of the canonical JSON of the business fields. Metadata such as the
 * idempotency key, the message id or timestamps is not part of the payload.
 */
export function payloadHash(input: PayloadHashInput): string {
  const payload = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
