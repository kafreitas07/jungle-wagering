import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TxRepositories, UnitOfWork } from '../../application/ports';
import { createTxRepositories } from './repositories';

export type RepositoryFactory = (em: EntityManager) => TxRepositories;

/**
 * One SQL transaction per `run`. `lock_timeout` is set with `set_config(..., true)` (= SET LOCAL), so it
 * lives and dies with the transaction and never leaks to the pooled connection.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: { readonly lockTimeoutMs: number },
    private readonly repositories: RepositoryFactory = createTxRepositories,
  ) {
    if (!Number.isInteger(options.lockTimeoutMs) || options.lockTimeoutMs <= 0) {
      throw new Error(`lockTimeoutMs must be a positive integer, got ${options.lockTimeoutMs}`);
    }
  }

  run<T>(work: (tx: TxRepositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      await em.execute(`select set_config('lock_timeout', ?, true)`, [`${this.options.lockTimeoutMs}ms`]);
      return work(this.repositories(em as EntityManager));
    });
  }
}
