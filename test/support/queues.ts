import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { SqsAdapter } from '../../src/infrastructure/messaging/sqs.adapter';
import { uuid } from './sql';

export const LOCALSTACK_ENDPOINT = 'http://localhost:4566';

export function testSqsClient(): SQSClient {
  process.env.AWS_ACCESS_KEY_ID ??= 'test';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
  return new SQSClient({ region: 'us-east-1', endpoint: LOCALSTACK_ENDPOINT });
}

export interface TestQueues {
  readonly client: SQSClient;
  readonly adapter: SqsAdapter;
  /** Names, unique per call so tests never share a queue (or a leftover message) with another test. */
  readonly wager: string;
  readonly dlq: string;
  readonly events: string;
  /** Messages visible in a queue right now, drained without deleting (they come back after the visibility timeout). */
  depth(queue: string): Promise<number>;
  /** Nothing visible, in flight or delayed: the messages were deleted, not merely hidden. */
  isEmpty(queue: string): Promise<boolean>;
  /** Receives and deletes everything currently visible; returns the bodies. */
  drain(queue: string, waitSeconds?: number): Promise<{ body: string; groupId: string | undefined }[]>;
  destroy(): Promise<void>;
}

interface QueueSetup {
  /** Visibility timeout of the main queue; short values keep retry tests fast. */
  readonly visibilityTimeoutSeconds?: number;
  readonly maxReceiveCount?: number;
}

/**
 * Creates the same trio of FIFO queues as `infra/localstack/init-queues.sh`, with a unique name each, on the real
 * LocalStack. The wager queue redrives to the DLQ after `maxReceiveCount` receives, like the real one.
 */
export async function createTestQueues(setup: QueueSetup = {}): Promise<TestQueues> {
  const client = testSqsClient();
  const id = uuid().replaceAll('-', '').slice(-16);
  const names = { wager: `t-wager-${id}.fifo`, dlq: `t-wager-dlq-${id}.fifo`, events: `t-events-${id}.fifo` };
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  await client.send(new CreateQueueCommand({ QueueName: names.dlq, Attributes: fifo }));
  const dlqUrl = (await client.send(new GetQueueUrlCommand({ QueueName: names.dlq }))).QueueUrl!;
  const dlqArn = (await client.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;

  await client.send(
    new CreateQueueCommand({
      QueueName: names.wager,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(setup.visibilityTimeoutSeconds ?? 30),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: String(setup.maxReceiveCount ?? 5) }),
      },
    }),
  );
  await client.send(new CreateQueueCommand({ QueueName: names.events, Attributes: fifo }));

  const adapter = new SqsAdapter(client, names.events);

  return {
    client,
    adapter,
    ...names,
    async depth(queue) {
      const url = await adapter.queueUrl(queue);
      const attributes = await client.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['ApproximateNumberOfMessages'] }));
      return Number(attributes.Attributes?.ApproximateNumberOfMessages ?? '0');
    },
    async isEmpty(queue) {
      const url = await adapter.queueUrl(queue);
      const attributes = await client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
        }),
      );
      return Object.values(attributes.Attributes ?? {}).every((value) => Number(value) === 0);
    },
    async drain(queue, waitSeconds = 1) {
      const url = await adapter.queueUrl(queue);
      const collected: { body: string; groupId: string | undefined }[] = [];
      for (;;) {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: waitSeconds,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ['MessageGroupId'],
          }),
        );
        const messages = result.Messages ?? [];
        if (messages.length === 0) {
          return collected;
        }
        for (const message of messages) {
          collected.push({ body: message.Body ?? '', groupId: message.Attributes?.MessageGroupId });
          await adapter.delete(queue, message.ReceiptHandle!);
        }
      }
    },
    async destroy() {
      for (const name of Object.values(names)) {
        try {
          await client.send(new DeleteQueueCommand({ QueueUrl: await adapter.queueUrl(name) }));
        } catch {
          // already gone
        }
      }
      client.destroy();
    },
  };
}
