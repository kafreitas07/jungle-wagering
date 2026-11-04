import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api } from '../support/app';
import { closeTestOrm, getTestOrm } from '../support/db';
import { createWallet, post, submission } from '../support/http';
import { drainOutbox, parkPendingTransactions, pendingOutbox } from '../support/messaging';
import { type AppProcess, spawnApp } from '../support/process';
import { createTestQueues, type TestQueues } from '../support/queues';
import { assertReconciledByApi } from '../support/reconcile';
import { sql, uuid } from '../support/sql';
import { balanceOf, countFor, sendMessage, transactionsOf, wagerMessage, waitFor } from '../support/wager-messages';

let orm: MikroORM;
let queues: TestQueues;
const processes: AppProcess[] = [];

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

beforeEach(async () => {
  await drainOutbox(orm);
  await parkPendingTransactions(orm);
  queues = await createTestQueues({ visibilityTimeoutSeconds: 3 });
});

afterEach(async () => {
  await Promise.all(processes.splice(0).map((app) => app.stop()));
  await queues.destroy();
});

async function start(env: Record<string, string> = {}): Promise<AppProcess> {
  const app = await spawnApp({ queues, env });
  processes.push(app);
  return app;
}

const walletOf = async (url: string, balance = '1000.00') => createWallet(url, balance);
const sqsBody = (wallet: { id: string; playerId: string }, data: Record<string, unknown> = {}) => wagerMessage(wallet, { data });
const eventCount = async (walletId: string) =>
  Number((await sql(orm, 'select count(*)::int as n from outbox_messages where aggregate_id = ?', [walletId]))[0]?.n);

describe('the worker dies after the commit and before the acknowledgement (SQS-09, TEST-02)', () => {
  test('the redelivery is recognised by the inbox: one transaction, one debit, and the message ends acknowledged', async () => {
    const setup = await start({ RUN_SQS_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_WORKER: 'false' });
    const wallet = await walletOf(setup.url, '1000.00');
    await setup.stop();

    const doomed = await start({ FAULT_INJECTION: 'crash-after-commit-before-ack', RUN_HTTP: 'true', RUN_SQS_CONSUMER: 'true', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_WORKER: 'false' });
    const message = sqsBody(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);

    const exitCode = await Promise.race([doomed.exited, Bun.sleep(30_000).then(() => 'still running' as const)]);
    expect(exitCode).not.toBe('still running');
    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await queues.isEmpty(queues.wager)).toBe(false);

    const survivor = await start({ RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_WORKER: 'false' });
    expect(await waitFor(() => queues.isEmpty(queues.wager), 30_000)).toBe(true);

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    expect(await countFor(orm, 'wallet_ledger_entries', wallet.id, `and direction = 'DEBIT'`)).toBe(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await sql(orm, 'select 1 from inbox_messages where message_id = ?', [message.messageId])).toHaveLength(1);
    expect(await queues.depth(queues.dlq)).toBe(0);
    await assertReconciledByApi(orm, survivor.url, [wallet.id]);
  });
});

describe('the same operation through HTTP and SQS (TEST-03)', () => {
  test('HTTP first, then the same operation by SQS: applied once, the message is just a replay', async () => {
    const app = await start();
    const wallet = await walletOf(app.url, '1000.00');
    const body = submission(wallet);
    const key = `key-${uuid()}`;
    const http = await post(app.url, body, key);
    expect(http.status).toBe(201);

    await sendMessage(
      queues.adapter,
      queues.wager,
      wagerMessage(wallet, { data: { ...body, idempotencyKey: key } }),
      wallet.id,
    );

    expect(await waitFor(() => queues.isEmpty(queues.wager), 20_000)).toBe(true);
    expect(await transactionsOf(orm, body.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await queues.depth(queues.dlq)).toBe(0);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('SQS first, then HTTP: the HTTP answer is the replay of what the queue created', async () => {
    const app = await start();
    const wallet = await walletOf(app.url, '1000.00');
    const message = sqsBody(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);
    expect(await waitFor(async () => (await transactionsOf(orm, message.data.externalTransactionId)).length === 1, 20_000)).toBe(true);

    const { idempotencyKey, ...business } = message.data;
    const http = await post(app.url, business, idempotencyKey as string);

    expect(http.status).toBe(201);
    expect(http.body.idempotentReplay).toBe(true);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });

  test('both at the same instant, repeated: always exactly one effect', async () => {
    const app = await start();
    const wallets: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      const wallet = await walletOf(app.url, '1000.00');
      wallets.push(wallet.id);
      const message = sqsBody(wallet);
      const { idempotencyKey, ...business } = message.data;

      const [http] = await Promise.all([
        post(app.url, business, idempotencyKey as string),
        sendMessage(queues.adapter, queues.wager, message, wallet.id),
      ]);

      expect(http.status).toBe(201);
      expect(await waitFor(() => queues.isEmpty(queues.wager), 20_000)).toBe(true);
      expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
      expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    }
    expect(await queues.depth(queues.dlq)).toBe(0);
    await assertReconciledByApi(orm, app.url, wallets);
  });
});

describe('a reversal that arrives before its reference, end to end (PREF-03, TEST-02)', () => {
  test('ROLLBACK by SQS, BET by HTTP: the worker settles it, the balance returns and every event reaches the events queue', async () => {
    const app = await start();
    const wallet = await walletOf(app.url, '1000.00');
    const providerId = `provider-${uuid()}`;
    const roundId = `round-${uuid()}`;
    const bet = submission(wallet, { providerId, roundId });
    const rollback = wagerMessage(wallet, {
      data: { providerId, roundId, kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId },
    });
    await sendMessage(queues.adapter, queues.wager, rollback, wallet.id);
    expect(await waitFor(async () => (await transactionsOf(orm, rollback.data.externalTransactionId)).length === 1, 20_000)).toBe(true);
    expect((await transactionsOf(orm, rollback.data.externalTransactionId))[0]?.status).toBe('PENDING_REFERENCE');

    expect((await post(app.url, bet)).status).toBe(201);

    expect(await waitFor(async () => (await transactionsOf(orm, rollback.data.externalTransactionId))[0]?.status === 'PROCESSED', 30_000)).toBe(true);
    expect(await balanceOf(orm, wallet.id)).toBe('1000.00');
    expect(await waitFor(async () => (await pendingOutbox(orm, [wallet.id])) === 0, 30_000)).toBe(true);
    const types = (await queues.drain(queues.events, 2)).map((entry) => JSON.parse(entry.body).eventType);
    expect(types.filter((type) => type === 'WagerTransactionPendingReference')).toHaveLength(1);
    expect(types.filter((type) => type === 'WalletBalanceChanged')).toHaveLength(3);
    expect(types.filter((type) => type === 'WagerTransactionProcessed')).toHaveLength(3);
    await assertReconciledByApi(orm, app.url, [wallet.id]);
  });
});

describe('processes restarted in the middle of the load (TEST-03)', () => {
  test('three instances, one killed and restarted under load: every operation applied once, every event published, all wallets consistent', async () => {
    const a = await start();
    const b = await start();
    const c = await start();
    const wallets = await Promise.all(Array.from({ length: 5 }, () => walletOf(b.url, '1000.00')));
    const perWalletSqs = 8;
    const perWalletHttp = 4;
    const sqsMessages = wallets.flatMap((wallet) =>
      Array.from({ length: perWalletSqs }, () => ({ wallet, message: sqsBody(wallet, { money: { amount: '5.00', currency: 'BRL' } }) })),
    );

    const sending = (async () => {
      for (const { wallet, message } of sqsMessages) {
        await sendMessage(queues.adapter, queues.wager, message, wallet.id);
      }
    })();
    const httpLoad = (async () => {
      for (let index = 0; index < perWalletHttp; index += 1) {
        await Promise.all(
          wallets.map(async (wallet) => {
            const response = await post(index % 2 === 0 ? b.url : c.url, submission(wallet, { money: { amount: '5.00', currency: 'BRL' } }));
            expect(response.status).toBe(201);
          }),
        );
      }
    })();

    await Bun.sleep(700);
    a.kill();
    await a.exited;
    await Bun.sleep(500);
    await start();
    await Promise.all([sending, httpLoad]);

    const operationsPerWallet = perWalletSqs + perWalletHttp;
    const settled = await waitFor(async () => {
      const counts = await Promise.all(wallets.map((wallet) => countFor(orm, 'wager_transactions', wallet.id, `and provider_id <> 'internal'`)));
      return counts.every((count) => count === operationsPerWallet) && (await queues.isEmpty(queues.wager));
    }, 90_000);
    expect(settled).toBe(true);

    for (const { message } of sqsMessages) {
      expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    }
    for (const wallet of wallets) {
      expect(await countFor(orm, 'wallet_ledger_entries', wallet.id, `and direction = 'DEBIT'`)).toBe(operationsPerWallet);
      expect(await countFor(orm, 'wallet_ledger_entries', wallet.id)).toBe(operationsPerWallet + 1);
      expect(await balanceOf(orm, wallet.id)).toBe('940.00');
    }
    expect(await waitFor(async () => (await pendingOutbox(orm, wallets.map((wallet) => wallet.id))) === 0, 60_000)).toBe(true);
    const survivorUrl = b.url;
    await assertReconciledByApi(orm, survivorUrl, wallets.map((wallet) => wallet.id));

    // 2 events for the opening + 2 per operation, none lost, none duplicated in the queue (event id deduplication).
    const eventsPerWallet = 2 + 2 * operationsPerWallet;
    for (const wallet of wallets) {
      expect(await eventCount(wallet.id)).toBe(eventsPerWallet);
    }
    expect((await queues.drain(queues.events, 2)).length).toBe(wallets.length * eventsPerWallet);
    expect(await queues.depth(queues.dlq)).toBe(0);
    expect((await api(survivorUrl, 'GET', '/health/live')).status).toBe(200);
  });
});
