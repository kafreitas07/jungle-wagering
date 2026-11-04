import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { TransactionNotFoundError, WalletNotFoundError } from '../../../src/application/errors/application-errors';
import { GetTransactionByExternalId, GetTransactionById, GetWallet } from '../../../src/application/use-cases/queries';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction, type SubmitWagerTransactionCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, holdWalletLock, testUnitOfWork } from '../../support/context';
import { uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
let submit: SubmitWagerTransaction;
let getWallet: GetWallet;
let byId: GetTransactionById;
let byExternalId: GetTransactionByExternalId;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  const unitOfWork = testUnitOfWork(orm, 40);
  openWallet = new OpenWallet({ unitOfWork, clock });
  submit = new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });
  getWallet = new GetWallet({ unitOfWork });
  byId = new GetTransactionById({ unitOfWork });
  byExternalId = new GetTransactionByExternalId({ unitOfWork });
});

afterAll(async () => {
  await closeTestOrm();
});

const newWallet = (balance = '1000.00') => openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' } });

const send = (wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}) => {
  const n = uuid();
  return submit.execute({
    idempotencyKey: `key-${n}`,
    providerId: 'provider-q',
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  });
};

describe('GetWallet (WAL-05)', () => {
  test('returns id, player, balance, currency and version', async () => {
    const wallet = await newWallet('500.00');
    await send(wallet);

    const found = await getWallet.execute(wallet.id);

    expect(found.id).toBe(wallet.id);
    expect(found.playerId).toBe(wallet.playerId);
    expect(found.balance.toString()).toBe('475.00');
    expect(found.currency).toBe('BRL');
    expect(found.version).toBe(2);
  });

  test('an unknown wallet is WalletNotFound', async () => {
    await expect(getWallet.execute(uuid())).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  test('does not wait for a lock held by a balance change', async () => {
    const wallet = await newWallet();
    const holder = holdWalletLock(orm, wallet.id, 400);
    await holder.acquired;

    const startedAt = performance.now();
    const found = await getWallet.execute(wallet.id);
    const elapsed = performance.now() - startedAt;
    await holder.released;

    expect(found.balance.toString()).toBe('1000.00');
    expect(elapsed).toBeLessThan(250);
  });
});

describe('GetTransactionById and GetTransactionByExternalId (WAL-06, TXN-10)', () => {
  test('a processed transaction exposes status, kind, money, balance after and reference', async () => {
    const wallet = await newWallet();
    const bet = await send(wallet, { externalTransactionId: 'bet-q' });
    const refund = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'bet-q' });

    const found = await byId.execute(refund.transaction.id);

    expect(found.status).toBe('PROCESSED');
    expect(found.failureCode).toBeNull();
    expect(found.kind).toBe('REFUND');
    expect(found.money.toString()).toBe('25.00');
    expect(found.balanceAfter?.toString()).toBe('1000.00');
    expect(found.referenceExternalTransactionId).toBe('bet-q');
    expect(found.referenceTransactionId).toBe(bet.transaction.id);
  });

  test('a rejected transaction exposes its failure code and the balance it saw', async () => {
    const wallet = await newWallet('10.00');
    const { transaction } = await send(wallet, { providerId: 'provider-rej', externalTransactionId: 'rejected-q' });

    const found = await byExternalId.execute('provider-rej', 'rejected-q');

    expect(found.id).toBe(transaction.id);
    expect(found.status).toBe('REJECTED');
    expect(found.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(found.balanceAfter?.toString()).toBe('10.00');
  });

  test('a pending transaction exposes its next attempt', async () => {
    const wallet = await newWallet();
    const { transaction } = await send(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'later' });

    const found = await byId.execute(transaction.id);

    expect(found.status).toBe('PENDING_REFERENCE');
    expect(found.nextAttemptAt).not.toBeNull();
  });

  test('both lookups agree on the same transaction', async () => {
    const wallet = await newWallet();
    const { transaction } = await send(wallet, { providerId: 'provider-same', externalTransactionId: 'same-q' });

    expect((await byId.execute(transaction.id)).id).toBe((await byExternalId.execute('provider-same', 'same-q')).id);
  });

  test('unknown ids are TransactionNotFound, and the external id is scoped by provider', async () => {
    const wallet = await newWallet();
    await send(wallet, { providerId: 'provider-scope', externalTransactionId: 'scoped-q' });

    await expect(byId.execute(uuid())).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(byExternalId.execute('provider-scope', 'nope')).rejects.toBeInstanceOf(TransactionNotFoundError);
    await expect(byExternalId.execute('another-provider', 'scoped-q')).rejects.toBeInstanceOf(TransactionNotFoundError);
  });
});
