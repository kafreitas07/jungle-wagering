import type { MikroORM } from '@mikro-orm/postgresql';
import { OpenWallet } from '../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction';
import type { SqsAdapter } from '../../src/infrastructure/messaging/sqs.adapter';
import { FakeClock, testUnitOfWork } from './context';
import { sql, uuid } from './sql';

export interface TestWallet {
  readonly id: string;
  readonly playerId: string;
}

export const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

export async function newWallet(orm: MikroORM, balance = '1000.00', clock = new FakeClock()): Promise<TestWallet> {
  const wallet = await new OpenWallet({ unitOfWork: testUnitOfWork(orm), clock }).execute({
    playerId: uuid(),
    initialBalance: { amount: balance, currency: 'BRL' },
  });
  return { id: wallet.id, playerId: wallet.playerId };
}

export function submitUseCase(orm: MikroORM, clock = new FakeClock()): SubmitWagerTransaction {
  return new SubmitWagerTransaction({ unitOfWork: testUnitOfWork(orm), clock, referencePolicy: policy });
}

/** A `WagerTransactionRequested` message with fresh ids; `data` and the envelope can be overridden. */
export function wagerMessage(
  wallet: TestWallet,
  overrides: { messageId?: string; data?: Record<string, unknown>; envelope?: Record<string, unknown> } = {},
) {
  const n = uuid();
  return {
    messageId: overrides.messageId ?? `msg-${n}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: `provider-${n}`,
      externalTransactionId: `ext-${n}`,
      idempotencyKey: `key-${n}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${n}`,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides.data,
    },
    ...overrides.envelope,
  };
}

export async function sendMessage(adapter: SqsAdapter, queue: string, body: unknown, groupId: string): Promise<void> {
  await adapter.send(queue, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    groupId,
    deduplicationId: uuid(),
  });
}

export const transactionsOf = async (orm: MikroORM, externalTransactionId: string) =>
  sql(orm, 'select id, status, failure_code, balance_after::text as balance_after from wager_transactions where external_transaction_id = ?', [
    externalTransactionId,
  ]);

export const countFor = async (orm: MikroORM, table: 'wager_transactions' | 'wallet_ledger_entries', walletId: string, extra = ''): Promise<number> =>
  Number((await sql(orm, `select count(*)::int as n from ${table} where wallet_id = ? ${extra}`, [walletId]))[0]?.n);

export const balanceOf = async (orm: MikroORM, walletId: string): Promise<string> =>
  String((await sql(orm, 'select balance::text as balance from wallets where id = ?', [walletId]))[0]?.balance);

/** Polls `condition` until it holds or `ms` passes; returns whether it held. */
export async function waitFor(condition: () => Promise<boolean> | boolean, ms = 15_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) {
      return true;
    }
    await Bun.sleep(50);
  }
  return false;
}
