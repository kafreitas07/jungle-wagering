import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MikroORM } from '@mikro-orm/postgresql';
import { WalletLedgerEntry } from '../../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { ledgerEntryToDomain, ledgerEntryToRecord } from '../../../src/infrastructure/persistence/mappers/ledger-entry.mapper';
import { walletToDomain, walletToRecord } from '../../../src/infrastructure/persistence/mappers/wallet.mapper';
import { LedgerEntrySchema } from '../../../src/infrastructure/persistence/records/ledger-entry.record';
import { WalletSchema } from '../../../src/infrastructure/persistence/records/wallet.record';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { insertTransaction, uuid } from '../../support/sql';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const at = new Date('2026-11-03T12:00:00.000Z');

const openWallet = (amount: string) =>
  Wallet.open({ playerId: uuid(), initialBalance: brl(amount), openingTransactionId: uuid(), at });

async function persistWallet(wallet: Wallet): Promise<Wallet> {
  const em = orm.em.fork();
  await em.insert(WalletSchema, walletToRecord(wallet));
  return walletToDomain(await em.fork().findOneOrFail(WalletSchema, { id: wallet.id }));
}

describe('wallet mapper (DB-03, DB-04, MON-01)', () => {
  test('toRecord writes the balance as an exact decimal string and the currency separately', () => {
    const { wallet } = openWallet('0.10');

    const record = walletToRecord(wallet);

    expect(record).toMatchObject({ id: wallet.id, playerId: wallet.playerId, balance: '0.10', currency: 'BRL', version: 1 });
    expect(typeof record.balance).toBe('string');
  });

  test.each(['0.10', '999999999999999999.99', '0.01', '1234.50'])('round-trips balance %s through numeric(20,2) without loss', async (amount) => {
    const { wallet } = openWallet(amount);

    const loaded = await persistWallet(wallet);

    expect(loaded.balance.toString()).toBe(amount);
    expect(loaded.balance.cents).toBe(wallet.balance.cents);
    expect(typeof loaded.balance.cents).toBe('bigint');
  });

  test('toDomain rebuilds the same wallet: ids, currency, version and timestamps', async () => {
    const { wallet } = openWallet('50.00');

    const loaded = await persistWallet(wallet);

    expect(loaded).toBeInstanceOf(Wallet);
    expect(loaded.id).toBe(wallet.id);
    expect(loaded.playerId).toBe(wallet.playerId);
    expect(loaded.currency).toBe('BRL');
    expect(loaded.version).toBe(1);
    expect(loaded.createdAt).toEqual(at);
    expect(loaded.updatedAt).toEqual(at);
  });

  test('a debited wallet persists the new version and balance', async () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(brl('30.25'), uuid(), new Date(at.getTime() + 1000));

    const loaded = await persistWallet(wallet);

    expect(loaded.balance.toString()).toBe('69.75');
    expect(loaded.version).toBe(2);
    expect(loaded.createdAt).toEqual(at);
    expect(loaded.updatedAt).toEqual(new Date(at.getTime() + 1000));
  });
});

describe('ledger entry mapper', () => {
  async function persistEntry(entry: WalletLedgerEntry, wallet: Wallet): Promise<WalletLedgerEntry> {
    const em = orm.em.fork();
    await em.insert(WalletSchema, walletToRecord(wallet));
    await insertTransaction(orm, { id: entry.transactionId, walletId: wallet.id, playerId: wallet.playerId });
    await em.insert(LedgerEntrySchema, ledgerEntryToRecord(entry, wallet.currency));
    return ledgerEntryToDomain(await em.fork().findOneOrFail(LedgerEntrySchema, { id: entry.id }));
  }

  test('round-trips every field of a DEBIT, keeping exact amounts', async () => {
    const { wallet } = openWallet('999999999999999999.99');
    const entry = wallet.debit(brl('0.10'), uuid(), new Date(at.getTime() + 5));

    const loaded = await persistEntry(entry, wallet);

    expect(loaded.id).toBe(entry.id);
    expect(loaded.walletId).toBe(wallet.id);
    expect(loaded.transactionId).toBe(entry.transactionId);
    expect(loaded.direction).toBe('DEBIT');
    expect(loaded.amount.toString()).toBe('0.10');
    expect(loaded.balanceBefore.toString()).toBe('999999999999999999.99');
    expect(loaded.balanceAfter.toString()).toBe('999999999999999999.89');
    expect(loaded.walletVersion).toBe(2);
    expect(loaded.createdAt).toEqual(new Date(at.getTime() + 5));
  });

  test('round-trips a CREDIT', async () => {
    const { wallet } = openWallet('10.00');
    const entry = wallet.credit(brl('0.01'), uuid(), at);

    const loaded = await persistEntry(entry, wallet);

    expect(loaded.direction).toBe('CREDIT');
    expect(loaded.balanceAfter.toString()).toBe('10.01');
  });

  test('toRecord carries the wallet currency and every amount as a string', () => {
    const { wallet } = openWallet('10.00');
    const entry = wallet.credit(brl('5.00'), uuid(), at);

    const record = ledgerEntryToRecord(entry, wallet.currency);

    expect(record.currency).toBe('BRL');
    for (const value of [record.amount, record.balanceBefore, record.balanceAfter]) {
      expect(typeof value).toBe('string');
    }
  });

  test('toDomain trusts the stored row: it does not revalidate the arithmetic', () => {
    const entry = ledgerEntryToDomain({
      id: uuid(),
      walletId: uuid(),
      currency: 'BRL',
      transactionId: uuid(),
      direction: 'CREDIT',
      amount: '5.00',
      balanceBefore: '10.00',
      balanceAfter: '99.00',
      walletVersion: 3,
      createdAt: at,
    });

    expect(entry.balanceAfter.toString()).toBe('99.00');
  });
});

describe('mapping conventions (DB-03)', () => {
  const persistenceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? persistenceFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
    );

  test('no persistence file uses ORM decorators', () => {
    for (const file of persistenceFiles('src/infrastructure/persistence')) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/@(Entity|Property|PrimaryKey|ManyToOne|OneToMany|Index|Unique)\b/);
    }
  });

  test('no record field that holds money is typed as number', () => {
    for (const file of persistenceFiles('src/infrastructure/persistence/records')) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/(balance|amount|balanceBefore|balanceAfter)\w*\s*:\s*number/);
    }
  });
});
