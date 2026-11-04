import { z } from 'zod';

/** Strict input format: exactly 2 decimals, non-negative, at most 18 integer digits (numeric(20,2)). */
const AMOUNT_PATTERN = /^\d{1,18}\.\d{2}$/;

export const moneyInputSchema = z.object({
  amount: z.string().regex(AMOUNT_PATTERN, 'amount must be a non-negative decimal with exactly 2 decimals'),
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be 3 uppercase letters (ISO-4217)'),
});

export type MoneyInput = z.infer<typeof moneyInputSchema>;

export const isZeroAmount = (amount: string): boolean => /^0+\.00$/.test(amount);
