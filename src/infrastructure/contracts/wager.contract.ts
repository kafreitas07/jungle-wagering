import { z } from 'zod';
import { isZeroAmount, moneyInputSchema } from './money.contract';

const WAGER_KINDS = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
const text = z.string().min(1);
/** Identifiers end up in unique indexes: unbounded values would fail in the database and surface as a 500. */
const identifier = text.max(255);

/** OPENING is not in this list: it is internal and never accepted from a provider or a queue. */
const payloadFields = {
  providerId: identifier.refine((value) => value !== 'internal', '"internal" is a reserved provider id'),
  externalTransactionId: identifier,
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: identifier,
  gameId: identifier,
  kind: z.enum(WAGER_KINDS),
  money: moneyInputSchema,
  referenceExternalTransactionId: identifier.optional(),
};

interface BusinessFields {
  kind: (typeof WAGER_KINDS)[number];
  money: { amount: string };
  referenceExternalTransactionId?: string | undefined;
}

/** Rules that depend on the kind. Shared by the HTTP body and the SQS message data. */
function applyBusinessRules(fields: BusinessFields, ctx: z.RefinementCtx): void {
  if ((fields.kind === 'REFUND' || fields.kind === 'ROLLBACK') && fields.referenceExternalTransactionId === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: `${fields.kind} requires referenceExternalTransactionId`,
    });
  }
  if (fields.kind !== 'LOSS' && isZeroAmount(fields.money.amount)) {
    ctx.addIssue({
      code: 'custom',
      path: ['money', 'amount'],
      message: `${fields.kind} amount must be greater than 0.00`,
    });
  }
}

/** Body of `POST /wagering/transactions`. The idempotency key comes from the header. */
export const submitWagerTransactionSchema = z.object(payloadFields).superRefine(applyBusinessRules);

export type SubmitWagerTransactionInput = z.infer<typeof submitWagerTransactionSchema>;

/** Message of `wager-transactions.fifo`. The idempotency key travels in the data. */
export const wagerTransactionRequestedSchema = z.object({
  messageId: text,
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.object({ ...payloadFields, idempotencyKey: identifier }).superRefine(applyBusinessRules),
});

export type WagerTransactionRequestedMessage = z.infer<typeof wagerTransactionRequestedSchema>;
