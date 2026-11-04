import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { SqsConsumer } from '../../../src/infrastructure/messaging/sqs-consumer';
import { createLogger } from '../../../src/infrastructure/observability/logger';
import { api, startTestApp, type TestApp } from '../../support/app';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { createWallet, post, submission } from '../../support/http';
import { drainOutbox, parkPendingTransactions } from '../../support/messaging';
import { createTestQueues, type TestQueues } from '../../support/queues';
import { sql, uuid } from '../../support/sql';
import { newWallet, sendMessage, submitUseCase, transactionsOf, wagerMessage, waitFor } from '../../support/wager-messages';

let orm: MikroORM;
let app: TestApp | undefined;
let queues: TestQueues | undefined;
let consumer: SqsConsumer | undefined;
const lines: string[] = [];
const logger = createLogger({ level: 'debug', destination: { write: (line) => void lines.push(line) } });
const parsed = () => lines.map((line) => JSON.parse(line));

beforeAll(async () => {
  orm = await getTestOrm();
});
afterAll(async () => {
  await closeTestOrm();
});
beforeEach(async () => {
  lines.length = 0;
  await drainOutbox(orm);
  await parkPendingTransactions(orm);
});
afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  await app?.close();
  app = undefined;
  await queues?.destroy();
  queues = undefined;
});

const eventCorrelationIds = async (walletId: string) =>
  (await sql(orm, `select payload->>'correlationId' as id from outbox_messages where aggregate_id = ?`, [walletId])).map((row) => row.id);

describe('X-Correlation-Id over HTTP (OBS-03)', () => {
  test('a received id is echoed, reaches the events of the operation and tags the request log', async () => {
    app = await startTestApp(undefined, { logger });
    const wallet = await createWallet(app.url);
    const body = submission(wallet);

    const response = await post(app.url, body, undefined, { 'x-correlation-id': 'trace-42' });

    expect(response.status).toBe(201);
    expect(response.headers.get('x-correlation-id')).toBe('trace-42');
    const events = (await sql(orm, `select payload->>'correlationId' as id from outbox_messages where payload->'data'->>'transactionId' = ?`, [response.body.transactionId])).map((row) => row.id);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events)).toEqual(new Set(['trace-42']));
    expect(parsed().find((line) => line.message === 'request completed' && line.correlationId === 'trace-42')).toMatchObject({ method: 'POST', path: '/wagering/transactions', status: 201 });
  });

  test('without the header, one UUID is generated, returned, and used by the events', async () => {
    app = await startTestApp(undefined, { logger });
    const wallet = await createWallet(app.url);

    const response = await post(app.url, submission(wallet));

    const generated = response.headers.get('x-correlation-id')!;
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    const events = (await sql(orm, `select payload->>'correlationId' as id from outbox_messages where payload->'data'->>'transactionId' = ?`, [response.body.transactionId])).map((row) => row.id);
    expect(new Set(events)).toEqual(new Set([generated]));
  });

  test('an unsafe header value is not echoed back', async () => {
    app = await startTestApp(undefined, { logger });

    const response = await api(app.url, 'GET', '/health/live', { headers: { 'x-correlation-id': 'bad value;<script>' } });

    expect(response.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the wallet creation also keeps the id on its events', async () => {
    app = await startTestApp(undefined, { logger });
    const playerId = uuid();

    const created = await api(app.url, 'POST', '/wallets', {
      body: { playerId, initialBalance: { amount: '10.00', currency: 'BRL' } },
      headers: { 'x-correlation-id': 'open-1' },
    });

    expect(new Set(await eventCorrelationIds(created.body.id))).toEqual(new Set(['open-1']));
  });
});

describe('the SQS message id is the correlation id (OBS-03)', () => {
  test('lines written while handling a message carry its messageId as messageId and correlationId', async () => {
    queues = await createTestQueues({ visibilityTimeoutSeconds: 2 });
    const wallet = await newWallet(orm);
    const message = wagerMessage(wallet);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);
    await sendMessage(queues.adapter, queues.wager, message, wallet.id);
    consumer = new SqsConsumer(
      { adapter: queues.adapter, submit: submitUseCase(orm), logger },
      { queue: queues.wager, dlq: queues.dlq, pollWaitSeconds: 1, maxReceiveCount: 5, shutdownGraceMs: 5000 },
    );
    consumer.start();

    expect(await waitFor(() => parsed().some((line) => line.message === 'duplicate message acknowledged'))).toBe(true);

    const line = parsed().find((entry) => entry.message === 'duplicate message acknowledged');
    expect(line).toMatchObject({ messageId: message.messageId, correlationId: message.messageId });
    const [transaction] = await transactionsOf(orm, message.data.externalTransactionId);
    expect(new Set(await eventCorrelationIds(wallet.id))).toContain(message.messageId);
    expect(transaction).toBeDefined();
  });
});

describe('nothing financial or personal in the output (OBS-02)', () => {
  test('a full cycle (open, bet, refused refund, replay, forced mismatch) writes no amount, balance, player id or payload', async () => {
    app = await startTestApp(undefined, { logger });
    const wallet = await createWallet(app.url, '1234.56');
    const bet = submission(wallet, { money: { amount: '25.25', currency: 'BRL' } });
    expect((await post(app.url, bet, 'k-1')).status).toBe(201);
    expect((await post(app.url, bet, 'k-1')).body.idempotentReplay).toBe(true);
    expect((await post(app.url, { ...bet, externalTransactionId: `x-${uuid()}`, money: { amount: '99999.00', currency: 'BRL' } })).status).toBe(422);
    await sql(orm, 'update wallets set balance = balance + 777.77 where id = ?', [wallet.id]);
    const reconciliation = await api(app.url, 'POST', `/wallets/${wallet.id}/reconciliation`);
    expect(reconciliation.body.consistent).toBe(false);

    const output = lines.join('\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of ['1234.56', '25.25', '99999.00', '777.77', '1259.', wallet.playerId, 'fortune-chimp']) {
      expect(output).not.toContain(secret);
    }
    for (const line of parsed()) {
      for (const key of Object.keys(line)) {
        expect(['amount', 'balance', 'playerId', 'payload', 'money', 'body']).not.toContain(key);
      }
    }
    const mismatch = parsed().find((line) => line.message === 'wallet reconciliation mismatch');
    expect(mismatch).toMatchObject({ level: 'error', walletId: wallet.id });
    expect(mismatch.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
