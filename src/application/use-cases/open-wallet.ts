import { createHash } from 'node:crypto';
import { WalletAlreadyExistsError } from '../errors/application-errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/messaging/integration-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, type MoneyProps } from '../../domain/money/money';
import { Wallet } from '../../domain/wallet/wallet';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { Clock, UnitOfWork } from '../ports';
import { canonicalJson } from '../services/payload-hash';
import { isUniqueViolation } from '../services/sql-errors';

export interface OpenWalletCommand {
  readonly playerId: string;
  readonly initialBalance: MoneyProps;
  readonly correlationId?: string;
}

export interface OpenWalletDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Wallet, OPENING transaction, ledger entry and events in one SQL transaction.
 * A zero balance creates only the wallet: there is no movement to record.
 */
export class OpenWallet {
  constructor(private readonly deps: OpenWalletDependencies) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const initialBalance = Money.from(command.initialBalance);
    const at = this.deps.clock.now();
    const context = { correlationId: command.correlationId ?? Bun.randomUUIDv7(), at };

    try {
      return await this.deps.unitOfWork.run(async (tx) => {
        const openingTransactionId = Bun.randomUUIDv7();
        const { wallet, openingEntry } = Wallet.open({
          playerId: command.playerId,
          initialBalance,
          openingTransactionId,
          at,
        });
        await tx.wallets.insert(wallet);

        if (openingEntry !== undefined) {
          const opening = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
            payloadHash: openingHash(wallet.id, wallet.playerId, initialBalance),
            at,
          });
          await tx.transactions.insert(opening);
          await tx.ledger.append(openingEntry);
          await tx.outbox.enqueue(OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, context)));
          await tx.outbox.enqueue(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, context)));
        }
        return wallet;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'wallets_player_currency_key')) {
        throw new WalletAlreadyExistsError(command.playerId, initialBalance.currency);
      }
      throw error;
    }
  }
}

function openingHash(walletId: string, playerId: string, money: Money): string {
  return createHash('sha256')
    .update(canonicalJson({ walletId, playerId, kind: 'OPENING', money: money.toJSON() }))
    .digest('hex');
}
