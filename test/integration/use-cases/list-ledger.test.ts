import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InvalidLedgerQueryError, WalletNotFoundError } from '../../../src/application/errors/application-errors';
import { ListLedger } from '../../../src/application/use-cases/list-ledger';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { ledgerQuerySchema } from '../../../src/infrastructure/contracts/wallet.contract';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, testUnitOfWork } from '../../support/context';
import { uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
let submit: SubmitWagerTransaction;
let listLedger: ListLedger;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  const unitOfWork = testUnitOfWork(orm, 10_000);
  openWallet = new OpenWallet({ unitOfWork, clock });
  submit = new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });
  listLedger = new ListLedger({ unitOfWork });
});

afterAll(async () => {
  await closeTestOrm();
});

const newWallet = (balance = '1000.00') => openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' } });

const bet = (wallet: Wallet) => {
  const n = uuid();
  return submit.execute({
    idempotencyKey: `key-${n}`,
    providerId: 'provider-l',
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '1.00', currency: 'BRL' },
  });
};

/** A wallet whose ledger has `entries` entries: the opening credit plus `entries - 1` bets. */
async function walletWithEntries(entries: number): Promise<Wallet> {
  const wallet = await newWallet('1000.00');
  for (let i = 1; i < entries; i += 1) {
    await bet(wallet);
  }
  return wallet;
}

async function readAll(walletId: string, limit: number): Promise<{ versions: number[][]; cursors: (string | null)[] }> {
  const versions: number[][] = [];
  const cursors: (string | null)[] = [];
  let beforeVersion: number | undefined;
  for (;;) {
    const page = await listLedger.execute({ walletId, limit, ...(beforeVersion === undefined ? {} : { beforeVersion }) });
    versions.push(page.entries.map((entry) => entry.walletVersion));
    cursors.push(page.nextCursor);
    if (page.nextCursor === null) {
      return { versions, cursors };
    }
    beforeVersion = ledgerQuerySchema.parse({ cursor: page.nextCursor, limit: String(limit) }).beforeVersion;
  }
}

describe('ListLedger pagination (LEDG-05, LEDG-06)', () => {
  test('120 entries in pages of 50: 50 + 50 + 20, newest first, no repetition and no gap', async () => {
    const wallet = await walletWithEntries(120);

    const { versions, cursors } = await readAll(wallet.id, 50);

    expect(versions.map((page) => page.length)).toEqual([50, 50, 20]);
    expect(versions.flat()).toEqual(Array.from({ length: 120 }, (_, i) => 120 - i));
    expect(cursors.map((cursor) => cursor === null)).toEqual([false, false, true]);
  });

  test('a ledger that fills the last page exactly ends without a dangling cursor', async () => {
    const wallet = await walletWithEntries(100);

    const { versions, cursors } = await readAll(wallet.id, 50);

    expect(versions.map((page) => page.length)).toEqual([50, 50]);
    expect(cursors[1]).toBeNull();
  });

  test('an entry written between two page reads is neither duplicated nor does it hide an unseen entry', async () => {
    const wallet = await walletWithEntries(30);
    const first = await listLedger.execute({ walletId: wallet.id, limit: 10 });
    await Promise.all([bet(wallet), bet(wallet), bet(wallet)]);

    const second = await listLedger.execute({
      walletId: wallet.id,
      limit: 10,
      beforeVersion: ledgerQuerySchema.parse({ cursor: first.nextCursor! }).beforeVersion!,
    });

    expect(first.entries.map((entry) => entry.walletVersion)).toEqual(Array.from({ length: 10 }, (_, i) => 30 - i));
    expect(second.entries.map((entry) => entry.walletVersion)).toEqual(Array.from({ length: 10 }, (_, i) => 20 - i));
  });

  test('an entry exposes direction, amounts, balances, version and its transaction', async () => {
    const wallet = await walletWithEntries(2);

    const [latest, opening] = (await listLedger.execute({ walletId: wallet.id })).entries;

    expect(latest?.direction).toBe('DEBIT');
    expect(latest?.amount.toString()).toBe('1.00');
    expect(latest?.balanceBefore.toString()).toBe('1000.00');
    expect(latest?.balanceAfter.toString()).toBe('999.00');
    expect(latest?.walletVersion).toBe(2);
    expect(latest?.transactionId).toBeTruthy();
    expect(opening?.direction).toBe('CREDIT');
    expect(opening?.balanceBefore.toString()).toBe('0.00');
  });

  test('the default limit is 50 and 200 is the maximum', async () => {
    const wallet = await walletWithEntries(60);

    expect((await listLedger.execute({ walletId: wallet.id })).entries).toHaveLength(50);
    expect((await listLedger.execute({ walletId: wallet.id, limit: 200 })).entries).toHaveLength(60);
    await expect(listLedger.execute({ walletId: wallet.id, limit: 201 })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
    await expect(listLedger.execute({ walletId: wallet.id, limit: 0 })).rejects.toBeInstanceOf(InvalidLedgerQueryError);
  });

  test('a wallet without movement has an empty ledger', async () => {
    const wallet = await newWallet('0.00');

    expect(await listLedger.execute({ walletId: wallet.id })).toEqual({ entries: [], nextCursor: null });
  });

  test('an unknown wallet is WalletNotFound', async () => {
    await expect(listLedger.execute({ walletId: uuid() })).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('the cursor is opaque and is not the wallet version in the clear', async () => {
    const wallet = await walletWithEntries(5);

    const { nextCursor } = await listLedger.execute({ walletId: wallet.id, limit: 2 });

    expect(nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nextCursor).not.toBe('4');
  });
});
