import { describe, expect, test } from 'bun:test';
import { moneyInputSchema } from '../../../src/infrastructure/contracts/money.contract';
import {
  submitWagerTransactionSchema,
  wagerTransactionRequestedSchema,
} from '../../../src/infrastructure/contracts/wager.contract';
import {
  createWalletSchema,
  encodeLedgerCursor,
  ledgerQuerySchema,
} from '../../../src/infrastructure/contracts/wallet.contract';

const playerId = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';

const bet = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId,
  walletId,
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET' as const,
  money: { amount: '25.00', currency: 'BRL' },
};

const message = {
  messageId: 'msg-123',
  type: 'WagerTransactionRequested' as const,
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: { ...bet, idempotencyKey: 'provider-a:transaction-123' },
};

const paths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('money input (MON-08)', () => {
  test('accepts an amount with exactly 2 decimals', () => {
    expect(moneyInputSchema.parse({ amount: '25.00', currency: 'BRL' })).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  test.each(['25', '25.5', '-1.00', '1e3', '', '25.000', ' 25.00', '+25.00', '25,00', 'abc', '.50', '25.'])(
    'rejects amount %p',
    (amount) => {
      expect(moneyInputSchema.safeParse({ amount, currency: 'BRL' }).success).toBe(false);
    },
  );

  test('accepts 18 integer digits and rejects 19', () => {
    expect(moneyInputSchema.safeParse({ amount: '999999999999999999.99', currency: 'BRL' }).success).toBe(true);
    expect(moneyInputSchema.safeParse({ amount: '1000000000000000000.00', currency: 'BRL' }).success).toBe(false);
  });

  test('rejects an amount that is not a string', () => {
    expect(moneyInputSchema.safeParse({ amount: 25, currency: 'BRL' }).success).toBe(false);
  });

  test.each(['brl', 'BR', 'BRLL', '', 'B1L'])('rejects currency %p', (currency) => {
    expect(moneyInputSchema.safeParse({ amount: '1.00', currency }).success).toBe(false);
  });
});

describe('submit transaction body (TXN-05, TXN-06, TXN-13, TXN-14)', () => {
  test('accepts the documented BET', () => {
    expect(submitWagerTransactionSchema.parse(bet)).toEqual(bet);
  });

  test.each(['BET', 'WIN', 'LOSS'])('accepts kind %s without a reference', (kind) => {
    expect(submitWagerTransactionSchema.safeParse({ ...bet, kind }).success).toBe(true);
  });

  test.each(['WIN', 'LOSS'])('accepts an optional reference on %s', (kind) => {
    expect(
      submitWagerTransactionSchema.safeParse({ ...bet, kind, referenceExternalTransactionId: 'bet-1' }).success,
    ).toBe(true);
  });

  test('rejects the internal kind OPENING', () => {
    const result = submitWagerTransactionSchema.safeParse({ ...bet, kind: 'OPENING' });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('kind');
  });

  test('rejects an unknown kind', () => {
    expect(submitWagerTransactionSchema.safeParse({ ...bet, kind: 'DEPOSIT' }).success).toBe(false);
  });

  test('rejects the reserved provider id "internal"', () => {
    const result = submitWagerTransactionSchema.safeParse({ ...bet, providerId: 'internal' });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('providerId');
  });

  test.each(['REFUND', 'ROLLBACK'])('%s without a reference is rejected', (kind) => {
    const result = submitWagerTransactionSchema.safeParse({ ...bet, kind });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('referenceExternalTransactionId');
  });

  test.each(['REFUND', 'ROLLBACK'])('%s with a reference is accepted', (kind) => {
    expect(
      submitWagerTransactionSchema.safeParse({ ...bet, kind, referenceExternalTransactionId: 'bet-1' }).success,
    ).toBe(true);
  });

  test('an empty reference is rejected', () => {
    expect(
      submitWagerTransactionSchema.safeParse({ ...bet, kind: 'REFUND', referenceExternalTransactionId: '' }).success,
    ).toBe(false);
  });

  test.each(['BET', 'WIN'])('%s of 0.00 is rejected', (kind) => {
    const result = submitWagerTransactionSchema.safeParse({ ...bet, kind, money: { amount: '0.00', currency: 'BRL' } });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('money.amount');
  });

  test.each(['REFUND', 'ROLLBACK'])('%s of 0.00 is rejected', (kind) => {
    const result = submitWagerTransactionSchema.safeParse({
      ...bet,
      kind,
      referenceExternalTransactionId: 'bet-1',
      money: { amount: '0.00', currency: 'BRL' },
    });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('money.amount');
  });

  test.each(['00.00', '000000000000000000.00'])('zero with leading zeros (%s) is still zero for a BET', (amount) => {
    const result = submitWagerTransactionSchema.safeParse({ ...bet, money: { amount, currency: 'BRL' } });

    expect(result.success).toBe(false);
    expect(paths(result)).toContain('money.amount');
  });

  test('a LOSS of 0.00 is accepted', () => {
    expect(
      submitWagerTransactionSchema.safeParse({ ...bet, kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }).success,
    ).toBe(true);
  });

  test.each(['playerId', 'walletId'])('%s must be a UUID', (field) => {
    expect(submitWagerTransactionSchema.safeParse({ ...bet, [field]: 'not-a-uuid' }).success).toBe(false);
  });

  test.each(['providerId', 'externalTransactionId', 'roundId', 'gameId'])('%s must not be empty', (field) => {
    expect(submitWagerTransactionSchema.safeParse({ ...bet, [field]: '' }).success).toBe(false);
  });

  test('fields outside the business payload are dropped', () => {
    const parsed = submitWagerTransactionSchema.parse({ ...bet, traceId: 'abc' });

    expect(parsed).toEqual(bet);
    expect('traceId' in parsed).toBe(false);
  });
});

describe('identifier length limit (255 characters)', () => {
  // Unbounded identifiers would overflow the unique indexes in the database and surface as a 500.
  const at255 = 'a'.repeat(255);
  const at256 = 'a'.repeat(256);

  test.each(['providerId', 'externalTransactionId', 'roundId', 'gameId'])('HTTP %s: 255 accepted, 256 rejected', (field) => {
    expect(submitWagerTransactionSchema.safeParse({ ...bet, [field]: at255 }).success).toBe(true);

    const result = submitWagerTransactionSchema.safeParse({ ...bet, [field]: at256 });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain(field);
  });

  test('HTTP referenceExternalTransactionId: 255 accepted, 256 rejected', () => {
    const refund = { ...bet, kind: 'REFUND' as const };

    expect(submitWagerTransactionSchema.safeParse({ ...refund, referenceExternalTransactionId: at255 }).success).toBe(true);

    const result = submitWagerTransactionSchema.safeParse({ ...refund, referenceExternalTransactionId: at256 });
    expect(result.success).toBe(false);
    expect(paths(result)).toContain('referenceExternalTransactionId');
  });

  test.each(['providerId', 'externalTransactionId', 'roundId', 'gameId', 'idempotencyKey'])(
    'SQS data.%s: 255 accepted, 256 rejected',
    (field) => {
      const withData = (value: string) => ({ ...message, data: { ...message.data, [field]: value } });

      expect(wagerTransactionRequestedSchema.safeParse(withData(at255)).success).toBe(true);

      const result = wagerTransactionRequestedSchema.safeParse(withData(at256));
      expect(result.success).toBe(false);
      expect(paths(result)).toContain(`data.${field}`);
    },
  );

  test('SQS messageId: 255 accepted, 256 rejected (it becomes the inbox primary key)', () => {
    const withMessageId = (messageId: string) => ({ ...message, messageId });

    expect(wagerTransactionRequestedSchema.safeParse(withMessageId(`m${'a'.repeat(254)}`)).success).toBe(true);

    const result = wagerTransactionRequestedSchema.safeParse(withMessageId('a'.repeat(256)));
    expect(result.success).toBe(false);
    expect(paths(result)).toContain('messageId');
  });

  test('SQS data.referenceExternalTransactionId: 255 accepted, 256 rejected', () => {
    const refund = { ...message, data: { ...message.data, kind: 'REFUND' as const } };
    const withReference = (value: string) => ({ ...refund, data: { ...refund.data, referenceExternalTransactionId: value } });

    expect(wagerTransactionRequestedSchema.safeParse(withReference(at255)).success).toBe(true);
    expect(wagerTransactionRequestedSchema.safeParse(withReference(at256)).success).toBe(false);
  });
});

describe('SQS message WagerTransactionRequested (SQS-01, SQS-08)', () => {
  test('accepts the documented message', () => {
    expect(wagerTransactionRequestedSchema.parse(message)).toEqual(message);
  });

  test('the idempotency key travels in the data', () => {
    const { idempotencyKey: _removed, ...data } = message.data;

    expect(wagerTransactionRequestedSchema.safeParse({ ...message, data }).success).toBe(false);
    expect(
      wagerTransactionRequestedSchema.safeParse({ ...message, data: { ...message.data, idempotencyKey: '' } }).success,
    ).toBe(false);
  });

  test('only the WagerTransactionRequested type is accepted', () => {
    expect(wagerTransactionRequestedSchema.safeParse({ ...message, type: 'Other' }).success).toBe(false);
  });

  test('requires a message id and a valid timestamp', () => {
    expect(wagerTransactionRequestedSchema.safeParse({ ...message, messageId: '' }).success).toBe(false);
    expect(wagerTransactionRequestedSchema.safeParse({ ...message, occurredAt: 'yesterday' }).success).toBe(false);
  });

  test('applies the same business rules as the HTTP body', () => {
    const withData = (changes: Record<string, unknown>) => ({ ...message, data: { ...message.data, ...changes } });

    expect(wagerTransactionRequestedSchema.safeParse(withData({ kind: 'OPENING' })).success).toBe(false);
    expect(wagerTransactionRequestedSchema.safeParse(withData({ providerId: 'internal' })).success).toBe(false);
    expect(wagerTransactionRequestedSchema.safeParse(withData({ money: { amount: '25', currency: 'BRL' } })).success).toBe(false);
    expect(wagerTransactionRequestedSchema.safeParse(withData({ kind: 'REFUND' })).success).toBe(false);
    expect(wagerTransactionRequestedSchema.safeParse(withData({ money: { amount: '0.00', currency: 'BRL' } })).success).toBe(false);
  });
});

describe('create wallet body (WAL-01, WAL-03)', () => {
  const body = { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } };

  test('accepts the documented body', () => {
    expect(createWalletSchema.parse(body)).toEqual(body);
  });

  test('accepts an initial balance of 0.00', () => {
    expect(createWalletSchema.safeParse({ ...body, initialBalance: { amount: '0.00', currency: 'BRL' } }).success).toBe(true);
  });

  test('rejects a negative or badly formatted initial balance', () => {
    expect(createWalletSchema.safeParse({ ...body, initialBalance: { amount: '-1.00', currency: 'BRL' } }).success).toBe(false);
    expect(createWalletSchema.safeParse({ ...body, initialBalance: { amount: '10', currency: 'BRL' } }).success).toBe(false);
  });

  test('rejects a playerId that is not a UUID', () => {
    expect(createWalletSchema.safeParse({ ...body, playerId: 'player-1' }).success).toBe(false);
  });
});

describe('ledger query (LEDG-06)', () => {
  test('defaults to 50 entries and starts from the newest', () => {
    expect(ledgerQuerySchema.parse({})).toEqual({ limit: 50 });
  });

  test.each([
    ['1', 1],
    ['50', 50],
    ['200', 200],
  ])('accepts limit %s', (limit, expected) => {
    expect(ledgerQuerySchema.parse({ limit }).limit).toBe(expected);
  });

  test.each(['0', '201', '-1', '1.5', 'abc', ''])('rejects limit %p', (limit) => {
    expect(ledgerQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  test('decodes the opaque cursor into the wallet version to continue from', () => {
    const cursor = encodeLedgerCursor(42);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ledgerQuerySchema.parse({ cursor, limit: '10' })).toEqual({ beforeVersion: 42, limit: 10 });
  });

  test.each([
    ['not base64 json', '!!!'],
    ['empty', ''],
    ['version as text', Buffer.from('{"v":"x"}').toString('base64url')],
    ['version zero', Buffer.from('{"v":0}').toString('base64url')],
    ['fractional version', Buffer.from('{"v":1.5}').toString('base64url')],
    ['not an object', Buffer.from('[]').toString('base64url')],
    ['missing version', Buffer.from('{}').toString('base64url')],
  ])('rejects an invalid cursor (%s)', (_name, cursor) => {
    expect(ledgerQuerySchema.safeParse({ cursor }).success).toBe(false);
  });
});
