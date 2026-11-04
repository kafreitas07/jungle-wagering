import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishBatchResult {
  readonly published: readonly string[];
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

/**
 * Sends outbox messages to the event queue. Entries are keyed by message id (deduplication id)
 * and grouped by `groupKey` (the wallet). A failure of the whole call throws.
 */
export interface EventPublisherPort {
  publishBatch(messages: readonly OutboxMessage[]): Promise<PublishBatchResult>;
}
