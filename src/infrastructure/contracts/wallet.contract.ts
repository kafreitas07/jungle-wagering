import { z } from 'zod';
import { moneyInputSchema } from './money.contract';

export const createWalletSchema = z.object({
  playerId: z.uuid(),
  initialBalance: moneyInputSchema,
});

export type CreateWalletInput = z.infer<typeof createWalletSchema>;

/** Opaque cursor: base64url of `{"v": walletVersion}` of the last entry already seen. */
export function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

function decodeLedgerCursor(cursor: string): number | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)) {
      const version = (decoded as { v?: unknown }).v;
      if (typeof version === 'number' && Number.isInteger(version) && version >= 1) {
        return version;
      }
    }
  } catch {
    // Not base64url JSON: falls through to invalid.
  }
  return undefined;
}

const cursorSchema = z
  .string()
  .min(1)
  .transform((cursor, ctx) => {
    const version = decodeLedgerCursor(cursor);
    if (version === undefined) {
      ctx.addIssue({ code: 'custom', message: 'invalid cursor' });
      return z.NEVER;
    }
    return version;
  });

/** Query of `GET /wallets/:walletId/ledger`: newest first, `beforeVersion` is the continuation point. */
export const ledgerQuerySchema = z
  .object({
    cursor: cursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .transform(({ cursor, limit }) => ({
    ...(cursor === undefined ? {} : { beforeVersion: cursor }),
    limit,
  }));

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;
