import type { ApiResponse } from './app';
import { api } from './app';
import { uuid } from './sql';

export interface CreatedWallet {
  readonly id: string;
  readonly playerId: string;
}

export async function createWallet(url: string, amount = '1000.00', currency = 'BRL'): Promise<CreatedWallet> {
  const playerId = uuid();
  const response = await api(url, 'POST', '/wallets', { body: { playerId, initialBalance: { amount, currency } } });
  if (response.status !== 201) {
    throw new Error(`could not create wallet: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return { id: response.body.id, playerId };
}

/** A submission body with fresh ids, so no test depends on another one's data. */
export function submission(wallet: CreatedWallet, overrides: Record<string, unknown> = {}) {
  const n = uuid();
  return {
    providerId: `provider-${n}`,
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${n}`,
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** `key` omitted → a fresh idempotency key; `null` → no Idempotency-Key header at all. */
export const post = (url: string, body: unknown, key?: string | null, headers: Record<string, string> = {}): Promise<ApiResponse> =>
  api(url, 'POST', '/wagering/transactions', {
    body,
    headers: { ...(key === null ? {} : { 'idempotency-key': key ?? `key-${uuid()}` }), ...headers },
  });
