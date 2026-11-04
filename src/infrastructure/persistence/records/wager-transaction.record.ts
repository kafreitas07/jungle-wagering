import { EntitySchema } from '@mikro-orm/core';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  amount: string;
  currency: string;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  status: string;
  failureCode: string | null;
  balanceAfter: string | null;
  referenceAttempts: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  processedAt: Date | null;
  updatedAt: Date;
}

const decimal = { type: 'decimal', precision: 20, scale: 2, runtimeType: 'string' } as const;

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string', fieldName: 'provider_id' },
    externalTransactionId: { type: 'string', fieldName: 'external_transaction_id' },
    idempotencyKey: { type: 'string', fieldName: 'idempotency_key' },
    payloadHash: { type: 'string', fieldName: 'payload_hash' },
    walletId: { type: 'uuid', fieldName: 'wallet_id' },
    playerId: { type: 'uuid', fieldName: 'player_id' },
    roundId: { type: 'string', fieldName: 'round_id' },
    gameId: { type: 'string', fieldName: 'game_id' },
    kind: { type: 'string' },
    amount: decimal,
    currency: { type: 'string', length: 3 },
    referenceExternalTransactionId: { type: 'string', fieldName: 'reference_external_transaction_id', nullable: true },
    referenceTransactionId: { type: 'uuid', fieldName: 'reference_transaction_id', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', fieldName: 'failure_code', nullable: true },
    balanceAfter: { ...decimal, fieldName: 'balance_after', nullable: true },
    referenceAttempts: { type: 'integer', fieldName: 'reference_attempts' },
    nextAttemptAt: { type: 'Date', fieldName: 'next_attempt_at', nullable: true },
    createdAt: { type: 'Date', fieldName: 'created_at' },
    processedAt: { type: 'Date', fieldName: 'processed_at', nullable: true },
    updatedAt: { type: 'Date', fieldName: 'updated_at' },
  },
});
