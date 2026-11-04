import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { startApplication, type RunningApplication } from '../../../src/infrastructure/bootstrap';
import { api, testConfig } from '../../support/app';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet } from '../../support/http';
import { drainOutbox, parkPendingTransactions, pendingOutbox } from '../../support/messaging';
import { createTestQueues, type TestQueues } from '../../support/queues';
import { assertReconciledViaApp } from '../../support/reconcile';
import { balanceOf, sendMessage, transactionsOf, wagerMessage, waitFor } from '../../support/wager-messages';

let orm: MikroORM;
let queues: TestQueues;
let running: RunningApplication | undefined;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

beforeEach(async () => {
  await drainOutbox(orm);
  await parkPendingTransactions(orm);
  queues = await createTestQueues();
});

afterEach(async () => {
  await running?.stop();
  running = undefined;
  await queues.destroy();
});

function boot(flags: { http?: boolean; consumer?: boolean; publisher?: boolean; worker?: boolean }) {
  const port = Bun.serve({ port: 0, fetch: () => new Response('') });
  const free = port.port!;
  void port.stop(true);
  return startApplication(
    testConfig({
      APP_PORT: String(free),
      RUN_HTTP: String(flags.http ?? false),
      RUN_SQS_CONSUMER: String(flags.consumer ?? false),
      RUN_OUTBOX_PUBLISHER: String(flags.publisher ?? false),
      RUN_PENDING_WORKER: String(flags.worker ?? false),
      SQS_WAGER_QUEUE: queues.wager,
      SQS_WAGER_DLQ: queues.dlq,
      SQS_EVENTS_QUEUE: queues.events,
      SQS_POLL_WAIT_SECONDS: '1',
      OUTBOX_POLL_INTERVAL_MS: '50',
      PENDING_WORKER_INTERVAL_MS: '50',
    }),
  );
}

describe('runners are chosen by environment (one image, many roles)', () => {
  test('with every runner on, an instance serves HTTP, consumes the queue and publishes the outbox', async () => {
    running = await boot({ http: true, consumer: true, publisher: true, worker: true });
    const url = `http://127.0.0.1:${running.httpPort}`;
    expect(running.runners).toEqual(['sqs-consumer', 'pending-worker', 'outbox-publisher']);

    const wallet = await createWallet(url, '500.00');
    const message = wagerMessage(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);

    expect(await waitFor(async () => (await transactionsOf(orm, message.data.externalTransactionId)).length === 1)).toBe(true);
    expect(await waitFor(async () => (await pendingOutbox(orm, [wallet.id])) === 0)).toBe(true);
    const events = await queues.drain(queues.events, 2);
    expect(events.map((entry) => JSON.parse(entry.body).eventType).sort()).toEqual([
      'WagerTransactionProcessed',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
      'WalletBalanceChanged',
    ]);
    expect(await balanceOf(orm, wallet.id)).toBe('475.00');
    expect((await api(url, 'POST', `/wallets/${wallet.id}/reconciliation`)).body.consistent).toBe(true);
  });

  test('with only the HTTP runner, nothing is consumed and nothing is published: the work waits for the other roles', async () => {
    running = await boot({ http: true });
    const url = `http://127.0.0.1:${running.httpPort}`;
    expect(running.runners).toEqual([]);
    const wallet = await createWallet(url, '500.00');
    const message = wagerMessage(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);

    await Bun.sleep(1500);

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
    expect(await pendingOutbox(orm, [wallet.id])).toBe(2);
    expect(await queues.depth(queues.events)).toBe(0);
  });

  test('a publisher-only instance publishes what another instance (HTTP only) committed', async () => {
    const httpOnly = await boot({ http: true });
    const wallet = await createWallet(`http://127.0.0.1:${httpOnly.httpPort}`, '500.00');
    expect(await pendingOutbox(orm, [wallet.id])).toBe(2);

    running = await boot({ publisher: true });
    expect(running.httpPort).toBeUndefined();
    expect(running.runners).toEqual(['outbox-publisher']);

    expect(await waitFor(async () => (await pendingOutbox(orm, [wallet.id])) === 0)).toBe(true);
    await httpOnly.stop();
  });

  test('a consumer-only instance processes the queue without serving HTTP', async () => {
    const wallet = await newWalletViaApp();
    running = await boot({ consumer: true });
    const message = wagerMessage(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);

    expect(await waitFor(async () => (await transactionsOf(orm, message.data.externalTransactionId)).length === 1)).toBe(true);
    expect(running.httpPort).toBeUndefined();
    expect(running.runners).toEqual(['sqs-consumer']);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('stop() ends every runner and returns promptly even while the consumer is long-polling', async () => {
    running = await boot({ consumer: true, publisher: true, worker: true });
    await Bun.sleep(300);

    const started = Date.now();
    await running.stop();
    running = undefined;

    expect(Date.now() - started).toBeLessThan(5000);
  });
});

async function newWalletViaApp() {
  const { newWallet } = await import('../../support/wager-messages');
  return newWallet(orm, '500.00');
}
