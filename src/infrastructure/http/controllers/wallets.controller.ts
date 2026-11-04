import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { GetWallet } from '../../../application/use-cases/queries';
import { ListLedger } from '../../../application/use-cases/list-ledger';
import { OpenWallet } from '../../../application/use-cases/open-wallet';
import { createWalletSchema, ledgerQuerySchema } from '../../contracts/wallet.contract';
import { AuthGuard } from '../auth/auth.guard';
import { ledgerEntryView, walletView } from '../presenters';

const uuid = z.uuid();

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    @Inject(OpenWallet) private readonly openWallet: OpenWallet,
    @Inject(GetWallet) private readonly getWallet: GetWallet,
    @Inject(ListLedger) private readonly listLedger: ListLedger,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlationId?: string) {
    const input = createWalletSchema.parse(body);
    const wallet = await this.openWallet.execute({ ...input, ...(correlationId === undefined ? {} : { correlationId }) });
    return walletView(wallet);
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    return walletView(await this.getWallet.execute(uuid.parse(walletId)));
  }

  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query() query: Record<string, unknown>) {
    const parsed = ledgerQuerySchema.parse({ cursor: query.cursor, limit: query.limit });
    const page = await this.listLedger.execute({ walletId: uuid.parse(walletId), ...parsed });
    return { items: page.entries.map(ledgerEntryView), nextCursor: page.nextCursor };
  }
}
