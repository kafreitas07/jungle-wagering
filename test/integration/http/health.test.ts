import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startApplication } from '../../../src/infrastructure/bootstrap';
import { api, startTestApp, testConfig } from '../../support/app';
import { closeTestOrm, getTestOrm } from '../../support/db';

beforeAll(async () => {
  await getTestOrm();
});

afterAll(async () => {
  await closeTestOrm();
});

const withApp = async (overrides: Record<string, string>, run: (url: string) => Promise<void>) => {
  const app = await startTestApp(testConfig(overrides));
  try {
    await run(app.url);
  } finally {
    await app.close();
  }
};

const freePort = (): number => {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = server.port!;
  void server.stop(true);
  return port;
};

describe('GET /health/live (OBS-05)', () => {
  test('answers 200 without touching any dependency, even when both are unreachable', async () => {
    await withApp({ DATABASE_URL: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test', SQS_ENDPOINT: 'http://127.0.0.1:1' }, async (url) => {
      const live = await api(url, 'GET', '/health/live');

      expect(live.status).toBe(200);
      expect(live.body).toEqual({ status: 'ok' });
    });
  });
});

describe('GET /health/ready (OBS-06, OBS-07)', () => {
  test('answers 200 with PostgreSQL and the SQS queues reachable', async () => {
    await withApp({}, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(ready.status).toBe(200);
      expect(ready.body).toEqual({ status: 'ok', dependencies: { postgres: { status: 'up' }, sqs: { status: 'up' } } });
    });
  });

  test('PostgreSQL unreachable → 503 naming postgres, with SQS still reported up', async () => {
    await withApp({ DATABASE_URL: 'postgres://wagering:wagering@127.0.0.1:1/wagering_test' }, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(ready.status).toBe(503);
      expect(ready.body.status).toBe('unavailable');
      expect(ready.body.dependencies.postgres.status).toBe('down');
      expect(ready.body.dependencies.postgres.detail).toBeString();
      expect(ready.body.dependencies.sqs).toEqual({ status: 'up' });
    });
  });

  test('SQS unreachable → 503 naming sqs, with PostgreSQL still reported up', async () => {
    await withApp({ SQS_ENDPOINT: 'http://127.0.0.1:1' }, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(ready.status).toBe(503);
      expect(ready.body.dependencies.sqs.status).toBe('down');
      expect(ready.body.dependencies.sqs.detail).toBeString();
      expect(ready.body.dependencies.postgres).toEqual({ status: 'up' });
    });
  });

  test('a missing queue → 503 whose detail names the queue', async () => {
    await withApp({ SQS_WAGER_QUEUE: 'queue-that-does-not-exist.fifo' }, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(ready.status).toBe(503);
      expect(ready.body.dependencies.sqs.status).toBe('down');
      expect(ready.body.dependencies.sqs.detail).toContain('queue-that-does-not-exist.fifo');
    });
  });

  test('the events queue is checked too', async () => {
    await withApp({ SQS_EVENTS_QUEUE: 'events-that-do-not-exist.fifo' }, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(ready.status).toBe(503);
      expect(ready.body.dependencies.sqs.detail).toContain('events-that-do-not-exist.fifo');
    });
  });

  test('the detail never leaks credentials or the connection string', async () => {
    await withApp({ DATABASE_URL: 'postgres://wagering:s3cr3tpass@127.0.0.1:1/wagering_test' }, async (url) => {
      const ready = await api(url, 'GET', '/health/ready');

      expect(JSON.stringify(ready.body)).not.toContain('s3cr3tpass');
    });
  });

  test('ready is 503 while live stays 200', async () => {
    await withApp({ SQS_ENDPOINT: 'http://127.0.0.1:1' }, async (url) => {
      expect((await api(url, 'GET', '/health/ready')).status).toBe(503);
      expect((await api(url, 'GET', '/health/live')).status).toBe(200);
    });
  });
});

describe('runners are switched by environment', () => {
  test('RUN_HTTP=false does not listen on the port', async () => {
    const port = freePort();
    const running = await startApplication(testConfig({ RUN_HTTP: 'false', RUN_SQS_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_WORKER: 'false', APP_PORT: String(port) }));
    try {
      expect(running.httpPort).toBeUndefined();
      await expect(fetch(`http://127.0.0.1:${port}/health/live`)).rejects.toThrow();
    } finally {
      await running.stop();
    }
  });

  test('RUN_HTTP=true listens on APP_PORT and serves the health check', async () => {
    const port = freePort();
    const running = await startApplication(testConfig({ RUN_HTTP: 'true', RUN_SQS_CONSUMER: 'false', RUN_OUTBOX_PUBLISHER: 'false', RUN_PENDING_WORKER: 'false', APP_PORT: String(port) }));
    try {
      expect(running.httpPort).toBe(port);
      expect((await api(`http://127.0.0.1:${port}`, 'GET', '/health/live')).status).toBe(200);
    } finally {
      await running.stop();
    }
  });
});
