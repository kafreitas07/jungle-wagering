import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  WalletCurrencyMismatchError,
  WalletNotFoundError,
  WalletPlayerMismatchError,
} from '../../../application/errors/application-errors';
import { GetTransactionByExternalId, GetTransactionById } from '../../../application/use-cases/queries';
import { SubmitWagerTransaction } from '../../../application/use-cases/submit-wager-transaction';
import { submitWagerTransactionSchema } from '../../contracts/wager.contract';
import { AuthGuard } from '../auth/auth.guard';
import { HttpFailure } from '../http-errors';
import { submissionStatus, transactionView } from '../presenters';

const uuid = z.uuid();
const idempotencyKey = z.string().min(1).max(255);

interface StatusSetter {
  status(code: number): unknown;
}

@Controller()
@UseGuards(AuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransaction) private readonly submit: SubmitWagerTransaction,
    @Inject(GetTransactionById) private readonly byId: GetTransactionById,
    @Inject(GetTransactionByExternalId) private readonly byExternalId: GetTransactionByExternalId,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Res({ passthrough: true }) response: StatusSetter,
  ) {
    if (key === undefined || key.trim() === '') {
      throw new HttpFailure(400, 'IDEMPOTENCY_KEY_REQUIRED', 'The Idempotency-Key header is required');
    }
    const input = submitWagerTransactionSchema.parse(body);
    const command = {
      ...input,
      idempotencyKey: idempotencyKey.parse(key),
      ...(correlationId === undefined ? {} : { correlationId }),
    };

    const { transaction, replay } = await this.submit.execute(command).catch((error: unknown) => {
      // For a submission these are business rejections of the operation (422), not missing resources (404).
      if (error instanceof WalletNotFoundError) {
        throw new HttpFailure(422, 'WALLET_NOT_FOUND', 'Wallet not found');
      }
      if (error instanceof WalletPlayerMismatchError || error instanceof WalletCurrencyMismatchError) {
        throw new HttpFailure(422, error.code, error.message);
      }
      throw error;
    });

    const status = submissionStatus(transaction.status);
    response.status(status);
    const outcome = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter?.toJSON() ?? null,
      idempotentReplay: replay,
    };
    if (transaction.status === 'REJECTED' || transaction.status === 'FAILED') {
      return { failureCode: transaction.failureCode, message: 'The transaction was not applied', ...outcome };
    }
    return outcome;
  }

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    return transactionView(await this.byId.execute(uuid.parse(transactionId)));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return transactionView(await this.byExternalId.execute(providerId, externalTransactionId));
  }
}
