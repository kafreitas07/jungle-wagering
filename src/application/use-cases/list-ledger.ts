import { InvalidLedgerQueryError, WalletNotFoundError } from '../errors/application-errors';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { UnitOfWork } from '../ports';
import { encodeLedgerCursor } from '../services/ledger-cursor';

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

export interface ListLedgerQuery {
  readonly walletId: string;
  /** Entries strictly older than this wallet version. Comes from the decoded cursor. */
  readonly beforeVersion?: number;
  readonly limit?: number;
}

export interface LedgerPage {
  readonly entries: WalletLedgerEntry[];
  /** Opaque token for the next page; `null` on the last one. */
  readonly nextCursor: string | null;
}

/**
 * Keyset pagination by `wallet_version` descending. The cursor is "everything older than this version", so
 * entries written after the first page (always newer) can neither repeat nor push an unseen entry out.
 */
export class ListLedger {
  constructor(private readonly deps: { readonly unitOfWork: UnitOfWork }) {}

  async execute(query: ListLedgerQuery): Promise<LedgerPage> {
    const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidLedgerQueryError(limit);
    }

    const fetched = await this.deps.unitOfWork.run(async (tx) => {
      if ((await tx.wallets.findById(query.walletId)) === null) {
        throw new WalletNotFoundError(query.walletId);
      }
      return tx.ledger.listByWallet(query.walletId, {
        ...(query.beforeVersion === undefined ? {} : { beforeVersion: query.beforeVersion }),
        limit: limit + 1,
      });
    });

    const entries = fetched.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: fetched.length > limit && last !== undefined ? encodeLedgerCursor(last.walletVersion) : null,
    };
  }
}
