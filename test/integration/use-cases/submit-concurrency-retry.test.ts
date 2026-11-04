import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import {
  ConcurrencyConflictError,
  ExternalIdConflictError,
  IdempotencyConflictError,
} from '../../../src/application/errors/application-errors';
import { ConcurrencyRetry } from '../../../src/application/services/concurrency-retry';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { SubmitWagerTransaction, type SubmitWagerTransactionCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { FakeClock, RecordingMetrics, holdWalletLock, testUnitOfWork } from '../../support/context';
import { assertReconciled } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  openWallet = new OpenWallet({ unitOfWork: testUnitOfWork(orm), clock });
});

afterAll(async () => {
  await closeTestOrm();
});

const newWallet = () => openWallet.execute({ playerId: uuid(), initialBalance: { amount: '1000.00', currency: 'BRL' } });

function command(wallet: Wallet, overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand {
  const n = uuid();
  return {
    idempotencyKey: `key-${n}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

/** A use case whose transactions give up quickly on a held lock, with the real retry around it. */
function impatient(metrics: RecordingMetrics) {
  return new SubmitWagerTransaction({
    unitOfWork: testUnitOfWork(orm, 40),
    clock,
    referencePolicy: policy,
    concurrencyRetry: new ConcurrencyRetry({ metrics }),
  });
}

describe('lock contention (CONC-05)', () => {
  test('a lock timeout that clears within the retries ends in success and counts the conflicts', async () => {
    const wallet = await newWallet();
    const metrics = new RecordingMetrics();
    const holder = holdWalletLock(orm, wallet.id, 130);
    await holder.acquired;

    const { transaction } = await impatient(metrics).execute(command(wallet));
    await holder.released;

    expect(transaction.status).toBe('PROCESSED');
    expect(metrics.total('lock_conflicts_total')).toBeGreaterThanOrEqual(1);
    expect((await sql(orm, 'select balance::text as b from wallets where id = ?', [wallet.id]))[0]?.b).toBe('975.00');
    await assertReconciled(orm, [wallet.id]);
  });

  test('a lock held longer than all retries ends in ConcurrencyConflict, without partial effects', async () => {
    const wallet = await newWallet();
    const metrics = new RecordingMetrics();
    const external = `ext-${uuid()}`;
    const holder = holdWalletLock(orm, wallet.id, 1200);
    await holder.acquired;

    const failure = await impatient(metrics).execute(command(wallet, { externalTransactionId: external })).catch((e: unknown) => e);
    await holder.released;

    expect(failure).toBeInstanceOf(ConcurrencyConflictError);
    expect(metrics.total('lock_conflicts_total')).toBe(3);
    expect(await sql(orm, 'select 1 from wager_transactions where external_transaction_id = ?', [external])).toHaveLength(0);
    expect((await sql(orm, 'select balance::text as b, version from wallets where id = ?', [wallet.id]))[0]).toEqual({ b: '1000.00', version: 1 });
    await assertReconciled(orm, [wallet.id]);
  });

  test('after giving up, the same request can be sent again and succeeds', async () => {
    const wallet = await newWallet();
    const request = command(wallet);
    const holder = holdWalletLock(orm, wallet.id, 900);
    await holder.acquired;
    await impatient(new RecordingMetrics()).execute(request).catch(() => undefined);
    await holder.released;

    const retried = await impatient(new RecordingMetrics()).execute(request);

    expect(retried.transaction.status).toBe('PROCESSED');
    expect(retried.replay).toBe(false);
    await assertReconciled(orm, [wallet.id]);
  });
});

describe('races decided by unique constraints (CONC-07)', () => {
  const submit = () =>
    new SubmitWagerTransaction({ unitOfWork: testUnitOfWork(orm, 5000), clock, referencePolicy: policy, concurrencyRetry: new ConcurrencyRetry({ metrics: new RecordingMetrics() }) });

  test('one idempotency key used for two wallets at once: one wins, the other becomes an idempotency conflict', async () => {
    const [first, second] = await Promise.all([newWallet(), newWallet()]);
    const key = `shared-${uuid()}`;
    const use = submit();

    const results = await Promise.allSettled([
      use.execute(command(first, { idempotencyKey: key })),
      use.execute(command(second, { idempotencyKey: key })),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(IdempotencyConflictError);
    await assertReconciled(orm, [first.id, second.id]);
  });

  test('one external id under two keys at once: one wins, the other becomes an external id conflict', async () => {
    const [first, second] = await Promise.all([newWallet(), newWallet()]);
    const external = `ext-${uuid()}`;
    const use = submit();

    const results = await Promise.allSettled([
      use.execute(command(first, { externalTransactionId: external })),
      use.execute(command(second, { externalTransactionId: external })),
    ]);

    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ExternalIdConflictError);
    await assertReconciled(orm, [first.id, second.id]);
  });

  test('business errors are never retried: an idempotency conflict surfaces on the first attempt', async () => {
    const wallet = await newWallet();
    const metrics = new RecordingMetrics();
    const use = new SubmitWagerTransaction({ unitOfWork: testUnitOfWork(orm), clock, referencePolicy: policy, concurrencyRetry: new ConcurrencyRetry({ metrics }) });
    const original = command(wallet);
    await use.execute(original);

    await expect(use.execute({ ...original, money: { amount: '30.00', currency: 'BRL' } })).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(metrics.total('lock_conflicts_total')).toBe(0);
  });
});
