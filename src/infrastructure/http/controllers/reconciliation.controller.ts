import { Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ReconcileWallet } from '../../../application/use-cases/reconcile-wallet';
import { AuthGuard } from '../auth/auth.guard';

const uuid = z.uuid();

/** An operator action, not a provider one: like the other wallet routes it names no provider. */
@Controller('wallets')
@UseGuards(AuthGuard)
export class ReconciliationController {
  constructor(@Inject(ReconcileWallet) private readonly reconcileWallet: ReconcileWallet) {}

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  async reconcile(@Param('walletId') walletId: string) {
    const report = await this.reconcileWallet.execute(uuid.parse(walletId));
    return {
      walletId: report.walletId,
      storedBalance: report.storedBalance.toJSON(),
      calculatedBalance: report.calculatedBalance.toJSON(),
      difference: report.difference.toJSON(),
      consistent: report.consistent,
      checkedEntries: report.checkedEntries,
    };
  }
}
