import { describe, expect, test } from 'bun:test';
import { correlationMiddleware, resolveCorrelationId } from '../../../src/infrastructure/observability/correlation';
import { currentCorrelationId, runWithLogScope } from '../../../src/infrastructure/observability/log-context';
import { createLogger, scrub } from '../../../src/infrastructure/observability/logger';

function collector() {
  const lines: string[] = [];
  return { lines, destination: { write: (line: string) => void lines.push(line) }, parsed: () => lines.map((line) => JSON.parse(line)) };
}

describe('structured logs (OBS-01)', () => {
  test('each line is one JSON object with level, message, time and the service', () => {
    const out = collector();
    createLogger({ level: 'info', destination: out.destination }).info('hello', { walletId: 'w1' });

    const [line] = out.parsed();
    expect(line).toMatchObject({ level: 'info', message: 'hello', service: 'wagering-processor', walletId: 'w1' });
    expect(new Date(line.time).toString()).not.toBe('Invalid Date');
  });

  test('ids of the surrounding scope are on every line, and explicit ids add to them', () => {
    const out = collector();
    const logger = createLogger({ level: 'info', destination: out.destination });

    runWithLogScope({ correlationId: 'c-1', messageId: 'm-1' }, () => logger.warn('inside', { transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' }));
    logger.info('outside');

    const [inside, outside] = out.parsed();
    expect(inside).toMatchObject({ correlationId: 'c-1', messageId: 'm-1', transactionId: 't-1', walletId: 'w-1', providerId: 'p-1' });
    expect(outside.correlationId).toBeUndefined();
  });

  test('concurrent scopes never leak ids into each other', async () => {
    const out = collector();
    const logger = createLogger({ level: 'info', destination: out.destination });
    await Promise.all(
      ['a', 'b', 'c', 'd'].map((id) =>
        runWithLogScope({ correlationId: id }, async () => {
          await Bun.sleep(Math.random() * 20);
          logger.info('step', { who: id });
          await Bun.sleep(Math.random() * 20);
          logger.info('step', { who: id });
        }),
      ),
    );

    const lines = out.parsed();
    expect(lines).toHaveLength(8);
    for (const line of lines) {
      expect(line.correlationId).toBe(line.who);
    }
  });

  test('nested scopes inherit the outer ids and may refine them', () => {
    const out = collector();
    const logger = createLogger({ level: 'info', destination: out.destination });
    runWithLogScope({ correlationId: 'c', walletId: 'outer' }, () => runWithLogScope({ walletId: 'inner' }, () => logger.info('x')));

    expect(out.parsed()[0]).toMatchObject({ correlationId: 'c', walletId: 'inner' });
  });

  test('the level filters: debug is dropped at info, and silent drops everything', () => {
    const out = collector();
    const info = createLogger({ level: 'info', destination: out.destination });
    info.debug('hidden');
    info.error('shown');
    createLogger({ level: 'silent', destination: out.destination }).error('also hidden');

    expect(out.parsed().map((line) => line.message)).toEqual(['shown']);
  });
});

describe('what never reaches a log line (OBS-02)', () => {
  const forbidden = {
    amount: '25.00',
    Amount: '26.00',
    money: { amount: '27.00', currency: 'BRL' },
    balance: '999.00',
    storedBalance: '998.00',
    calculated_balance: '997.00',
    difference: '1.00',
    playerId: 'player-secret',
    player_id: 'player-secret-2',
    payload: { anything: 1 },
    body: '{"x":1}',
    data: { x: 1 },
    headers: { authorization: 'Bearer abc' },
    authorization: 'Bearer abc',
  };

  test('forbidden keys are dropped at the top level, in any spelling', () => {
    const out = collector();
    createLogger({ level: 'info', destination: out.destination }).info('x', { walletId: 'w', ...forbidden });

    const line = out.parsed()[0];
    expect(Object.keys(line).sort()).toEqual(['level', 'message', 'service', 'time', 'walletId']);
    expect(out.lines[0]).not.toMatch(/25\.00|26\.00|27\.00|999\.00|player-secret|Bearer/);
  });

  test('and when nested inside other objects or arrays', () => {
    const out = collector();
    createLogger({ level: 'info', destination: out.destination }).info('x', { detail: { ok: 'yes', inner: { amount: '5.00' } }, list: [{ playerId: 'p', id: 1 }] });

    expect(out.parsed()[0].detail).toEqual({ ok: 'yes', inner: {} });
    expect(out.parsed()[0].list).toEqual([{ id: 1 }]);
  });

  test('an Error is reduced to its name and code: no message that might carry a value, no stack', () => {
    const error = Object.assign(new Error('balance 12.00 is not enough'), { code: 'X1' });

    expect(scrub({ cause: error })).toEqual({ cause: { name: 'Error', code: 'X1' } });
  });

  test('bigint values are written as text instead of breaking the line', () => {
    const out = collector();
    createLogger({ level: 'info', destination: out.destination }).info('x', { count: 10n });

    expect(out.parsed()[0].count).toBe('10');
  });
});

describe('correlation id (OBS-03)', () => {
  const request = (headers: Record<string, string | string[]> = {}, originalUrl = '/wallets/w1?token=secret') => ({ headers, method: 'GET', originalUrl });
  const response = () => {
    const headers: Record<string, string> = {};
    let finish: () => void = () => {};
    return { statusCode: 200, headers, setHeader: (name: string, value: string) => void (headers[name] = value), on: (_: 'finish', listener: () => void) => void (finish = listener), end: () => finish() };
  };

  test('a received id is kept, written back on the request and the response, and visible to the code that runs next', () => {
    const out = collector();
    const req = request({ 'x-correlation-id': 'abc-123' });
    const res = response();
    let seen: string | undefined;

    correlationMiddleware(createLogger({ level: 'info', destination: out.destination }))(req, res, () => (seen = currentCorrelationId()));

    expect(seen).toBe('abc-123');
    expect(req.headers['x-correlation-id']).toBe('abc-123');
    expect(res.headers['X-Correlation-Id']).toBe('abc-123');
  });

  test('an absent id becomes a new UUID, different for each request', () => {
    const ids = [0, 1].map(() => {
      const req = request();
      correlationMiddleware(createLogger({ level: 'silent' }))(req, response(), () => {});
      return req.headers['x-correlation-id'] as string;
    });

    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test.each([['has space'], ['semi;colon'], ['x'.repeat(129)], ['quote"'], ['']])('an unsafe or oversized id (%p) is replaced, not echoed', (bad) => {
    expect(resolveCorrelationId(bad)).not.toBe(bad);
    expect(resolveCorrelationId(bad)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('ids of 128 characters made of letters, digits and . _ : - are accepted', () => {
    const id = `${'a1.'.repeat(40)}Z_:-`.slice(0, 128);

    expect(resolveCorrelationId(id)).toBe(id);
  });

  test('the request line carries the id, method, path without the query, status and duration, and nothing else', () => {
    const out = collector();
    const res = response();
    res.statusCode = 422;
    correlationMiddleware(createLogger({ level: 'info', destination: out.destination }))(request({ 'x-correlation-id': 'c-9' }), res, () => {});
    res.end();

    const line = out.parsed()[0];
    expect(line).toMatchObject({ message: 'request completed', correlationId: 'c-9', method: 'GET', path: '/wallets/w1', status: 422 });
    expect(typeof line.durationMs).toBe('number');
    expect(out.lines[0]).not.toContain('secret');
  });

  test.each([['/health/live'], ['/health/ready'], ['/metrics'], ['/metrics?format=text']])('%s gets the correlation id but no request line', (url) => {
    const out = collector();
    const req = request({}, url);
    const res = response();
    correlationMiddleware(createLogger({ level: 'info', destination: out.destination }))(req, res, () => {});
    res.end();

    expect(res.headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.lines).toHaveLength(0);
  });

  test.each([['/health'], ['/health/ready/extra'], ['/wallets/w1/metrics'], ['/wagering/transactions']])('%s still gets its request line', (url) => {
    const out = collector();
    const res = response();
    correlationMiddleware(createLogger({ level: 'info', destination: out.destination }))(request({}, url), res, () => {});
    res.end();

    expect(out.parsed()).toHaveLength(1);
    expect(out.parsed()[0]).toMatchObject({ message: 'request completed', path: url });
  });
});
