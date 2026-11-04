import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletNotFoundError } from '../../../src/application/errors/application-errors';
import { OpenWallet } from '../../../src/application/use-cases/open-wallet';
import { ReconcileWallet } from '../../../src/application/use-cases/reconcile-wallet';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import { FakeClock, RecordingLogger, RecordingMetrics, testUnitOfWork } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let openWallet: OpenWallet;
let submit: SubmitWagerTransaction;
const clock = new FakeClock();
const policy = { maxAttempts: 10, baseDelayMs: 1000, factor: 2, maxDelayMs: 300_000 };

beforeAll(async () => {
  orm = await getTestOrm();
  const unitOfWork = testUnitOfWork(orm, 10_000);
  openWallet = new OpenWallet({ unitOfWork, clock });
  submit = new SubmitWagerTransaction({ unitOfWork, clock, referencePolicy: policy });
});

afterAll(async () => {
  await closeTestOrm();
});

function reconciler() {
  const logger = new RecordingLogger();
  const metrics = new RecordingMetrics();
  return { logger, metrics, useCase: new ReconcileWallet({ unitOfWork: testUnitOfWork(orm, 10_000), logger, metrics }) };
}

const newWallet = (balance = '1000.00') => openWallet.execute({ playerId: uuid(), initialBalance: { amount: balance, currency: 'BRL' } });

const wager = (wallet: Wallet, kind: 'BET' | 'WIN', amount: string) => {
  const n = uuid();
  return submit.execute({
    idempotencyKey: `key-${n}`,
    providerId: `provider-${n}`,
    externalTransactionId: `ext-${n}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${n}`,
    gameId: 'game',
    kind,
    money: { amount, currency: 'BRL' },
  } as never);
};

describe('ReconcileWallet: consistent wallets (REC-01)', () => {
  test('after operations: stored equals calculated, difference 0.00 and every entry counted', async () => {
    const wallet = await newWallet('1000.00');
    await wager(wallet, 'BET', '100.00');
    await wager(wallet, 'BET', '50.25');
    await wager(wallet, 'WIN', '300.00');
    const { useCase, logger, metrics } = reconciler();

    const report = await useCase.execute(wallet.id);

    expect(report.walletId).toBe(wallet.id);
    expect(report.consistent).toBe(true);
    expect(report.storedBalance.toJSON()).toEqual({ amount: '1149.75', currency: 'BRL' });
    expect(report.calculatedBalance.toJSON()).toEqual({ amount: '1149.75', currency: 'BRL' });
    expect(report.difference.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    expect(report.checkedEntries).toBe(4);
    expect(logger.entries).toHaveLength(0);
    expect(metrics.total('reconciliation_mismatches_total')).toBe(0);
  });

  test('a wallet opened with zero has no entries and is consistent', async () => {
    const wallet = await newWallet('0.00');

    const report = await reconciler().useCase.execute(wallet.id);

    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(0);
    expect(report.storedBalance.toJSON().amount).toBe('0.00');
  });

  test('rejected transactions leave no entry to count', async () => {
    const wallet = await newWallet('10.00');
    await wager(wallet, 'BET', '99.00');

    const report = await reconciler().useCase.execute(wallet.id);

    expect(report.consistent).toBe(true);
    expect(report.checkedEntries).toBe(1);
  });

  test('reconciling wallets does not mix their ledgers', async () => {
    const first = await newWallet('100.00');
    const second = await newWallet('500.00');
    await wager(second, 'BET', '25.00');
    const { useCase } = reconciler();

    expect((await useCase.execute(first.id)).checkedEntries).toBe(1);
    expect((await useCase.execute(second.id)).checkedEntries).toBe(2);
  });
});

describe('ReconcileWallet: divergence is reported, never fixed (REC-02)', () => {
  test('a balance changed behind the application\'s back → consistent false, error log, metric, balance untouched', async () => {
    const wallet = await newWallet('1000.00');
    await wager(wallet, 'BET', '100.00');
    await sql(orm, `update wallets set balance = 950.00 where id = ?`, [wallet.id]);
    const { useCase, logger, metrics } = reconciler();

    const report = await useCase.execute(wallet.id);

    expect(report.consistent).toBe(false);
    expect(report.storedBalance.toJSON().amount).toBe('950.00');
    expect(report.calculatedBalance.toJSON().amount).toBe('900.00');
    expect(report.difference.toJSON().amount).toBe('50.00');
    expect(logger.at('error')).toHaveLength(1);
    expect(logger.at('error')[0]?.context).toEqual({ walletId: wallet.id, checkedEntries: 2 });
    expect(metrics.total('reconciliation_mismatches_total')).toBe(1);
    expect((await sql(orm, 'select balance::text as b from wallets where id = ?', [wallet.id]))[0]?.b).toBe('950.00');
  });

  test('a stored balance below the ledger gives a negative difference, also not corrected', async () => {
    const wallet = await newWallet('1000.00');
    await sql(orm, `update wallets set balance = 400.00 where id = ?`, [wallet.id]);

    const report = await reconciler().useCase.execute(wallet.id);

    expect(report.consistent).toBe(false);
    expect(report.difference.toJSON().amount).toBe('-600.00');
    expect((await sql(orm, 'select balance::text as b from wallets where id = ?', [wallet.id]))[0]?.b).toBe('400.00');
  });

  test('every reconciliation of a divergent wallet counts again, and the log carries ids only', async () => {
    const wallet = await newWallet('1000.00');
    await sql(orm, `update wallets set balance = 1.00 where id = ?`, [wallet.id]);
    const { useCase, logger, metrics } = reconciler();

    await useCase.execute(wallet.id);
    await useCase.execute(wallet.id);

    expect(metrics.total('reconciliation_mismatches_total')).toBe(2);
    // The wallet id is a random UUID that may contain digits like "1000" by chance: look at everything but the id.
    expect(JSON.stringify(logger.entries).replaceAll(wallet.id, '<wallet>')).not.toMatch(/1000|1\.00|playerId/);
  });
});

describe('ReconcileWallet: other cases (REC-03)', () => {
  test('an unknown wallet → WalletNotFoundError and nothing is counted', async () => {
    const { useCase, metrics, logger } = reconciler();

    await expect(useCase.execute(uuid())).rejects.toBeInstanceOf(WalletNotFoundError);

    expect(metrics.total('reconciliation_mismatches_total')).toBe(0);
    expect(logger.entries).toHaveLength(0);
  });

  test('reconciling while the wallet is being changed never reports a false mismatch', async () => {
    const wallet = await newWallet('10000.00');
    const { useCase } = reconciler();
    let running = true;
    const writer = (async () => {
      for (let i = 0; i < 60; i += 1) {
        await wager(wallet, 'BET', '1.00');
      }
      running = false;
    })();

    const reports = [];
    while (running) {
      reports.push(await useCase.execute(wallet.id));
    }
    await writer;

    expect(reports.length).toBeGreaterThan(1);
    expect(reports.every((report) => report.consistent)).toBe(true);
    expect((await useCase.execute(wallet.id)).checkedEntries).toBe(61);
  });

  test('works without logger and metrics (defaults)', async () => {
    const wallet = await newWallet('1.00');
    await sql(orm, `update wallets set balance = 2.00 where id = ?`, [wallet.id]);

    const report = await new ReconcileWallet({ unitOfWork: testUnitOfWork(orm, 10_000) }).execute(wallet.id);

    expect(report.consistent).toBe(false);
  });
});
