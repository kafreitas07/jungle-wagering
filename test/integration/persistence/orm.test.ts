import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrmConfig } from '../../../src/infrastructure/persistence/orm.config';
import { assertTestDatabase, closeTestOrm, getTestOrm, testDatabaseConfig } from '../../support/db';

let orm: MikroORM;

beforeAll(async () => {
  orm = await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

describe('test database harness', () => {
  test('connects to the wagering_test database, never the development one', async () => {
    const rows = await orm.em.getConnection().execute('select current_database() as db');

    expect(rows[0]?.db).toBe('wagering_test');
  });

  test('refuses a database that is not wagering_test', () => {
    expect(() => assertTestDatabase('postgres://wagering:wagering@localhost:5440/wagering')).toThrow(/wagering_test/);
    expect(() => assertTestDatabase('postgres://wagering:wagering@localhost:5440/wagering_test')).not.toThrow();
  });
});

describe('createOrmConfig', () => {
  test('reads the pool size from the configuration', () => {
    const config = createOrmConfig({ ...testDatabaseConfig(), poolMax: 7 });

    expect(config.pool?.max).toBe(7);
  });

  test('uses hand-written migrations without a schema snapshot', () => {
    const config = createOrmConfig(testDatabaseConfig());

    expect(config.migrations?.snapshot).toBe(false);
    expect(config.migrations?.transactional).toBe(true);
  });
});

describe('bun run migrate', () => {
  test('applies the migrations to the database named by DATABASE_URL and exits 0', async () => {
    const child = Bun.spawn(['bun', 'run', '--silent', 'migrate'], {
      env: { ...process.env, DATABASE_URL: testDatabaseConfig().url },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' });
    expect(output).toContain('migrations applied');
  });

  test('fails with a non-zero exit code when the database is unreachable', async () => {
    const child = Bun.spawn(['bun', 'run', '--silent', 'migrate'], {
      env: { ...process.env, DATABASE_URL: 'postgres://wagering:wagering@localhost:1/wagering_test' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await child.exited).not.toBe(0);
  });
});
