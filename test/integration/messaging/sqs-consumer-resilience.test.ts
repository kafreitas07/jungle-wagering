import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { TxRepositories, UnitOfWork } from '../../../src/application/ports';
import { SubmitWagerTransaction } from '../../../src/application/use-cases/submit-wager-transaction';
import { SqsConsumer } from '../../../src/infrastructure/messaging/sqs-consumer';
import { SqsAdapter } from '../../../src/infrastructure/messaging/sqs.adapter';
import { FakeClock, RecordingLogger, RecordingMetrics, testUnitOfWork } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createTestQueues, type TestQueues } from '../../support/queues';
import { assertReconciledViaApp } from '../../support/reconcile';
import {
  balanceOf,
  newWallet,
  policy,
  sendMessage,
  transactionsOf,
  type TestWallet,
  waitFor,
  wagerMessage,
} from '../../support/wager-messages';

let orm: MikroORM;
let queues: TestQueues;
let metrics: RecordingMetrics;
let logger: RecordingLogger;
const consumers: SqsConsumer[] = [];

const databaseDown = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });

/** Fails the first `failures` transactions (Infinity: always) like a database that is down, then behaves. */
class FlakyUnitOfWork implements UnitOfWork {
  calls = 0;

  constructor(
    private readonly inner: UnitOfWork,
    private failures: number,
    private readonly delayMs = 0,
  ) {}

  async run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
    this.calls += 1;
    if (this.delayMs > 0) {
      await Bun.sleep(this.delayMs);
    }
    if (this.failures > 0) {
      this.failures -= 1;
      throw databaseDown();
    }
    return this.inner.run(work);
  }

  recover(): void {
    this.failures = 0;
  }
}

/** Records what the consumer asks of the queue; optionally turns every backoff into 0 so retries run fast. */
class SpyAdapter extends SqsAdapter {
  readonly visibility: number[] = [];
  readonly deleted: string[] = [];
  immediateRetries = false;

  override async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    this.visibility.push(seconds);
    return super.changeVisibility(queue, receiptHandle, this.immediateRetries ? 0 : seconds);
  }

  override async delete(queue: string, receiptHandle: string): Promise<void> {
    this.deleted.push(receiptHandle);
    return super.delete(queue, receiptHandle);
  }
}

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

beforeEach(async () => {
  metrics = new RecordingMetrics();
  logger = new RecordingLogger();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 30, maxReceiveCount: 5 });
});

afterEach(async () => {
  for (const consumer of consumers.splice(0)) {
    await consumer.stop();
  }
  await queues.destroy();
});

function consumerOver(
  unitOfWork: UnitOfWork,
  adapter: SqsAdapter,
  options: { pollWaitSeconds?: number; shutdownGraceMs?: number } = {},
): SqsConsumer {
  const submit = new SubmitWagerTransaction({ unitOfWork, clock: new FakeClock(), referencePolicy: policy });
  const consumer = new SqsConsumer(
    { adapter, submit, metrics, logger },
    { queue: queues.wager, dlq: queues.dlq, pollWaitSeconds: options.pollWaitSeconds ?? 1, maxReceiveCount: 5, shutdownGraceMs: options.shutdownGraceMs ?? 5000 },
  );
  consumers.push(consumer);
  return consumer;
}

const send = (wallet: TestWallet, message: unknown) => sendMessage(queues.adapter, queues.wager, message, wallet.id);
const handled = (externalTransactionId: string) => async () => (await transactionsOf(orm, externalTransactionId)).length > 0;

describe('a transient failure is not acknowledged and is retried with backoff (SQS-06)', () => {
  test('database down: no acknowledgement, the message is hidden for 4 s, and it is processed once the database is back', async () => {
    const adapter = new SpyAdapter(queues.client, queues.events);
    const flaky = new FlakyUnitOfWork(testUnitOfWork(orm), 1);
    const wallet = await newWallet(orm, '1000.00');
    const message = wagerMessage(wallet);
    await send(wallet, message);

    const consumer = consumerOver(flaky, adapter);
    consumer.start();
    expect(await waitFor(() => adapter.visibility.length > 0)).toBe(true);
    const failedAttemptDeletes = adapter.deleted.length;
    const processedEarly = (await transactionsOf(orm, message.data.externalTransactionId)).length;
    expect(await waitFor(handled(message.data.externalTransactionId), 20_000)).toBe(true);
    await consumer.stop();

    expect(adapter.visibility[0]).toBe(4);
    expect(failedAttemptDeletes).toBe(0);
    expect(processedEarly).toBe(0);
    expect(logger.at('error').some((entry) => entry.message === 'transient failure, message left for redelivery')).toBe(true);
    expect(metrics.total('retries_total')).toBe(1);
    expect(adapter.deleted).toHaveLength(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a failing message does not let the next message of the same wallet overtake it', async () => {
    const adapter = new SpyAdapter(queues.client, queues.events);
    adapter.immediateRetries = true;
    const flaky = new FlakyUnitOfWork(testUnitOfWork(orm), 3);
    const wallet = await newWallet(orm, '100.00');
    const first = wagerMessage(wallet, { data: { money: { amount: '80.00', currency: 'BRL' } } });
    const second = wagerMessage(wallet, { data: { money: { amount: '80.00', currency: 'BRL' } } });
    await send(wallet, first);
    await send(wallet, second);

    const consumer = consumerOver(flaky, adapter);
    consumer.start();
    expect(await waitFor(handled(second.data.externalTransactionId), 30_000)).toBe(true);
    await consumer.stop();

    expect((await transactionsOf(orm, first.data.externalTransactionId))[0]?.status).toBe('PROCESSED');
    expect((await transactionsOf(orm, second.data.externalTransactionId))[0]?.failure_code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(orm, wallet.id)).toBe('20.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('a message that keeps failing ends in the DLQ after 5 receives (SQS-07)', () => {
  test('backoffs grow, the last receive is counted as a dead letter, and the queue moves the message', async () => {
    const adapter = new SpyAdapter(queues.client, queues.events);
    adapter.immediateRetries = true;
    const alwaysDown = new FlakyUnitOfWork(testUnitOfWork(orm), Infinity);
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await send(wallet, message);

    const consumer = consumerOver(alwaysDown, adapter);
    consumer.start();
    expect(await waitFor(async () => (await queues.depth(queues.dlq)) === 1, 30_000)).toBe(true);
    await consumer.stop();

    expect(adapter.visibility).toEqual([4, 8, 16, 32, 0]);
    expect(metrics.total('retries_total')).toBe(5);
    expect(metrics.counts.filter((entry) => entry.metric === 'dlq_messages_total')).toEqual([
      { metric: 'dlq_messages_total', labels: { reason: 'max_receives' } },
    ]);
    const inDlq = await queues.drain(queues.dlq, 2);
    expect(JSON.parse(inDlq[0]!.body).messageId).toBe(message.messageId);
    expect(await queues.isEmpty(queues.wager)).toBe(true);
    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('SIGTERM: graceful shutdown (SQS-10)', () => {
  test('an idle consumer stops at once, without waiting for the long poll', async () => {
    const consumer = consumerOver(testUnitOfWork(orm), new SpyAdapter(queues.client, queues.events), { pollWaitSeconds: 20 });
    consumer.start();
    await Bun.sleep(300);

    const started = Date.now();
    await consumer.stop();

    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the message in progress finishes and is acknowledged; the others are handed back and another instance takes them', async () => {
    const adapter = new SpyAdapter(queues.client, queues.events);
    const slow = new FlakyUnitOfWork(testUnitOfWork(orm), 0, 1200);
    const wallet = await newWallet(orm, '1000.00');
    const messages = [1, 2, 3].map(() => wagerMessage(wallet));
    for (const message of messages) {
      await send(wallet, message);
    }

    const first = consumerOver(slow, adapter);
    first.start();
    expect(await waitFor(() => slow.calls >= 1)).toBe(true);
    const stopping = Date.now();
    await first.stop();
    const stopTook = Date.now() - stopping;

    const done = await Promise.all(messages.map((message) => transactionsOf(orm, message.data.externalTransactionId)));
    expect(done.map((rows) => rows.length)).toEqual([1, 0, 0]);
    expect(adapter.deleted).toHaveLength(1);
    expect(adapter.visibility).toEqual([0, 0]);
    expect(stopTook).toBeLessThan(5000);

    // Released with visibility 0, the rest is available right away (the queue's own timeout is 30 s).
    const second = consumerOver(testUnitOfWork(orm), new SpyAdapter(queues.client, queues.events));
    second.start();
    expect(await waitFor(handled(messages[2]!.data.externalTransactionId), 10_000)).toBe(true);
    await second.stop();

    expect(await balanceOf(orm, wallet.id)).toBe('925.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('when the grace period runs out, the unfinished message is handed back instead of waiting for it', async () => {
    const adapter = new SpyAdapter(queues.client, queues.events);
    const verySlow = new FlakyUnitOfWork(testUnitOfWork(orm), 0, 2500);
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await send(wallet, message);

    const consumer = consumerOver(verySlow, adapter, { shutdownGraceMs: 300 });
    consumer.start();
    expect(await waitFor(() => verySlow.calls >= 1)).toBe(true);
    const started = Date.now();
    await consumer.stop();

    expect(Date.now() - started).toBeLessThan(1500);
    expect(adapter.visibility).toEqual([0]);
    expect(logger.at('warn').some((entry) => entry.message === 'consumer shutdown grace period elapsed')).toBe(true);
    // Whatever the abandoned run finishes, the redelivery is safe: the inbox recognises it.
    await waitFor(handled(message.data.externalTransactionId), 10_000);
    const again = consumerOver(testUnitOfWork(orm), new SpyAdapter(queues.client, queues.events));
    again.start();
    expect(await waitFor(() => queues.isEmpty(queues.wager), 15_000)).toBe(true);
    await again.stop();
    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
  });
});
