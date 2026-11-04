import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { OptimisticLockError, type WalletRepository } from '../../application/ports';
import type { Wallet } from '../../domain/wallet/wallet';
import { walletChanges, walletToDomain, walletToRecord } from './mappers/wallet.mapper';
import { WalletSchema } from './records/wallet.record';

export class WalletRepositoryImpl implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id });
    return record === null ? null : walletToDomain(record);
  }

  async lockById(id: string): Promise<Wallet | null> {
    const record = await this.em.findOne(WalletSchema, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return record === null ? null : walletToDomain(record);
  }

  async insert(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletSchema, walletToRecord(wallet));
  }

  /** `UPDATE … WHERE id = :id AND version = :expectedVersion`: a second line of defense behind the row lock. */
  async save(wallet: Wallet, expectedVersion: number): Promise<void> {
    const affected = await this.em.nativeUpdate(WalletSchema, { id: wallet.id, version: expectedVersion }, walletChanges(wallet));
    if (affected !== 1) {
      throw new OptimisticLockError(wallet.id, expectedVersion);
    }
  }
}
