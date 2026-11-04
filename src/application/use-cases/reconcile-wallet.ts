import { WalletNotFoundError } from '../errors/application-errors';
import type { Money } from '../../domain/money/money';
import { type LoggerPort, type MetricsPort, NoopLogger, NoopMetrics, type UnitOfWork } from '../ports';

export interface ReconciliationReport {
  readonly walletId: string;
  readonly storedBalance: Money;
  readonly calculatedBalance: Money;
  /** stored − calculated. Zero when consistent. */
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export interface ReconcileWalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly logger?: LoggerPort;
  readonly metrics?: MetricsPort;
}

/**
 * Compares the stored balance with the one rebuilt from the ledger. It only reports: a mismatch is logged and
 * counted, never corrected, because silently fixing a balance would hide whatever broke it.
 */
export class ReconcileWallet {
  private readonly logger: LoggerPort;
  private readonly metrics: MetricsPort;

  constructor(private readonly deps: ReconcileWalletDependencies) {
    this.logger = deps.logger ?? new NoopLogger();
    this.metrics = deps.metrics ?? new NoopMetrics();
  }

  async execute(walletId: string): Promise<ReconciliationReport> {
    const snapshot = await this.deps.unitOfWork.run((tx) => tx.ledger.reconciliationSnapshot(walletId));
    if (snapshot === null) {
      throw new WalletNotFoundError(walletId);
    }
    const difference = snapshot.storedBalance.subtract(snapshot.calculatedBalance);
    const consistent = difference.cents === 0n;
    if (!consistent) {
      this.metrics.increment('reconciliation_mismatches_total');
      // Ids only: amounts never go to the logs.
      this.logger.error('wallet reconciliation mismatch', { walletId, checkedEntries: snapshot.checkedEntries });
    }
    return { walletId, ...snapshot, difference, consistent };
  }
}
