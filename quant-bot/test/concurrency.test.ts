import { describe, expect, it } from 'vitest';
import { mapPool } from '../src/concurrency.ts';
import { withRetry } from '../src/data/exchange.ts';

describe('mapPool', () => {
  it('returns results in input order even when they finish out of order', async () => {
    const delays = [30, 5, 20, 0, 10];
    const out = await mapPool(delays, 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
    });
    expect(peak).toBe(4);
  });

  it('rejects a nonsensical limit', async () => {
    await expect(mapPool([1], 0, async (x) => x)).rejects.toThrow(/concurrency/);
  });
});

describe('withRetry', () => {
  class RateLimitExceeded extends Error {}
  class BadSymbol extends Error {}
  const noWait = async (): Promise<void> => {};

  it('retries throttling with growing backoff, then succeeds', async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new RateLimitExceeded('429');
      return 'ok';
    }, 4, 100, async (ms) => { waits.push(ms); });
    expect(result).toBe('ok');
    expect(waits).toEqual([100, 200]);
  });

  it('does not retry an error that retrying cannot fix', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new BadSymbol('no such market');
    }, 4, 1, noWait)).rejects.toThrow(/no such market/);
    expect(calls).toBe(1);
  });

  it('gives up after the last attempt and surfaces the error', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new RateLimitExceeded('still throttled');
    }, 3, 1, noWait)).rejects.toThrow(/still throttled/);
    expect(calls).toBe(3);
  });
});
