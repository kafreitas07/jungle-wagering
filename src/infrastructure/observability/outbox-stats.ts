import type { MikroORM } from '@mikro-orm/postgresql';
import type { OutboxStats } from './metrics';

/** One query over the unpublished events (the partial index `outbox_messages_unpublished` covers it). */
export async function readOutboxStats(orm: MikroORM, highAttemptsThreshold: number): Promise<OutboxStats> {
  const [row] = (await orm.em.fork().execute(
    `select count(*)::int as pending,
            coalesce(extract(epoch from (now() - min(occurred_at))), 0)::float8 as lag_seconds,
            (count(*) filter (where attempts >= ?))::int as high_attempts
       from outbox_messages
      where published_at is null`,
    [highAttemptsThreshold],
  )) as { pending: number; lag_seconds: number; high_attempts: number }[];
  return { pending: Number(row?.pending ?? 0), lagSeconds: Number(row?.lag_seconds ?? 0), highAttempts: Number(row?.high_attempts ?? 0) };
}
