import { TransactionNotFoundError, WalletNotFoundError } from '../errors/application-errors';
import type { Wallet } from '../../domain/wallet/wallet';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { UnitOfWork } from '../ports';

export interface QueryDependencies {
  readonly unitOfWork: UnitOfWork;
}

/** Reads never lock: a query must not queue behind a balance change. */
export class GetWallet {
  constructor(private readonly deps: QueryDependencies) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.deps.unitOfWork.run((tx) => tx.wallets.findById(walletId));
    if (wallet === null) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}

export class GetTransactionById {
  constructor(private readonly deps: QueryDependencies) {}

  async execute(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.deps.unitOfWork.run((tx) => tx.transactions.findById(transactionId));
    if (transaction === null) {
      throw new TransactionNotFoundError(transactionId);
    }
    return transaction;
  }
}

export class GetTransactionByExternalId {
  constructor(private readonly deps: QueryDependencies) {}

  async execute(providerId: string, externalTransactionId: string): Promise<WagerTransaction> {
    const transaction = await this.deps.unitOfWork.run((tx) => tx.transactions.findByExternalId(providerId, externalTransactionId));
    if (transaction === null) {
      throw new TransactionNotFoundError(`${providerId}/${externalTransactionId}`);
    }
    return transaction;
  }
}
