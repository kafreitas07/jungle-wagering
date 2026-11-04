import { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { InboxMessageRecord } from '../records/inbox-message.record';

export function inboxMessageToRecord(message: InboxMessage): InboxMessageRecord {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt,
  };
}

export function inboxMessageToDomain(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt,
  });
}
