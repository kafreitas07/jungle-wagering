import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { api } from '../support/app';
import { closeTestOrm, getTestOrm, testDatabaseConfig } from '../support/db';
import { createWallet, post, submission } from '../support/http';
import { assertReconciledByApi } from '../support/reconcile';
import { sql } from '../support/sql';

const PROCESSES = 3;

let orm: MikroORM;
const children: ReturnType<typeof Bun.spawn>[] = [];
let urls: string[] = [];

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  void server.stop(true);
  return port;
}

async function waitUntilLive(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/health/live`)).status === 200) {
        return;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  throw new Error(`process at ${url} did not become live`);
}

beforeAll(async () => {
  orm = await getTestOrm();
  const ports = Array.from({ length: PROCESSES }, freePort);
  for (const port of ports) {
    children.push(
      Bun.spawn(['bun', 'run', 'src/main.ts'], {
        env: {
          ...process.env,
          APP_PORT: String(port),
          DATABASE_URL: testDatabaseConfig().url,
          SQS_ENDPOINT: 'http://localhost:4566',
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'test',
          AWS_SECRET_ACCESS_KEY: 'test',
          RUN_HTTP: 'true',
          RUN_SQS_CONSUMER: 'false',
          RUN_OUTBOX_PUBLISHER: 'false',
          RUN_PENDING_WORKER: 'false',
        },
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }
  urls = ports.map((port) => `http://127.0.0.1:${port}`);
  await Promise.all(urls.map(waitUntilLive));
});

afterAll(async () => {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  await Promise.all(children.map((child) => child.exited));
  await closeTestOrm();
});

const balanceOf = async (walletId: string): Promise<string> => (await api(urls[0]!, 'GET', `/wallets/${walletId}`)).body.balance.amount;

describe('three application processes on the same wallet (CONC-04, TEST-03)', () => {
  test('60 distinct BETs spread over the processes are all applied exactly once', async () => {
    const wallet = await createWallet(urls[0]!, '1000.00');

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        post(urls[index % PROCESSES]!, submission(wallet, { money: { amount: '5.00', currency: 'BRL' } })),
      ),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(await balanceOf(wallet.id)).toBe('700.00');
    const debits = await sql(orm, `select count(*)::int as n from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'`, [wallet.id]);
    expect(debits[0]?.n).toBe(60);
    await assertReconciledByApi(orm, urls[0]!, [wallet.id]);
  });

  test('the same request sent to every process at once is applied once', async () => {
    const wallet = await createWallet(urls[0]!, '500.00');
    const body = submission(wallet);
    const key = 'shared-key';

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_, index) => post(urls[index % PROCESSES]!, body, `${key}-${wallet.id}`)),
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('475.00');
    await assertReconciledByApi(orm, urls[0]!, [wallet.id]);
  });

  test('100.00 and BETs of 80.00 raced across the processes: one passes, the balance never goes negative', async () => {
    const wallets: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const wallet = await createWallet(urls[0]!, '100.00');
      wallets.push(wallet.id);
      const eighty = { money: { amount: '80.00', currency: 'BRL' } };

      const responses = await Promise.all(urls.map((url) => post(url, submission(wallet, eighty))));

      expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
      expect(responses.filter((response) => response.status === 422 && response.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(PROCESSES - 1);
      expect(await balanceOf(wallet.id)).toBe('20.00');
    }
    await assertReconciledByApi(orm, urls[0]!, wallets);
  });
});
