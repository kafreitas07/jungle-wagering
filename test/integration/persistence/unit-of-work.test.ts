import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { OptimisticLockError, type TxRepositories } from '../../../src/application/ports';
import { Money } from '../../../src/domain/money/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { MikroOrmUnitOfWork } from '../../../src/infrastructure/persistence/unit-of-work';
import { WalletRepositoryImpl } from '../../../src/infrastructure/persistence/wallet-repository';
import { closeTestOrm, getTestOrm } from '../../support/db';
import { holdWalletLock } from '../../support/context';
import { insertWallet, sql, uuid } from '../../support/sql';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
/** T18 exercises the wallet repository only; the other repositories arrive with T19. */
const walletsOnly = (em: ConstructorParameters<typeof WalletRepositoryImpl>[0]) =>
  ({ wallets: new WalletRepositoryImpl(em) }) as unknown as TxRepositories;

const unitOfWork = (lockTimeoutMs = 2000) => new MikroOrmUnitOfWork(orm, { lockTimeoutMs }, walletsOnly);

const balanceOf = async (id: string) => (await sql(orm, 'select balance::text as b, version from wallets where id = ?', [id]))[0];

describe('lock_timeout inside em.transactional (CONC-06)', () => {
  test('a second transaction waiting for the same wallet fails with 55P03 close to the configured limit', async () => {
    const wallet = await insertWallet(orm);
    const uow = unitOfWork(300);
    const holding = holdWalletLock(orm, wallet.id, 1500);
    await holding.acquired;

    const startedAt = performance.now();
    const waiter = await uow.run((tx) => tx.wallets.lockById(wallet.id)).then(
      () => undefined,
      (error: unknown) => error as { code?: string },
    );
    const waited = performance.now() - startedAt;
    await holding.released;

    expect(waiter?.code).toBe('55P03');
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(1000);
  });

  test('the limit applies only inside the transaction: it does not leak to the pooled connection', async () => {
    await unitOfWork(300).run(async () => undefined);

    for (let i = 0; i < 12; i += 1) {
      expect((await sql(orm, 'show lock_timeout'))[0]?.lock_timeout).toBe('0');
    }
  });

  test('rejects a lock timeout that is not a positive integer', () => {
    expect(() => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 0 }, walletsOnly)).toThrow(/lockTimeoutMs/);
    expect(() => new MikroOrmUnitOfWork(orm, { lockTimeoutMs: 1.5 }, walletsOnly)).toThrow(/lockTimeoutMs/);
  });
});

describe('wallet repository', () => {
  test('lockById returns the domain wallet, or null when it does not exist', async () => {
    const wallet = await insertWallet(orm, { balance: '42.10' });

    const loaded = await unitOfWork().run((tx) => tx.wallets.lockById(wallet.id));
    const missing = await unitOfWork().run((tx) => tx.wallets.lockById(uuid()));

    expect(loaded).toBeInstanceOf(Wallet);
    expect(loaded?.balance.toString()).toBe('42.10');
    expect(missing).toBeNull();
  });

  test('save writes balance and version when the expected version matches, and commits', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });

    await unitOfWork().run(async (tx) => {
      const locked = (await tx.wallets.lockById(wallet.id))!;
      locked.debit(brl('30.25'), uuid(), new Date());
      await tx.wallets.save(locked, 1);
    });

    expect(await balanceOf(wallet.id)).toEqual({ b: '69.75', version: 2 });
  });

  test('save with a stale version affects 0 rows and throws OptimisticLockError, changing nothing', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });

    const attempt = unitOfWork().run(async (tx) => {
      const locked = (await tx.wallets.lockById(wallet.id))!;
      locked.debit(brl('10.00'), uuid(), new Date());
      await tx.wallets.save(locked, 7);
    });

    await expect(attempt).rejects.toBeInstanceOf(OptimisticLockError);
    expect(await balanceOf(wallet.id)).toEqual({ b: '100.00', version: 1 });
  });

  test('insert persists a new wallet', async () => {
    const { wallet } = Wallet.open({ playerId: uuid(), initialBalance: brl('5.00'), openingTransactionId: uuid(), at: new Date() });
    // The opening transaction row does not exist here, so only the wallet is inserted.

    await unitOfWork().run((tx) => tx.wallets.insert(wallet));

    expect(await balanceOf(wallet.id)).toEqual({ b: '5.00', version: 1 });
  });
});

describe('unit of work', () => {
  test('a failure inside run rolls everything back', async () => {
    const { wallet } = Wallet.open({ playerId: uuid(), initialBalance: brl('5.00'), openingTransactionId: uuid(), at: new Date() });
    const other = await insertWallet(orm, { balance: '100.00' });

    const attempt = unitOfWork().run(async (tx) => {
      await tx.wallets.insert(wallet);
      const locked = (await tx.wallets.lockById(other.id))!;
      locked.debit(brl('1.00'), uuid(), new Date());
      await tx.wallets.save(locked, 1);
      throw new Error('boom');
    });

    await expect(attempt).rejects.toThrow('boom');
    expect(await sql(orm, 'select 1 from wallets where id = ?', [wallet.id])).toHaveLength(0);
    expect(await balanceOf(other.id)).toEqual({ b: '100.00', version: 1 });
  });

  test('run returns what the work returns', async () => {
    expect(await unitOfWork().run(async () => 'done')).toBe('done');
  });

  test('locking one wallet does not block another (no global lock, CONC-02)', async () => {
    const first = await insertWallet(orm);
    const second = await insertWallet(orm);
    const uow = unitOfWork();
    const holding = holdWalletLock(orm, first.id, 800);
    await holding.acquired;

    const startedAt = performance.now();
    await uow.run((tx) => tx.wallets.lockById(second.id));
    const elapsed = performance.now() - startedAt;
    await holding.released;

    expect(elapsed).toBeLessThan(400);
  });

  test('concurrent debits of the same wallet serialize: no lost update', async () => {
    const wallet = await insertWallet(orm, { balance: '100.00' });
    const uow = unitOfWork(5000);

    await Promise.all(
      Array.from({ length: 8 }, () =>
        uow.run(async (tx) => {
          const locked = (await tx.wallets.lockById(wallet.id))!;
          const expected = locked.version;
          locked.debit(brl('10.00'), uuid(), new Date());
          await tx.wallets.save(locked, expected);
        }),
      ),
    );

    expect(await balanceOf(wallet.id)).toEqual({ b: '20.00', version: 9 });
  });
});
