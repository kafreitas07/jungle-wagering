import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import type { EventPublisherPort, PublishBatchResult } from '../../application/ports';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/** SQS accepts at most 10 entries per `SendMessageBatch`. */
const MAX_BATCH_ENTRIES = 10;

export interface ReceivedMessage {
  /** The id SQS assigned (not the producer's `messageId`, which is inside the body). */
  readonly sqsMessageId: string;
  readonly receiptHandle: string;
  readonly body: string;
  /** `MessageGroupId` of a FIFO queue. */
  readonly groupId: string | undefined;
  /** 1 on the first delivery. */
  readonly receiveCount: number;
}

export interface SendOptions {
  readonly body: string;
  readonly groupId: string;
  readonly deduplicationId: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export interface ReceiveOptions {
  readonly maxMessages: number;
  readonly waitSeconds: number;
  readonly visibilityTimeoutSeconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * The only code that speaks the SQS protocol. Queues are addressed by name; urls are resolved once and cached.
 * It is also the `EventPublisherPort` of the outbox: `publishBatch` sends to the events queue.
 */
export class SqsAdapter implements EventPublisherPort {
  private readonly urls = new Map<string, Promise<string>>();

  constructor(
    private readonly client: SQSClient,
    private readonly eventsQueue: string,
  ) {}

  queueUrl(queue: string): Promise<string> {
    let url = this.urls.get(queue);
    if (url === undefined) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: queue })).then((result) => {
        if (result.QueueUrl === undefined) {
          throw new Error(`Queue ${queue} has no url`);
        }
        return result.QueueUrl;
      });
      this.urls.set(queue, url);
      // A failed lookup must not stay cached: the queue may appear later.
      url.catch(() => this.urls.delete(queue));
    }
    return url;
  }

  /** `MessageGroupId = group_key` (the wallet), `MessageDeduplicationId = event id`. */
  async publishBatch(messages: readonly OutboxMessage[]): Promise<PublishBatchResult> {
    const url = await this.queueUrl(this.eventsQueue);
    const published: string[] = [];
    const failed: { id: string; error: string }[] = [];

    for (let start = 0; start < messages.length; start += MAX_BATCH_ENTRIES) {
      const chunk = messages.slice(start, start + MAX_BATCH_ENTRIES);
      const result = await this.client.send(
        new SendMessageBatchCommand({
          QueueUrl: url,
          Entries: chunk.map((message) => ({
            Id: message.id,
            MessageBody: JSON.stringify(message.payload),
            MessageGroupId: message.groupKey,
            MessageDeduplicationId: message.id,
            MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
          })),
        }),
      );
      published.push(...(result.Successful ?? []).map((entry) => entry.Id ?? ''));
      failed.push(...(result.Failed ?? []).map((entry) => ({ id: entry.Id ?? '', error: `${entry.Code ?? 'Error'}: ${entry.Message ?? ''}` })));
    }
    return { published, failed };
  }

  async send(queue: string, options: SendOptions): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MessageBody: options.body,
        MessageGroupId: options.groupId,
        MessageDeduplicationId: options.deduplicationId,
        ...(options.attributes === undefined
          ? {}
          : {
              MessageAttributes: Object.fromEntries(
                Object.entries(options.attributes).map(([name, value]) => [name, { DataType: 'String', StringValue: value }]),
              ),
            }),
      }),
    );
  }

  async receive(queue: string, options: ReceiveOptions): Promise<ReceivedMessage[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.queueUrl(queue),
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitSeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        ...(options.visibilityTimeoutSeconds === undefined ? {} : { VisibilityTimeout: options.visibilityTimeoutSeconds }),
      }),
      options.signal === undefined ? undefined : { abortSignal: options.signal },
    );
    return (result.Messages ?? []).map((message) => ({
      sqsMessageId: message.MessageId ?? '',
      receiptHandle: message.ReceiptHandle ?? '',
      body: message.Body ?? '',
      groupId: message.Attributes?.MessageGroupId,
      receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? '1'),
    }));
  }

  async delete(queue: string, receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: await this.queueUrl(queue), ReceiptHandle: receiptHandle }));
  }

  async changeVisibility(queue: string, receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(queue),
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}
