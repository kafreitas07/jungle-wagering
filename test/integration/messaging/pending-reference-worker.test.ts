import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/unit-of-work';
import { createTxRepositories } from '../../../src/infrastructure/persistence/repositories';
import type { LedgerRepository, TxRepositories } from '../../../src/application/ports';
import { ReprocessPendingReference } from '../../../src/application/use-cases/reprocess-pending-reference';
import { SubmitWagerTransaction, type SubmitWagerTransactionCommand } from '../../../src/application/use-cases/submit-wager-transaction';
import { PendingReferenceWorker } from '../../../src/infrastructure/messaging/pending-reference-worker';
import { FakeClock, RecordingLogger, RecordingMetrics, testUnitOfWork } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { parkPendingTransactions } from '../../support/messaging';
import { assertReconciledViaApp } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';
import { balanceOf, countFor, newWallet, policy, type TestWallet, waitFor } from '../../support/wager-messages';

let orm: MikroORM;
const clock = new FakeClock();
let metrics: RecordingMetrics;
let logger: RecordingLogger;

beforeAll(async () => {
  orm = await getTestOrm();
  await parkPendingTransactions(orm);
});

afterAll(async () => {
  await closeTestOrm();
});

const submitter = (unitOfWork = testUnitOfWork(orm)) => new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });

function workerOn(unitOfWork = testUnitOfWork(orm), overrides: { clock?: FakeClock } = {}) {
  metrics = new RecordingMetrics();
  logger = new RecordingLogger();
  const useCase = new ReprocessPendingReference({ unitOfWork, clock: overrides.clock ?? clock, referencePolicy: policy });
  return new PendingReferenceWorker(useCase, { intervalMs: 50, batchSize: 50, metrics, logger });
}

function command(wallet: TestWallet, overrides: Partial<SubmitWagerTransactionCommand> = {}): SubmitWagerTransactionCommand {
  const n = uuid();
  return {
    idempotencyKey: `key-${n}`,
    providerId: `provider-${n}`,
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${n}`,
    gameId: 'game',
    kind: 'BET',
    money: { amount: '40.00', currency: 'BRL' },
    ...overrides,
  };
}

/** A BET that has not been sent yet, and the ROLLBACK that arrived before it. */
async function rollbackBeforeBet(wallet: TestWallet) {
  const providerId = `provider-${uuid()}`;
  const roundId = `round-${uuid()}`;
  const bet = command(wallet, { providerId, roundId });
  const rollback = command(wallet, { providerId, roundId, kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId });
  const pending = await submitter().execute(rollback);
  expect(pending.transaction.status).toBe('PENDING_REFERENCE');
  return { bet, rollback, pendingId: pending.transaction.id };
}

const row = async (id: string) => (await sql(orm, 'select * from wager_transactions where id = ?', [id]))[0]!;
const eventTypes = async (transactionId: string) =>
  (await sql(orm, `select event_type from outbox_messages where payload->'data'->>'transactionId' = ? order by occurred_at, id`, [transactionId])).map((entry) =>
    String(entry.event_type),
  );

describe('the reference arrives later (PREF-02, PREF-03)', () => {
  test('ROLLBACK before the BET waits as PENDING_REFERENCE; once the BET exists the worker processes it and the balance returns to the start', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    await submitter().execute(bet);
    expect(await balanceOf(orm, wallet.id)).toBe('960.00');
    clock.advance(1500);

    const round = await workerOn().runOnce();

    expect(round).toMatchObject({ processed: 1, failed: 0 });
    expect(metrics.counts).toContainEqual({ metric: 'wager_transactions_total', labels: { kind: 'ROLLBACK', status: 'PROCESSED' } });
    const after = await row(pendingId);
    expect(after.status).toBe('PROCESSED');
    expect(after.reference_transaction_id).not.toBeNull();
    expect(after.next_attempt_at).toBeNull();
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    expect(await eventTypes(pendingId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionProcessed', 'WalletBalanceChanged']);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a transaction that is not due yet is left alone', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);

    const round = await workerOn().runOnce();

    expect(round.due).toBe(0);
    expect((await row(pendingId)).status).toBe('PENDING_REFERENCE');
  });

  test('without its reference it is retried with exponential backoff, and each try is counted', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { pendingId } = await rollbackBeforeBet(wallet);
    const worker = workerOn();
    const delays: number[] = [];

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      clock.advance(300_000);
      const round = await worker.runOnce();
      expect(round.stillPending).toBeGreaterThanOrEqual(1);
      const current = await row(pendingId);
      expect(current.reference_attempts).toBe(attempt);
      delays.push(new Date(String(current.next_attempt_at)).getTime() - clock.now().getTime());
    }

    expect(delays).toEqual([2000, 4000, 8000, 16000]);
    expect(metrics.counts.filter((entry) => entry.metric === 'retries_total' && entry.labels?.reason === 'pending_reference')).toHaveLength(4);
    expect(await eventTypes(pendingId)).toEqual(['WagerTransactionPendingReference']);
  });

  test('the delay stops growing at the configured ceiling', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { pendingId } = await rollbackBeforeBet(wallet);
    await sql(orm, `update wager_transactions set reference_attempts = 8 where id = ?`, [pendingId]);
    clock.advance(1_000_000);

    await workerOn().runOnce();

    const current = await row(pendingId);
    expect(current.reference_attempts).toBe(9);
    expect(new Date(String(current.next_attempt_at)).getTime() - clock.now().getTime()).toBe(300_000);
  });
});

describe('the reference never arrives (PREF-04)', () => {
  test('after 10 attempts the reversal is REJECTED with REFERENCE_NOT_FOUND and a rejection event, and the balance is untouched', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { pendingId } = await rollbackBeforeBet(wallet);
    const worker = workerOn();
    let last = await worker.runOnce();

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      clock.advance(300_000);
      last = await worker.runOnce();
    }

    const final = await row(pendingId);
    expect(final.status).toBe('REJECTED');
    expect(final.failure_code).toBe('REFERENCE_NOT_FOUND');
    expect(final.reference_attempts).toBe(10);
    expect(final.next_attempt_at).toBeNull();
    expect(last.rejected).toBe(1);
    expect(metrics.counts).toContainEqual({ metric: 'wager_transactions_total', labels: { kind: 'ROLLBACK', status: 'REJECTED' } });
    expect(await eventTypes(pendingId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    expect(await countFor(orm, 'wallet_ledger_entries', wallet.id)).toBe(1);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a rejected one is not picked up again', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { pendingId } = await rollbackBeforeBet(wallet);
    await sql(orm, `update wager_transactions set reference_attempts = 9 where id = ?`, [pendingId]);
    clock.advance(1_000_000);
    const worker = workerOn();
    await worker.runOnce();

    clock.advance(1_000_000);
    const again = await worker.runOnce();

    expect(again.due).toBe(0);
    expect((await eventTypes(pendingId)).filter((type) => type === 'WagerTransactionRejected')).toHaveLength(1);
  });

  test('when the reference exists but the rules refuse the reversal, it is rejected for that reason', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    await submitter().execute(command(wallet, { providerId: bet.providerId, roundId: bet.roundId, kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }));
    clock.advance(1500);

    const round = await workerOn().runOnce();

    expect(round.rejected).toBe(1);
    expect((await row(pendingId)).failure_code).toBe('REFERENCE_ALREADY_REVERSED');
    expect(await eventTypes(pendingId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('several workers on the same pending transaction (PREF-05)', () => {
  test('exactly one processes it, nobody deadlocks, and the credit is applied once', async () => {
    const wallets: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const wallet = await newWallet(orm, '1000.00', clock);
      wallets.push(wallet.id);
      const { bet, pendingId } = await rollbackBeforeBet(wallet);
      await submitter().execute(bet);
      clock.advance(1500);

      const rounds = await Promise.all([workerOn().runOnce(), workerOn().runOnce(), workerOn().runOnce()]);

      expect(rounds.reduce((total, current) => total + current.processed, 0)).toBe(1);
      expect(rounds.reduce((total, current) => total + current.failed + current.deferred, 0)).toBe(0);
      expect((await row(pendingId)).status).toBe('PROCESSED');
      expect(await countFor(orm, 'wallet_ledger_entries', wallet.id, `and direction = 'CREDIT'`)).toBe(2);
      expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    }
    await assertReconciledViaApp(orm, wallets);
  });

  test('a worker racing the synchronous submission of the reference stays consistent', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    clock.advance(1500);

    await Promise.all([submitter().execute(bet), workerOn().runOnce()]);
    clock.advance(300_000);
    await workerOn().runOnce();

    expect((await row(pendingId)).status).toBe('PROCESSED');
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('errors (PREF-06)', () => {
  class BrokenLedgerUnitOfWork extends MikroOrmUnitOfWork {
    constructor() {
      super(orm, { lockTimeoutMs: 2000 }, (em): TxRepositories => {
        const repositories = createTxRepositories(em);
        const ledger: LedgerRepository = {
          ...repositories.ledger,
          append: async () => {
            throw new Error('invariant broken while writing the ledger');
          },
          listByWallet: repositories.ledger.listByWallet.bind(repositories.ledger),
          reconciliationSnapshot: repositories.ledger.reconciliationSnapshot.bind(repositories.ledger),
        };
        return { ...repositories, ledger };
      });
    }
  }

  test('a permanent error marks the transaction FAILED / PROCESSING_FAILED, logs it, counts it and publishes no rejection', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    clock.advance(1500);

    const worker = workerOn(new BrokenLedgerUnitOfWork());
    const round = await worker.runOnce();

    expect(round.failed).toBe(1);
    const failed = await row(pendingId);
    expect(failed.status).toBe('FAILED');
    expect(failed.failure_code).toBe('PROCESSING_FAILED');
    expect(await eventTypes(pendingId)).toEqual(['WagerTransactionPendingReference']);
    expect(logger.at('error').some((entry) => entry.message === 'pending reference failed permanently' && entry.context?.transactionId === pendingId)).toBe(true);
    expect(metrics.counts).toContainEqual({ metric: 'wager_transactions_total', labels: { kind: 'ROLLBACK', status: 'FAILED' } });
    expect(await balanceOf(orm, wallet.id)).toBe('960.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a failed transaction leaves the pending work for good', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    clock.advance(1500);
    await workerOn(new BrokenLedgerUnitOfWork()).runOnce();
    clock.advance(1_000_000);

    const again = await workerOn().runOnce();

    expect(again.due).toBe(0);
  });

  test('a transient error (database away) defers the transaction without using up an attempt', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    clock.advance(1500);
    const down = {
      run: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
      },
    };
    const realWorker = workerOn();
    const brokenUseCase = new ReprocessPendingReference({ unitOfWork: testUnitOfWork(orm), clock, referencePolicy: policy });
    const flakyUseCase = Object.assign(Object.create(brokenUseCase), {
      execute: () => down.run(),
    }) as ReprocessPendingReference;
    const deferring = new PendingReferenceWorker(flakyUseCase, { intervalMs: 50, batchSize: 10, logger, metrics });

    const round = await deferring.runOnce();

    expect(round.deferred).toBe(1);
    expect(round.failed).toBe(0);
    expect((await row(pendingId)).status).toBe('PENDING_REFERENCE');
    expect((await row(pendingId)).reference_attempts).toBe(0);
    const recovered = await realWorker.runOnce();
    expect(recovered.processed).toBe(1);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
  });
});

describe('the re-check after the wallet lock', () => {
  const useCase = () => new ReprocessPendingReference({ unitOfWork: testUnitOfWork(orm), clock, referencePolicy: policy });

  test('a target read as due that is no longer due (rescheduled meanwhile) is skipped without using an attempt', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    const stale = { id: pendingId, walletId: wallet.id, kind: 'ROLLBACK' };
    // clock was not advanced: the transaction is not due yet, exactly as if another worker had just rescheduled it
    const result = await useCase().execute(stale);

    expect(result).toBe('skipped');
    const current = await row(pendingId);
    expect(current.status).toBe('PENDING_REFERENCE');
    expect(current.reference_attempts).toBe(0);
    expect(await balanceOf(orm, wallet.id)).toBe('960.00');
  });

  test('a target that was already finished is skipped', async () => {
    const wallet = await newWallet(orm, '1000.00', clock);
    const { bet, pendingId } = await rollbackBeforeBet(wallet);
    await submitter().execute(bet);
    clock.advance(1500);
    const target = { id: pendingId, walletId: wallet.id, kind: 'ROLLBACK' };
    expect(await useCase().execute(target)).toBe('processed');

    expect(await useCase().execute(target)).toBe('skipped');
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
  });

  test('a target whose wallet does not exist is an error, not a silent skip', async () => {
    await expect(useCase().execute({ id: uuid(), walletId: uuid(), kind: 'ROLLBACK' })).rejects.toThrow(/does not exist|not found/i);
  });
});

describe('the runner', () => {
  test('polls on its own, processes what becomes due and stops cleanly', async () => {
    const live = new FakeClock(new Date());
    const wallet = await newWallet(orm, '1000.00', live);
    const providerId = `provider-${uuid()}`;
    const roundId = `round-${uuid()}`;
    const bet = command(wallet, { providerId, roundId });
    const submit = new SubmitWagerTransaction({ unitOfWork: testUnitOfWork(orm), clock: live, referencePolicy: { ...policy, baseDelayMs: 100 } });
    const pending = await submit.execute(command(wallet, { providerId, roundId, kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId }));
    await submit.execute(bet);
    const worker = new PendingReferenceWorker(new ReprocessPendingReference({ unitOfWork: testUnitOfWork(orm), clock: { now: () => new Date() }, referencePolicy: policy }), {
      intervalMs: 50,
      batchSize: 10,
    });

    worker.start();
    const processed = await waitFor(async () => (await row(pending.transaction.id)).status === 'PROCESSED', 10_000);
    await worker.stop();

    expect(processed).toBe(true);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});
