import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import { NestFactory } from '@nestjs/core';
import {
  SQSClient, GetQueueUrlCommand, GetQueueAttributesCommand,
  SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { initOrm } from './orm';
import { SpikeWallet } from './spike-wallet';
import { SpikeWalletSchema, type SpikeWalletRecord } from './spike-wallet.record';
import { SpikeAppModule } from './app.module';

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = '') => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ' — ' + detail : ''}`);
};

const toCents = (s: string): bigint => {
  const [i, f = ''] = s.split('.');
  return BigInt(i!) * 100n + BigInt(f.padEnd(2, '0'));
};
const fromCents = (c: bigint): string => `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;

async function spikeOrm() {
  const orm = await initOrm();
  // MikroORM 7 connects lazily: isConnected() is false until the first query runs.
  await orm.em.getConnection().execute('select 1');
  check('MikroORM connects under Bun (select 1)', (await orm.checkConnection()).ok);

  const tableExists = async () => {
    const r = await orm.em.getConnection().execute(`select to_regclass('public.spike_wallets') as t`);
    return r[0]?.t != null;
  };

  await orm.migrator.up();
  check('migration up creates table', await tableExists());

  const id = randomUUID();
  const w = SpikeWallet.open(id, randomUUID(), toCents('100.00'));
  const em = orm.em.fork();
  em.create(SpikeWalletSchema, { id: w.id, playerId: w.playerId, balance: fromCents(w.balanceCents), version: w.version });
  await em.flush();

  await orm.em.fork().transactional(async (tx) => {
    const rec = await tx.findOneOrFail(SpikeWalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    check('numeric(20,2) hydrates as string', typeof rec.balance === 'string' && rec.balance === '100.00', `${typeof rec.balance} ${JSON.stringify(rec.balance)}`);
    const domain = SpikeWallet.rehydrate({ ...rec, balanceCents: toCents(rec.balance) });
    domain.debit(toCents('80.00'));
    rec.balance = fromCents(domain.balanceCents);
  });
  const after = await orm.em.fork().findOneOrFail(SpikeWalletSchema, { id });
  check('FOR UPDATE + flush persists debit, version bumps', after.balance === '20.00' && after.version === 2, `balance=${after.balance} version=${after.version}`);

  let checkViolated = false;
  try {
    await orm.em.getConnection().execute(`update spike_wallets set balance = -1 where id = ?`, [id]);
  } catch (e) {
    checkViolated = String((e as Error).message).includes('check');
  }
  check('CHECK (balance >= 0) enforced by Postgres', checkViolated);


  await orm.migrator.down();
  check('migration down drops table', !(await tableExists()));
  await orm.migrator.up();
  check('migration up again (reversible cycle)', await tableExists());
  await orm.migrator.down();
  await orm.close();
}

async function spikeSqs() {
  const sqs = new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.SQS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }));
  const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['RedrivePolicy', 'FifoQueue'] }));
  check('FIFO queue with redrive to DLQ', attrs.Attributes?.FifoQueue === 'true' && (attrs.Attributes?.RedrivePolicy ?? '').includes('wager-transactions-dlq.fifo'), attrs.Attributes?.RedrivePolicy ?? '');

  const walletId = randomUUID();
  const messageId = `msg-${randomUUID()}`;
  await sqs.send(new SendMessageCommand({
    QueueUrl,
    MessageBody: JSON.stringify({ messageId, type: 'WagerTransactionRequested', data: { walletId } }),
    MessageGroupId: walletId,
    MessageDeduplicationId: messageId,
  }));
  const rec = await sqs.send(new ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 5, MessageSystemAttributeNames: ['MessageGroupId'] }));
  const m = rec.Messages?.[0];
  const body = m?.Body ? JSON.parse(m.Body) : undefined;
  check('send + receive on LocalStack FIFO', body?.messageId === messageId && m?.Attributes?.MessageGroupId === walletId, `group=${m?.Attributes?.MessageGroupId}`);
  if (m?.ReceiptHandle) await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
  sqs.destroy();
}

async function spikeNest() {
  const app = await NestFactory.create(SpikeAppModule, { logger: ['error', 'warn'] });
  await app.listen(Number(process.env.APP_PORT ?? 3100));
  const res = await fetch(`http://localhost:${process.env.APP_PORT ?? 3100}/health/live`);
  const json = (await res.json()) as { status?: string };
  check('Nest on Bun serves /health/live with DI', res.status === 200 && json.status === 'ok', `${res.status} ${JSON.stringify(json)}`);
  await app.close();
}

for (const [name, fn] of [['orm', spikeOrm], ['sqs', spikeSqs], ['nest', spikeNest]] as const) {
  try {
    await fn();
  } catch (e) {
    check(`${name} crashed`, false, (e as Error).stack ?? String(e));
  }
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
