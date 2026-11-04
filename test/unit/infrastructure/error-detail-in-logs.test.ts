import { describe, expect, test } from 'bun:test';
import { SqsConsumer } from '../../../src/infrastructure/messaging/sqs-consumer';
import { RecordingLogger } from '../../support/context';

describe('infrastructure errors are logged through safeDetail', () => {
  test('a failing receive keeps the message but masks credentials in it', async () => {
    const logger = new RecordingLogger();
    const adapter = {
      receive: async () => {
        throw new Error('getaddrinfo failed for http://admin:hunter2@localstack:4566/queue');
      },
    };
    const consumer = new SqsConsumer(
      { adapter: adapter as never, submit: {} as never, logger },
      { queue: 'q', dlq: 'd', pollWaitSeconds: 0, maxReceiveCount: 5, shutdownGraceMs: 100 },
    );

    consumer.start();
    const deadline = Date.now() + 2000;
    while (logger.at('error').length < 1 && Date.now() < deadline) await Bun.sleep(5);
    await consumer.stop();

    const entry = logger.at('error').find((line) => line.message === 'receive failed');
    expect(String(entry?.context?.errorMessage)).toContain('getaddrinfo failed');
    expect(String(entry?.context?.errorMessage)).toContain('//***@localstack');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });
});
