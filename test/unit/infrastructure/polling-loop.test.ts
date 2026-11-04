import { describe, expect, test } from 'bun:test';
import { PollingLoop } from '../../../src/infrastructure/messaging/polling-loop';
import { RecordingLogger } from '../../support/context';

const until = async (condition: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(5);
  }
};

describe('PollingLoop', () => {
  test('runs the tick repeatedly until stopped', async () => {
    let ticks = 0;
    const loop = new PollingLoop('t', 5, async () => void (ticks += 1));

    loop.start();
    await until(() => ticks >= 3);
    await loop.stop();

    expect(ticks).toBeGreaterThanOrEqual(3);
  });

  test('a failing tick is logged and the loop keeps going', async () => {
    let ticks = 0;
    const logger = new RecordingLogger();
    const loop = new PollingLoop(
      'worker',
      5,
      async () => {
        ticks += 1;
        if (ticks === 1) {
          throw new Error('database down');
        }
      },
      logger,
    );

    loop.start();
    await until(() => ticks >= 3);
    await loop.stop();

    expect(ticks).toBeGreaterThanOrEqual(3);
    expect(logger.at('error')).toHaveLength(1);
    expect(logger.at('error')[0]).toMatchObject({ message: 'worker tick failed', context: { errorMessage: 'Error: database down' } });
  });

  test('ticks never overlap, even when one is slower than the interval', async () => {
    let active = 0;
    let maxActive = 0;
    let ticks = 0;
    const loop = new PollingLoop('t', 1, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(20);
      active -= 1;
      ticks += 1;
    });

    loop.start();
    await until(() => ticks >= 3);
    await loop.stop();

    expect(maxActive).toBe(1);
  });

  test('stop waits for the tick in progress to finish', async () => {
    let finished = false;
    let started = false;
    const loop = new PollingLoop('t', 1000, async () => {
      started = true;
      await Bun.sleep(80);
      finished = true;
    });

    loop.start();
    await until(() => started);
    await loop.stop();

    expect(finished).toBe(true);
  });

  test('stop interrupts the wait between ticks instead of sleeping the whole interval', async () => {
    let ticks = 0;
    const loop = new PollingLoop('t', 60_000, async () => void (ticks += 1));
    loop.start();
    await until(() => ticks >= 1);

    const started = Date.now();
    await loop.stop();

    expect(Date.now() - started).toBeLessThan(500);
    expect(ticks).toBe(1);
  });

  test('starting twice does not run two loops, and no tick runs after stop', async () => {
    let active = 0;
    let maxActive = 0;
    let ticks = 0;
    const loop = new PollingLoop('t', 1, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(10);
      active -= 1;
      ticks += 1;
    });

    loop.start();
    loop.start();
    await until(() => ticks >= 3);
    await loop.stop();
    const after = ticks;
    await Bun.sleep(50);

    expect(maxActive).toBe(1);
    expect(ticks).toBe(after);
  });

  test('the error text is logged through the credential mask, first line only', async () => {
    let ticks = 0;
    const logger = new RecordingLogger();
    const loop = new PollingLoop(
      'worker',
      5,
      async () => {
        ticks += 1;
        throw new Error('connect ECONNREFUSED postgres://wagering:s3cret@db:5432/x\n    at stack line');
      },
      logger,
    );

    loop.start();
    await until(() => ticks >= 1);
    await loop.stop();

    const text = String(logger.at('error')[0]?.context?.errorMessage);
    expect(text).toContain('ECONNREFUSED');
    expect(text).toContain('//***@db');
    expect(text).not.toContain('s3cret');
    expect(text).not.toContain('stack line');
  });
});
