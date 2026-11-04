import { EntitySchema } from '@mikro-orm/core';

export interface OutboxMessageRecord {
  id: string;
  aggregateId: string;
  groupKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  publishedAt: Date | null;
  lastError: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  name: 'OutboxMessageRecord',
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid', fieldName: 'aggregate_id' },
    groupKey: { type: 'string', fieldName: 'group_key' },
    eventType: { type: 'string', fieldName: 'event_type' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'Date', fieldName: 'occurred_at' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at' },
    lockedUntil: { type: 'Date', fieldName: 'locked_until', nullable: true },
    publishedAt: { type: 'Date', fieldName: 'published_at', nullable: true },
    lastError: { type: 'text', fieldName: 'last_error', nullable: true },
  },
});
