import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { EventPublisherPort, PublishBatchResult } from '../../../src/application/ports';
import { PublishOutboxBatch } from '../../../src/application/use-cases/publish-outbox-batch';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { OutboxPublisher } from '../../../src/infrastructure/messaging/outbox-publisher';
import { SqsAdapter } from '../../../src/infrastructure/messaging/sqs.adapter';
import { FakeClock, RecordingMetrics, testUnitOfWork } from '../../support/context';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { drainOutbox, openWallets, pendingOutbox } from '../../support/messaging';
import { createTestQueues, type TestQueues } from '../../support/queues';
import { sql, uuid } from '../../support/sql';

let orm: MikroORM;
let queues: TestQueues;
const clock = new FakeClock();

beforeAll(async () => {
  orm = await getTestOrm();
  queues = await createTestQueues();
});

afterAll(async () => {
  await queues.destroy();
  await closeTestOrm();
});

beforeEach(async () => {
  await drainOutbox(orm);
  if ((await queues.depth(queues.events)) > 0) {
    await queues.drain(queues.events, 1);
  }
});

const publisherWith = (publisher: EventPublisherPort, options: { batchSize?: number; leaseMs?: number } = {}) =>
  new PublishOutboxBatch({ unitOfWork: testUnitOfWork(orm), publisher, clock, ...options });

const realPublisher = () => publisherWith(queues.adapter);

class RecordingPublisher implements EventPublisherPort {
  readonly ids: string[] = [];

  constructor(private readonly inner: EventPublisherPort) {}

  async publishBatch(messages: readonly OutboxMessage[]): Promise<PublishBatchResult> {
    this.ids.push(...messages.map((message) => message.id));
    return this.inner.publishBatch(messages);
  }
}

const outboxRow = async (id: string) => (await sql(orm, 'select * from outbox_messages where id = ?', [id]))[0]!;

describe('events leave the outbox only after the commit (OUT-02, OUT-12)', () => {
  test('a row written in a transaction that has not committed is invisible to the publisher; after the commit it is published', async () => {
    const wallet = uuid();
    const message = OutboxMessage.rehydrate({
      id: uuid(), aggregateId: wallet, groupKey: wallet, eventType: 'WagerTransactionProcessed', payload: { eventId: 'pending-commit' },
      occurredAt: clock.now(), attempts: 0, nextAttemptAt: clock.now(), lockedUntil: null, publishedAt: null, lastError: null,
    });
    let beforeCommit = -1;
    let queueBeforeCommit = -1;

    await testUnitOfWork(orm).run(async (tx) => {
      await tx.outbox.enqueue(message);
      beforeCommit = (await realPublisher().execute()).claimed;
      queueBeforeCommit = await queues.depth(queues.events);
    });
    const afterCommit = await realPublisher().execute();

    expect(beforeCommit).toBe(0);
    expect(queueBeforeCommit).toBe(0);
    expect(afterCommit.published).toBe(1);
    expect((await queues.drain(queues.events, 2)).map((entry) => JSON.parse(entry.body).eventId)).toEqual(['pending-commit']);
  });

  test('a transaction that rolls back never reaches the queue', async () => {
    const wallet = uuid();
    const message = OutboxMessage.rehydrate({
      id: uuid(), aggregateId: wallet, groupKey: wallet, eventType: 'WagerTransactionProcessed', payload: { eventId: 'rolled-back' },
      occurredAt: clock.now(), attempts: 0, nextAttemptAt: clock.now(), lockedUntil: null, publishedAt: null, lastError: null,
    });

    await testUnitOfWork(orm)
      .run(async (tx) => {
        await tx.outbox.enqueue(message);
        throw new Error('business failure after enqueue');
      })
      .catch(() => undefined);

    expect((await realPublisher().execute()).claimed).toBe(0);
    expect(await queues.depth(queues.events)).toBe(0);
  });

  test('events are published with the wallet as group and the event id as deduplication id', async () => {
    const [wallet] = await openWallets(orm, clock, 1);

    const result = await realPublisher().execute();
    const received = await queues.drain(queues.events, 2);

    expect(result).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(received.map((entry) => entry.groupId)).toEqual([wallet, wallet]);
    const bodies = received.map((entry) => JSON.parse(entry.body));
    expect(new Set(bodies.map((body) => body.eventType))).toEqual(new Set(['WagerTransactionProcessed', 'WalletBalanceChanged']));
    const rows = await sql(orm, 'select id, published_at from outbox_messages where aggregate_id = ?', [wallet]);
    expect(rows.every((row) => row.published_at !== null)).toBe(true);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(bodies.map((body) => body.eventId)));
  });
});

describe('the publisher can be off and another one takes over (OUT-09, TEST-02)', () => {
  test('with no publisher running events pile up as pending; a publisher that starts later publishes all of them', async () => {
    const wallets = await openWallets(orm, clock, 5);
    expect(await pendingOutbox(orm, wallets)).toBe(10);
    expect(await queues.depth(queues.events)).toBe(0);

    const late = await realPublisher().execute();

    expect(late.published).toBe(10);
    expect(await pendingOutbox(orm, wallets)).toBe(0);
    expect(await queues.drain(queues.events, 2)).toHaveLength(10);
  });

  test('the runner drains a backlog bigger than one batch by itself and stops cleanly', async () => {
    const wallets = await openWallets(orm, clock, 15);
    const runner = new OutboxPublisher(publisherWith(queues.adapter, { batchSize: 10 }), { intervalMs: 50, batchSize: 10 });

    runner.start();
    const deadline = Date.now() + 15_000;
    while ((await pendingOutbox(orm, wallets)) > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    await runner.stop();

    expect(await pendingOutbox(orm, wallets)).toBe(0);
    expect(await queues.drain(queues.events, 2)).toHaveLength(30);
  });
});

describe('two publishers on the same outbox (OUT-08)', () => {
  test('every event is claimed by exactly one of them', async () => {
    const wallets = await openWallets(orm, clock, 40);
    const first = new RecordingPublisher(queues.adapter);
    const second = new RecordingPublisher(queues.adapter);
    const a = publisherWith(first, { batchSize: 10 });
    const b = publisherWith(second, { batchSize: 10 });

    const rounds = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? a : b).execute()));

    const claimedTwice = first.ids.filter((id) => second.ids.includes(id));
    expect(claimedTwice).toEqual([]);
    expect(new Set([...first.ids, ...second.ids]).size).toBe(first.ids.length + second.ids.length);
    expect(rounds.reduce((total, round) => total + round.published, 0)).toBe(first.ids.length + second.ids.length);
    expect(first.ids.length).toBeGreaterThan(0);
    expect(second.ids.length).toBeGreaterThan(0);
    expect(await pendingOutbox(orm, wallets)).toBe(80 - first.ids.length - second.ids.length);
  });
});

describe('a publisher that dies after the claim (OUT-09)', () => {
  test('its rows stay hidden while the lease is live and are published by another instance once it expires', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    const claimed = await testUnitOfWork(orm).run((tx) => tx.outbox.claimDue(clock.now(), 25, 30_000));
    expect(claimed).toHaveLength(2);
    const survivor = realPublisher();

    const during = await survivor.execute();
    clock.advance(29_000);
    const stillLeased = await survivor.execute();
    clock.advance(2_000);
    const afterExpiry = await survivor.execute();

    expect(during.claimed).toBe(0);
    expect(stillLeased.claimed).toBe(0);
    expect(afterExpiry.published).toBe(2);
    expect(await pendingOutbox(orm, [wallet!])).toBe(0);
  });
});

describe('the queue is unavailable (OUT-10)', () => {
  const unreachable = () => {
    const client = new SQSClient({ region: 'us-east-1', endpoint: 'http://127.0.0.1:1', maxAttempts: 1 });
    return new SqsAdapter(client, 'wallet-events.fifo');
  };

  test('attempts go up, the retry is scheduled with backoff, the error is kept and nothing is discarded', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    const failing = publisherWith(unreachable());
    const at = clock.now();

    const first = await failing.execute();
    const row = (await sql(orm, 'select * from outbox_messages where aggregate_id = ? order by occurred_at, id', [wallet]))[0]!;

    expect(first).toEqual({ claimed: 2, published: 0, failed: 2 });
    expect(row.attempts).toBe(1);
    expect(row.published_at).toBeNull();
    expect(row.locked_until).toBeNull();
    expect(new Date(String(row.next_attempt_at)).getTime()).toBe(at.getTime() + 1000);
    expect(String(row.last_error)).toBeString();
    expect(String(row.last_error).length).toBeGreaterThan(0);
    expect(await pendingOutbox(orm, [wallet!])).toBe(2);
  });

  test('each event that failed to publish is counted as a retry, and a clean round counts none', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    const metrics = new RecordingMetrics();
    const count = () => metrics.counts.filter((entry) => entry.metric === 'retries_total' && entry.labels?.reason === 'outbox_publish').length;

    await new PublishOutboxBatch({ unitOfWork: testUnitOfWork(orm), publisher: unreachable(), clock, metrics }).execute();
    expect(count()).toBe(2);

    clock.advance(10_000);
    await new PublishOutboxBatch({ unitOfWork: testUnitOfWork(orm), publisher: queues.adapter, clock, metrics }).execute();
    expect(count()).toBe(2);
    expect(await pendingOutbox(orm, [wallet!])).toBe(0);
  });

  test('the backoff doubles on each failure and the event is not tried before it is due', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    const failing = publisherWith(unreachable());
    await failing.execute();

    const tooEarly = await failing.execute();
    clock.advance(1000);
    await failing.execute();
    const rows = await sql(orm, 'select attempts, next_attempt_at from outbox_messages where aggregate_id = ?', [wallet]);

    expect(tooEarly.claimed).toBe(0);
    expect(rows.map((row) => row.attempts)).toEqual([2, 2]);
    const delays = rows.map((row) => new Date(String(row.next_attempt_at)).getTime() - clock.now().getTime());
    expect(delays).toEqual([2000, 2000]);
  });

  test('once the queue is back the pending events are published, with their attempts kept as history', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    await publisherWith(unreachable()).execute();
    clock.advance(1000);

    const recovered = await realPublisher().execute();
    const rows = await sql(orm, 'select attempts, published_at from outbox_messages where aggregate_id = ?', [wallet]);

    expect(recovered.published).toBe(2);
    expect(rows.every((row) => row.published_at !== null && row.attempts === 1)).toBe(true);
    expect(await queues.drain(queues.events, 2)).toHaveLength(2);
  });

  test('a message the queue rejects is retried alone; the others in the batch are published', async () => {
    const wallets = await openWallets(orm, clock, 2);
    const rejectOne: EventPublisherPort = {
      async publishBatch(messages) {
        const [rejected, ...rest] = messages;
        const published = await queues.adapter.publishBatch(rest);
        return { published: published.published, failed: [{ id: rejected!.id, error: 'InvalidParameterValue: rejected' }] };
      },
    };

    const result = await publisherWith(rejectOne).execute();

    expect(result).toEqual({ claimed: 4, published: 3, failed: 1 });
    const retried = await sql(orm, 'select attempts, last_error, published_at from outbox_messages where aggregate_id in (?, ?) and attempts = 1', wallets);
    expect(retried).toHaveLength(1);
    expect(retried[0]?.last_error).toBe('InvalidParameterValue: rejected');
    expect(retried[0]?.published_at).toBeNull();
  });

  test('a message the queue did not confirm is never assumed published', async () => {
    const wallets = await openWallets(orm, clock, 1);
    const silent: EventPublisherPort = { publishBatch: async () => ({ published: [], failed: [] }) };

    const result = await publisherWith(silent).execute();

    expect(result.failed).toBe(2);
    expect(await pendingOutbox(orm, wallets)).toBe(2);
  });
});

describe('no SQL transaction during the network call (OUT-12)', () => {
  test('while the batch is being sent the rows are not locked, and the claim is already committed', async () => {
    const wallets = await openWallets(orm, clock, 3);
    const observed: { lockable: boolean; leaseVisible: boolean; idleInTransaction: number }[] = [];
    const probing: EventPublisherPort = {
      async publishBatch(messages) {
        const ids = messages.map((message) => message.id);
        const lockable = await sql(orm, `select id from outbox_messages where id in (${ids.map(() => '?').join(', ')}) for update nowait`, ids).then(
          () => true,
          () => false,
        );
        const leased = await sql(orm, `select count(*)::int as n from outbox_messages where id in (${ids.map(() => '?').join(', ')}) and locked_until is not null`, ids);
        const idle = await sql(orm, `select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`);
        observed.push({ lockable, leaseVisible: leased[0]?.n === ids.length, idleInTransaction: Number(idle[0]?.n) });
        return queues.adapter.publishBatch(messages);
      },
    };

    await publisherWith(probing).execute();

    expect(observed).toEqual([{ lockable: true, leaseVisible: true, idleInTransaction: 0 }]);
    expect(await pendingOutbox(orm, wallets)).toBe(0);
  });
});

describe('batch size and order', () => {
  test('one round claims at most batchSize rows, oldest first, and the next round takes the rest', async () => {
    const wallets = await openWallets(orm, clock, 15);
    const recording = new RecordingPublisher(queues.adapter);
    const useCase = publisherWith(recording, { batchSize: 25 });

    const first = await useCase.execute();
    const second = await useCase.execute();

    expect(first.claimed).toBe(25);
    expect(second.claimed).toBe(5);
    const order = await sql(orm, `select id from outbox_messages where aggregate_id in (${wallets.map(() => '?').join(', ')}) order by occurred_at, id`, wallets);
    expect(recording.ids).toEqual(order.map((row) => String(row.id)));
  });

  test('an idle outbox costs nothing: no claim, no queue call', async () => {
    const recording = new RecordingPublisher(queues.adapter);

    const result = await publisherWith(recording).execute();

    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(recording.ids).toEqual([]);
  });
});

describe('stored message state', () => {
  test('a published row records when, and has no lease left', async () => {
    const [wallet] = await openWallets(orm, clock, 1);
    const at = clock.now();

    await realPublisher().execute();

    const row = (await sql(orm, 'select * from outbox_messages where aggregate_id = ? limit 1', [wallet]))[0]!;
    expect(new Date(String(row.published_at)).getTime()).toBe(at.getTime());
    expect(row.locked_until).toBeNull();
    expect(row.attempts).toBe(0);
    expect(await outboxRow(String(row.id))).toBeDefined();
  });
});
