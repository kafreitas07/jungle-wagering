import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SqsConsumer } from '../../../src/infrastructure/messaging/sqs-consumer';
import { SqsAdapter } from '../../../src/infrastructure/messaging/sqs.adapter';
import { RecordingLogger, RecordingMetrics } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createTestQueues, type TestQueues } from '../../support/queues';
import { assertReconciledViaApp } from '../../support/reconcile';
import { sql, uuid } from '../../support/sql';
import {
  balanceOf,
  countFor,
  newWallet,
  sendMessage,
  submitUseCase,
  transactionsOf,
  type TestWallet,
  waitFor,
  wagerMessage,
} from '../../support/wager-messages';

let orm: MikroORM;
let queues: TestQueues;
let metrics: RecordingMetrics;
let logger: RecordingLogger;
let consumer: SqsConsumer | undefined;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

// Fresh queues per test: a leftover message or DLQ entry of one test can never satisfy another test's wait.
beforeEach(async () => {
  metrics = new RecordingMetrics();
  logger = new RecordingLogger();
  queues = await createTestQueues({ visibilityTimeoutSeconds: 2 });
});

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await queues.destroy();
});

function startConsumer(adapter: SqsAdapter = queues.adapter, overrides: { maxReceiveCount?: number } = {}): SqsConsumer {
  consumer = new SqsConsumer(
    { adapter, submit: submitUseCase(orm), metrics, logger },
    { queue: queues.wager, dlq: queues.dlq, pollWaitSeconds: 1, maxReceiveCount: overrides.maxReceiveCount ?? 5, shutdownGraceMs: 5000 },
  );
  consumer.start();
  return consumer;
}

const send = (wallet: TestWallet, message: unknown) => sendMessage(queues.adapter, queues.wager, message, wallet.id);
const queueEmpty = () => queues.isEmpty(queues.wager);
const handled = (externalTransactionId: string) => async () => (await transactionsOf(orm, externalTransactionId)).length > 0;

describe('a valid message goes through the same use case as the API (SQS-01, SQS-05)', () => {
  test('it is processed: transaction PROCESSED, balance and ledger moved, message acknowledged', async () => {
    const wallet = await newWallet(orm, '1000.00');
    const message = wagerMessage(wallet);
    await send(wallet, message);

    startConsumer();
    expect(await waitFor(handled(message.data.externalTransactionId))).toBe(true);
    await consumer!.stop();

    const [row] = await transactionsOf(orm, message.data.externalTransactionId);
    expect(row).toMatchObject({ status: 'PROCESSED', balance_after: '975.00' });
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await countFor(orm, 'wallet_ledger_entries', wallet.id, `and direction = 'DEBIT'`)).toBe(1);
    expect(await queueEmpty()).toBe(true);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a business rejection is stored as REJECTED and acknowledged, never retried', async () => {
    const wallet = await newWallet(orm, '10.00');
    const message = wagerMessage(wallet, { data: { money: { amount: '99.00', currency: 'BRL' } } });
    await send(wallet, message);

    startConsumer();
    expect(await waitFor(handled(message.data.externalTransactionId))).toBe(true);
    await consumer!.stop();

    expect((await transactionsOf(orm, message.data.externalTransactionId))[0]).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(await balanceOf(orm, wallet.id)).toBe('10.00');
    expect(await queueEmpty()).toBe(true);
    expect(await queues.depth(queues.dlq)).toBe(0);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('a reversal whose reference has not arrived is stored as PENDING_REFERENCE and acknowledged', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet, { data: { kind: 'ROLLBACK', referenceExternalTransactionId: `bet-${uuid()}` } });
    await send(wallet, message);

    startConsumer();
    expect(await waitFor(handled(message.data.externalTransactionId))).toBe(true);
    await consumer!.stop();

    expect((await transactionsOf(orm, message.data.externalTransactionId))[0]?.status).toBe('PENDING_REFERENCE');
    expect(await queueEmpty()).toBe(true);
  });

  test('the same message twice produces one transaction and one ledger entry and counts a duplicate (SQS-03)', async () => {
    const wallet = await newWallet(orm, '1000.00');
    const message = wagerMessage(wallet);
    await send(wallet, message);
    await send(wallet, message);

    startConsumer();
    expect(await waitFor(() => metrics.total('inbox_duplicates_total') === 1)).toBe(true);
    await consumer!.stop();

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    expect(await countFor(orm, 'wallet_ledger_entries', wallet.id, `and direction = 'DEBIT'`)).toBe(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await queueEmpty()).toBe(true);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('the inbox row is stored with the message id and a payload hash, marked processed', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await send(wallet, message);

    startConsumer();
    await waitFor(handled(message.data.externalTransactionId));
    await consumer!.stop();

    const rows = await sql(orm, 'select consumer_name, payload_hash, processed_at from inbox_messages where message_id = ?', [message.messageId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumer_name).toBe('wager-transactions-consumer');
    expect(String(rows[0]?.payload_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  test('messages of one wallet are applied in the order they were sent (FIFO group)', async () => {
    const wallet = await newWallet(orm, '100.00');
    const first = wagerMessage(wallet, { data: { money: { amount: '80.00', currency: 'BRL' } } });
    const second = wagerMessage(wallet, { data: { money: { amount: '80.00', currency: 'BRL' } } });
    await send(wallet, first);
    await send(wallet, second);

    startConsumer();
    expect(await waitFor(handled(second.data.externalTransactionId))).toBe(true);
    await consumer!.stop();

    expect((await transactionsOf(orm, first.data.externalTransactionId))[0]?.status).toBe('PROCESSED');
    expect((await transactionsOf(orm, second.data.externalTransactionId))[0]?.failure_code).toBe('INSUFFICIENT_FUNDS');
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('many wallets are processed in parallel and all end consistent', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => newWallet(orm, '100.00')));
    const messages = wallets.flatMap((wallet) => Array.from({ length: 3 }, () => ({ wallet, message: wagerMessage(wallet, { data: { money: { amount: '10.00', currency: 'BRL' } } }) })));
    for (const { wallet, message } of messages) {
      await send(wallet, message);
    }

    startConsumer();
    expect(await waitFor(async () => (await Promise.all(messages.map(({ message }) => handled(message.data.externalTransactionId)()))).every(Boolean))).toBe(true);
    await consumer!.stop();

    for (const wallet of wallets) {
      expect(await balanceOf(orm, wallet.id)).toBe('70.00');
    }
    await assertReconciledViaApp(orm, wallets.map((wallet) => wallet.id));
  });
});

describe('invalid and conflicting messages go to the DLQ and are acknowledged (SQS-08, SQS-11, SQS-12, SQS-13)', () => {
  const dlqBodies = async () => (await queues.drain(queues.dlq, 2)).map((entry) => entry.body);

  async function consumeUntilDeadLettered(count = 1) {
    startConsumer();
    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= count)).toBe(true);
    await consumer!.stop();
  }

  test('a body that is not JSON', async () => {
    const wallet = await newWallet(orm);
    await sendMessage(queues.adapter, queues.wager, 'this is { not json', wallet.id);

    await consumeUntilDeadLettered();

    expect(await dlqBodies()).toEqual(['this is { not json']);
    expect(await queueEmpty()).toBe(true);
    expect(metrics.counts.some((entry) => entry.metric === 'dlq_messages_total' && entry.labels?.reason === 'malformed_json')).toBe(true);
  });

  test('an amount without two decimals', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet, { data: { money: { amount: '25', currency: 'BRL' } } });
    await send(wallet, message);

    await consumeUntilDeadLettered();

    expect(await dlqBodies()).toHaveLength(1);
    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
    expect(await queueEmpty()).toBe(true);
  });

  test('kind OPENING', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet, { data: { kind: 'OPENING' } });
    await send(wallet, message);

    await consumeUntilDeadLettered();

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
    expect(await sql(orm, 'select 1 from inbox_messages where message_id = ?', [message.messageId])).toHaveLength(0);
  });

  test('the reserved provider "internal" gets the same validation as the API', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet, { data: { providerId: 'internal' } });
    await send(wallet, message);

    await consumeUntilDeadLettered();

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
  });

  test('a wrong message type', async () => {
    const wallet = await newWallet(orm);
    await send(wallet, wagerMessage(wallet, { envelope: { type: 'SomethingElse' } }));

    await consumeUntilDeadLettered();

    expect(await dlqBodies()).toHaveLength(1);
  });

  test('a messageId above 255 characters is malformed; exactly 255 is accepted', async () => {
    const wallet = await newWallet(orm);
    const tooLong = wagerMessage(wallet, { messageId: 'm'.repeat(256) });
    const limit = wagerMessage(wallet, { messageId: 'm'.repeat(255) });
    await send(wallet, tooLong);
    await send(wallet, limit);

    startConsumer();
    expect(await waitFor(handled(limit.data.externalTransactionId))).toBe(true);
    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 1)).toBe(true);
    await consumer!.stop();

    expect(await transactionsOf(orm, tooLong.data.externalTransactionId)).toHaveLength(0);
    expect(await sql(orm, 'select 1 from inbox_messages where message_id = ?', [tooLong.messageId])).toHaveLength(0);
    expect((await transactionsOf(orm, limit.data.externalTransactionId))[0]?.status).toBe('PROCESSED');
    expect(JSON.parse((await dlqBodies())[0]!).messageId).toBe(tooLong.messageId);
    expect(await queueEmpty()).toBe(true);
  });

  test('the same messageId with a different payload: the first is processed, the second is dead-lettered and counted', async () => {
    const wallet = await newWallet(orm, '1000.00');
    const original = wagerMessage(wallet);
    const reused = wagerMessage(wallet, { messageId: original.messageId, data: { money: { amount: '30.00', currency: 'BRL' } } });
    await send(wallet, original);
    startConsumer();
    expect(await waitFor(handled(original.data.externalTransactionId))).toBe(true);
    await send(wallet, reused);

    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 1)).toBe(true);
    await consumer!.stop();

    expect(metrics.total('inbox_payload_conflict_total')).toBe(1);
    expect(await transactionsOf(orm, reused.data.externalTransactionId)).toHaveLength(0);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    expect(await queueEmpty()).toBe(true);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('IDEMPOTENCY_KEY_REUSED: same key, other payload → DLQ, counted, nothing written', async () => {
    const wallet = await newWallet(orm, '1000.00');
    const first = wagerMessage(wallet);
    const clash = wagerMessage(wallet, {
      data: { providerId: first.data.providerId, idempotencyKey: first.data.idempotencyKey, money: { amount: '99.00', currency: 'BRL' } },
    });
    await send(wallet, first);
    startConsumer();
    expect(await waitFor(handled(first.data.externalTransactionId))).toBe(true);
    await send(wallet, clash);

    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 1)).toBe(true);
    await consumer!.stop();

    expect(metrics.total('idempotency_conflicts_total')).toBe(1);
    expect(await transactionsOf(orm, clash.data.externalTransactionId)).toHaveLength(0);
    expect(await countFor(orm, 'wager_transactions', wallet.id, `and provider_id <> 'internal'`)).toBe(1);
    await assertReconciledViaApp(orm, [wallet.id]);
  });

  test('EXTERNAL_ID_CONFLICT: same external id under another key → DLQ, counted, nothing written', async () => {
    const wallet = await newWallet(orm, '1000.00');
    const first = wagerMessage(wallet);
    const clash = wagerMessage(wallet, { data: { providerId: first.data.providerId, externalTransactionId: first.data.externalTransactionId } });
    await send(wallet, first);
    startConsumer();
    expect(await waitFor(handled(first.data.externalTransactionId))).toBe(true);
    await send(wallet, clash);

    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 1)).toBe(true);
    await consumer!.stop();

    expect(metrics.total('idempotency_conflicts_total')).toBe(1);
    expect(await countFor(orm, 'wager_transactions', wallet.id, `and provider_id <> 'internal'`)).toBe(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
  });
});

describe('dead letters keep their identity', () => {
  test('two bad messages of one wallet both reach the DLQ, in that wallet\'s group (no collapse by deduplication)', async () => {
    const wallet = await newWallet(orm);
    await sendMessage(queues.adapter, queues.wager, 'bad one {', wallet.id);
    await sendMessage(queues.adapter, queues.wager, 'bad two {', wallet.id);

    startConsumer();
    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 2)).toBe(true);
    await consumer!.stop();

    const dead = await queues.drain(queues.dlq, 2);
    expect(dead.map((entry) => entry.body).sort()).toEqual(['bad one {', 'bad two {']);
    expect(dead.map((entry) => entry.groupId)).toEqual([wallet.id, wallet.id]);
  });

  test('a domain error raised while applying the message is a permanent failure: DLQ, not a retry', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await send(wallet, message);
    const { InvalidMoneyError } = await import('../../../src/domain/errors/domain-errors');
    const refusing = {
      executeFromQueue: async () => {
        throw new InvalidMoneyError('impossible amount');
      },
    } as unknown as ReturnType<typeof submitUseCase>;
    consumer = new SqsConsumer(
      { adapter: queues.adapter, submit: refusing, metrics, logger },
      { queue: queues.wager, dlq: queues.dlq, pollWaitSeconds: 1, maxReceiveCount: 5, shutdownGraceMs: 5000 },
    );
    consumer.start();

    expect(await waitFor(async () => (await queues.depth(queues.dlq)) >= 1)).toBe(true);
    await consumer.stop();

    expect(await queueEmpty()).toBe(true);
    expect(metrics.counts.some((entry) => entry.metric === 'dlq_messages_total' && entry.labels?.reason === 'domain_error')).toBe(true);
  });

  test('the message id travels as correlation and causation id into the events of the operation', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await send(wallet, message);

    startConsumer();
    expect(await waitFor(handled(message.data.externalTransactionId))).toBe(true);
    await consumer!.stop();

    const [transaction] = await transactionsOf(orm, message.data.externalTransactionId);
    const events = await sql(orm, `select payload from outbox_messages where payload->'data'->>'transactionId' = ?`, [String(transaction!.id)]);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.payload).toMatchObject({ correlationId: message.messageId, causationId: message.messageId });
    }
  });
});

describe('messages that cannot be applied but are not worth a retry', () => {
  test('an unknown wallet is acknowledged with a warning and writes nothing', async () => {
    const wallet = await newWallet(orm);
    const message = wagerMessage({ id: uuid(), playerId: wallet.playerId });
    await sendMessage(queues.adapter, queues.wager, message, message.data.walletId);

    startConsumer();
    expect(await waitFor(() => logger.at('warn').some((entry) => entry.message === 'message refused before processing'))).toBe(true);
    await consumer!.stop();

    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(0);
    expect(logger.at('warn')[0]?.context).toMatchObject({ code: 'WALLET_NOT_FOUND', messageId: message.messageId });
    expect(await queueEmpty()).toBe(true);
    expect(await queues.depth(queues.dlq)).toBe(0);
  });

  test('another player or another currency is acknowledged without storing anything', async () => {
    const wallet = await newWallet(orm);
    const otherPlayer = wagerMessage(wallet, { data: { playerId: uuid() } });
    const otherCurrency = wagerMessage(wallet, { data: { money: { amount: '5.00', currency: 'USD' } } });
    await send(wallet, otherPlayer);
    await send(wallet, otherCurrency);

    startConsumer();
    expect(await waitFor(() => logger.at('warn').length >= 2)).toBe(true);
    await consumer!.stop();

    expect(logger.at('warn').map((entry) => entry.context?.code).sort()).toEqual(['CURRENCY_MISMATCH', 'WALLET_PLAYER_MISMATCH']);
    expect(await transactionsOf(orm, otherPlayer.data.externalTransactionId)).toHaveLength(0);
    expect(await transactionsOf(orm, otherCurrency.data.externalTransactionId)).toHaveLength(0);
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});

describe('the acknowledgement comes only after the commit (SQS-04)', () => {
  class SpyAdapter extends SqsAdapter {
    readonly stateAtDelete: { committed: boolean }[] = [];
    externalId = '';

    override async delete(queue: string, receiptHandle: string): Promise<void> {
      if (this.externalId !== '') {
        this.stateAtDelete.push({ committed: (await transactionsOf(orm, this.externalId)).length === 1 });
      }
      return super.delete(queue, receiptHandle);
    }
  }

  test('when the message is deleted, its transaction is already visible to other connections', async () => {
    const spy = new SpyAdapter(queues.client, queues.events);
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    spy.externalId = message.data.externalTransactionId;
    await send(wallet, message);

    startConsumer(spy);
    expect(await waitFor(() => spy.stateAtDelete.length > 0)).toBe(true);
    await consumer!.stop();

    expect(spy.stateAtDelete).toEqual([{ committed: true }]);
  });

  test('if the acknowledgement fails the effect stays, and the redelivery is recognised as a duplicate', async () => {
    class FailingDelete extends SqsAdapter {
      failures = 1;
      override async delete(queue: string, receiptHandle: string): Promise<void> {
        if (this.failures > 0) {
          this.failures -= 1;
          throw new Error('network down during delete');
        }
        return super.delete(queue, receiptHandle);
      }
    }
    const flaky = new FailingDelete(queues.client, queues.events);
    const wallet = await newWallet(orm, '1000.00');
    const message = wagerMessage(wallet);
    await send(wallet, message);

    startConsumer(flaky);
    expect(await waitFor(() => metrics.total('inbox_duplicates_total') === 1, 20_000)).toBe(true);
    await consumer!.stop();

    expect(logger.at('error').some((entry) => entry.message === 'could not settle message')).toBe(true);
    expect(await transactionsOf(orm, message.data.externalTransactionId)).toHaveLength(1);
    expect(await balanceOf(orm, wallet.id)).toBe('975.00');
    await assertReconciledViaApp(orm, [wallet.id]);
  });
});
