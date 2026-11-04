import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { OutboxMessageRecord } from '../records/outbox-message.record';

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  const state = message.toState();
  return {
    id: state.id,
    aggregateId: state.aggregateId,
    groupKey: state.groupKey,
    eventType: state.eventType,
    payload: { ...state.payload },
    occurredAt: state.occurredAt,
    attempts: state.attempts,
    nextAttemptAt: state.nextAttemptAt,
    lockedUntil: state.lockedUntil,
    publishedAt: state.publishedAt,
    lastError: state.lastError,
  };
}

export function outboxMessageToDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    groupKey: record.groupKey,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt,
    lockedUntil: record.lockedUntil,
    publishedAt: record.publishedAt,
    lastError: record.lastError,
  });
}
