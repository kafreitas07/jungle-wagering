import { describe, expect, test } from 'bun:test';
import { type PayloadHashInput, canonicalJson, payloadHash } from '../../../src/application/services/payload-hash';

const bet: PayloadHashInput = {
  providerId: 'provider-1',
  externalTransactionId: 'ext-1',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-1',
  gameId: 'game-1',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

const refund: PayloadHashInput = {
  ...bet,
  externalTransactionId: 'ext-2',
  kind: 'REFUND',
  referenceExternalTransactionId: 'ext-1',
};

describe('payloadHash (IDEM-07)', () => {
  // Reference values were computed independently with `sha256sum` over the canonical JSON.
  test('matches the SHA-256 of the canonical JSON for a BET', () => {
    expect(payloadHash(bet)).toBe('75a195a7e9c7aebfaf0675346d19f28cdbcf1f2bebd4d93e6bd87a8e857a1444');
  });

  test('matches the SHA-256 of the canonical JSON for a REFUND, including the reference', () => {
    expect(payloadHash(refund)).toBe('748078a72cc9d4e12d15e7a5217390c9e89bc154d127262767b224997b0b7354');
  });

  test('is 64 lowercase hex characters', () => {
    expect(payloadHash(bet)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not depend on the order of the keys', () => {
    const shuffled: PayloadHashInput = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'game-1',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-1',
    };

    expect(payloadHash(shuffled)).toBe(payloadHash(bet));
  });

  test.each([
    ['providerId', { providerId: 'provider-2' }],
    ['externalTransactionId', { externalTransactionId: 'ext-9' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-2' }],
    ['gameId', { gameId: 'game-2' }],
    ['kind', { kind: 'WIN' as const }],
    ['money.amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['money.currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'ext-0' }],
  ])('changes when %s changes', (_field, change) => {
    expect(payloadHash({ ...bet, ...change })).not.toBe(payloadHash(bet));
  });

  test('ignores metadata that is not part of the business payload', () => {
    const withMetadata = {
      ...bet,
      idempotencyKey: 'key-1',
      messageId: 'message-1',
      occurredAt: '2026-11-03T12:00:00.000Z',
    } as PayloadHashInput;

    expect(payloadHash(withMetadata)).toBe(payloadHash(bet));
  });

  test('an absent reference and an undefined reference hash the same', () => {
    expect(payloadHash({ ...bet, referenceExternalTransactionId: undefined })).toBe(payloadHash(bet));
  });
});

describe('canonicalJson', () => {
  test('sorts keys recursively and emits no whitespace', () => {
    expect(canonicalJson(bet)).toBe(
      '{"externalTransactionId":"ext-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1","providerId":"provider-1","roundId":"round-1","walletId":"wallet-1"}',
    );
  });

  test('keeps non-ASCII text as UTF-8 characters, not escapes', () => {
    expect(canonicalJson({ ...bet, gameId: 'jogo-ação' })).toContain('"gameId":"jogo-ação"');
  });
});
