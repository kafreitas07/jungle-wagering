import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { createTestQueues, testSqsClient, type TestQueues } from '../../support/queues';
import { uuid } from '../../support/sql';

let queues: TestQueues;

beforeAll(async () => {
  queues = await createTestQueues({ visibilityTimeoutSeconds: 30, maxReceiveCount: 5 });
});

afterAll(async () => {
  await queues.destroy();
});

const sendOne = (group = `group-${uuid()}`, body = `body-${uuid()}`, deduplicationId = uuid()) =>
  queues.adapter.send(queues.wager, { body, groupId: group, deduplicationId }).then(() => ({ group, body, deduplicationId }));

const receiveOne = async (waitSeconds = 3) => {
  const [message] = await queues.adapter.receive(queues.wager, { maxMessages: 1, waitSeconds });
  return message;
};

describe('SqsAdapter on a real FIFO queue (DOC-01)', () => {
  test('sends with a group and a deduplication id, and receives body, group and receive count', async () => {
    const sent = await sendOne();

    const message = await receiveOne();

    expect(message).toMatchObject({ body: sent.body, groupId: sent.group, receiveCount: 1 });
    expect(message?.receiptHandle).toBeString();
    await queues.adapter.delete(queues.wager, message!.receiptHandle);
  });

  test('delete removes the message for good', async () => {
    const sent = await sendOne();
    const message = await receiveOne();
    expect(message?.body).toBe(sent.body);

    await queues.adapter.delete(queues.wager, message!.receiptHandle);
    await queues.adapter.changeVisibility(queues.wager, message!.receiptHandle, 0).catch(() => undefined);

    expect(await queues.adapter.receive(queues.wager, { maxMessages: 1, waitSeconds: 1 })).toHaveLength(0);
  });

  test('changeVisibility(0) makes the message available again right away, with a higher receive count', async () => {
    const sent = await sendOne();
    const first = await receiveOne();
    expect(first?.receiveCount).toBe(1);

    await queues.adapter.changeVisibility(queues.wager, first!.receiptHandle, 0);
    const second = await receiveOne();

    expect(second?.body).toBe(sent.body);
    expect(second?.receiveCount).toBe(2);
    await queues.adapter.delete(queues.wager, second!.receiptHandle);
  });

  test('an unacknowledged message is hidden while it is in flight', async () => {
    await sendOne();
    const first = await receiveOne();
    expect(first).toBeDefined();

    expect(await queues.adapter.receive(queues.wager, { maxMessages: 1, waitSeconds: 1 })).toHaveLength(0);

    await queues.adapter.delete(queues.wager, first!.receiptHandle);
  });

  test('the same deduplication id sent twice produces a single message', async () => {
    const dedup = uuid();
    const group = `group-${uuid()}`;
    await queues.adapter.send(queues.wager, { body: 'once', groupId: group, deduplicationId: dedup });
    await queues.adapter.send(queues.wager, { body: 'once', groupId: group, deduplicationId: dedup });

    const first = await receiveOne();
    await queues.adapter.delete(queues.wager, first!.receiptHandle);

    expect(first?.body).toBe('once');
    expect(await queues.adapter.receive(queues.wager, { maxMessages: 1, waitSeconds: 1 })).toHaveLength(0);
  });

  test('messages of one group are delivered in the order they were sent', async () => {
    const group = `group-${uuid()}`;
    for (const n of [1, 2, 3, 4]) {
      await queues.adapter.send(queues.wager, { body: `m${n}`, groupId: group, deduplicationId: uuid() });
    }

    const bodies: string[] = [];
    while (bodies.length < 4) {
      for (const message of await queues.adapter.receive(queues.wager, { maxMessages: 10, waitSeconds: 2 })) {
        bodies.push(message.body);
        await queues.adapter.delete(queues.wager, message.receiptHandle);
      }
    }
    expect(bodies).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('a message received 5 times without acknowledgement lands in the DLQ', async () => {
    const dedicated = await createTestQueues({ visibilityTimeoutSeconds: 30, maxReceiveCount: 5 });
    try {
      const sent = { body: `poison-${uuid()}`, groupId: `group-${uuid()}`, deduplicationId: uuid() };
      await dedicated.adapter.send(dedicated.wager, sent);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const [message] = await dedicated.adapter.receive(dedicated.wager, { maxMessages: 1, waitSeconds: 3 });
        expect(message?.receiveCount).toBe(attempt);
        await dedicated.adapter.changeVisibility(dedicated.wager, message!.receiptHandle, 0);
      }
      const sixth = await dedicated.adapter.receive(dedicated.wager, { maxMessages: 1, waitSeconds: 1 });
      const inDlq = await dedicated.adapter.receive(dedicated.dlq, { maxMessages: 1, waitSeconds: 3 });

      expect(sixth).toHaveLength(0);
      expect(inDlq).toHaveLength(1);
      expect(inDlq[0]?.body).toBe(sent.body);
    } finally {
      await dedicated.destroy();
    }
  });

  test('publishBatch sends outbox messages with group = wallet and deduplication id = event id, 25 at once', async () => {
    const walletA = uuid();
    const walletB = uuid();
    const messages = Array.from({ length: 25 }, (_, index) => {
      const aggregateId = index % 2 === 0 ? walletA : walletB;
      return OutboxMessage.rehydrate({
        id: uuid(),
        aggregateId,
        groupKey: aggregateId,
        eventType: 'WalletBalanceChanged',
        payload: { eventId: 'x', index },
        occurredAt: new Date(),
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedUntil: null,
        publishedAt: null,
        lastError: null,
      });
    });

    const result = await queues.adapter.publishBatch(messages);
    const received = await queues.drain(queues.events, 2);

    expect(result.failed).toEqual([]);
    expect([...result.published].sort()).toEqual(messages.map((message) => message.id).sort());
    expect(received).toHaveLength(25);
    expect(new Set(received.map((message) => message.groupId))).toEqual(new Set([walletA, walletB]));
    expect(received.filter((message) => message.groupId === walletA)).toHaveLength(13);
    expect(JSON.parse(received[0]!.body)).toMatchObject({ eventId: 'x' });
  });

  test('publishing the same event twice is deduplicated by the queue', async () => {
    const wallet = uuid();
    const message = OutboxMessage.rehydrate({
      id: uuid(),
      aggregateId: wallet,
      groupKey: wallet,
      eventType: 'WagerTransactionProcessed',
      payload: { once: true },
      occurredAt: new Date(),
      attempts: 0,
      nextAttemptAt: new Date(),
      lockedUntil: null,
      publishedAt: null,
      lastError: null,
    });

    await queues.adapter.publishBatch([message]);
    await queues.adapter.publishBatch([message]);

    expect(await queues.drain(queues.events, 2)).toHaveLength(1);
  });

  test('sending to a queue that does not exist fails and the lookup is not cached', async () => {
    const adapter = new (await import('../../../src/infrastructure/messaging/sqs.adapter')).SqsAdapter(queues.client, 'nope.fifo');

    await expect(adapter.publishBatch([])).rejects.toThrow();
    await expect(adapter.send(`missing-${uuid()}.fifo`, { body: 'x', groupId: 'g', deduplicationId: uuid() })).rejects.toThrow();
  });
});

describe('the queues of docker compose (init-queues.sh)', () => {
  test.each(['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wallet-events.fifo'])('%s exists and is FIFO', async (name) => {
    const client = testSqsClient();
    const adapter = new (await import('../../../src/infrastructure/messaging/sqs.adapter')).SqsAdapter(client, name);

    const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: await adapter.queueUrl(name), AttributeNames: ['All'] }));

    expect(attributes.Attributes?.FifoQueue).toBe('true');
    client.destroy();
  });

  test('wager-transactions.fifo redrives to the DLQ after 5 receives', async () => {
    const client = testSqsClient();
    const adapter = new (await import('../../../src/infrastructure/messaging/sqs.adapter')).SqsAdapter(client, 'wallet-events.fifo');

    const attributes = await client.send(
      new GetQueueAttributesCommand({ QueueUrl: await adapter.queueUrl('wager-transactions.fifo'), AttributeNames: ['RedrivePolicy'] }),
    );
    const policy = JSON.parse(attributes.Attributes!.RedrivePolicy!);

    expect(Number(policy.maxReceiveCount)).toBe(5);
    expect(policy.deadLetterTargetArn).toContain('wager-transactions-dlq.fifo');
    client.destroy();
  });
});
