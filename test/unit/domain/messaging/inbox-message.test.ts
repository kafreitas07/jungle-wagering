import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../../src/domain/messaging/inbox-message';

const received = new Date('2026-11-03T12:00:00.000Z');
const done = new Date('2026-11-03T12:00:01.000Z');

describe('InboxMessage (SQS-02, SQS-03)', () => {
  test('is received unprocessed with the identity used for deduplication', () => {
    const message = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-transactions',
      payloadHash: 'a'.repeat(64),
      at: received,
    });

    expect(message.messageId).toBe('message-1');
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.payloadHash).toBe('a'.repeat(64));
    expect(message.receivedAt).toEqual(received);
    expect(message.processedAt).toBeNull();
    expect(message.isProcessed()).toBe(false);
  });

  test('markProcessed records when it was processed', () => {
    const message = InboxMessage.receive({
      messageId: 'message-1',
      consumerName: 'wager-transactions',
      payloadHash: 'a'.repeat(64),
      at: received,
    });

    message.markProcessed(done);

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(done);
  });

  test('rehydrate restores a processed message', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'message-2',
      consumerName: 'wager-transactions',
      payloadHash: 'b'.repeat(64),
      receivedAt: received,
      processedAt: done,
    });

    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(done);
    expect(message.payloadHash).toBe('b'.repeat(64));
  });
});
