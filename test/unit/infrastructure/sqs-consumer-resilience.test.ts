import { describe, expect, test } from 'bun:test';
import { InFlight, isFinalReceive, visibilityBackoffSeconds } from '../../../src/infrastructure/messaging/sqs-consumer-resilience';

describe('visibilityBackoffSeconds: min(2^receiveCount · 2 s, 60 s) (SQS-06)', () => {
  test.each([
    [1, 4],
    [2, 8],
    [3, 16],
    [4, 32],
    [5, 60],
    [6, 60],
    [20, 60],
  ])('after %i receives the message is hidden for %i s', (receiveCount, seconds) => {
    expect(visibilityBackoffSeconds(receiveCount)).toBe(seconds);
  });
});

describe('isFinalReceive (SQS-07)', () => {
  test('is true from the last delivery the redrive policy allows', () => {
    expect(isFinalReceive(4, 5)).toBe(false);
    expect(isFinalReceive(5, 5)).toBe(true);
    expect(isFinalReceive(6, 5)).toBe(true);
  });
});

describe('InFlight', () => {
  const message = (receiptHandle: string) => ({ receiptHandle });

  test('tracks what is being worked on', () => {
    const inFlight = new InFlight<{ receiptHandle: string }>();
    const a = message('a');
    const b = message('b');

    inFlight.add(a);
    inFlight.add(b);
    inFlight.remove(a);

    expect(inFlight.size).toBe(1);
    expect(inFlight.remaining()).toEqual([b]);
  });

  test('drain resolves true right away when nothing is in flight', async () => {
    expect(await new InFlight().drain(10)).toBe(true);
  });

  test('drain resolves true as soon as the last message is removed', async () => {
    const inFlight = new InFlight<{ receiptHandle: string }>();
    const a = message('a');
    inFlight.add(a);
    setTimeout(() => inFlight.remove(a), 20);

    expect(await inFlight.drain(2000)).toBe(true);
  });

  test('drain resolves false when the time runs out first', async () => {
    const inFlight = new InFlight<{ receiptHandle: string }>();
    inFlight.add(message('a'));

    const started = Date.now();
    expect(await inFlight.drain(50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
