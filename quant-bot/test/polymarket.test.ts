import { describe, expect, it } from 'vitest';
import {
  bucketOf, buildObservations, clusterEdge, evaluateBuckets, parseMarket, priceAt, splitByTime, type Observation,
} from '../src/research/polymarket.ts';

const DAY = 86_400;
const raw = (over: Record<string, unknown> = {}) => ({
  id: '1', question: 'Will X happen?', outcomes: '["Yes","No"]', outcomePrices: '["1","0"]',
  clobTokenIds: '["tokYes","tokNo"]', endDate: '2024-11-05T12:00:00Z', closedTime: '2024-11-06 15:17:41+00',
  volumeNum: 500_000, events: [{ id: 'e1' }], ...over,
});

describe('parseMarket', () => {
  it('reads a resolved Yes/No market', () => {
    const m = parseMarket(raw());
    expect(m).toMatchObject({ id: '1', yesToken: 'tokYes', yesWon: true, event: 'e1', volume: 500_000 });
    expect(m!.endTs).toBe(Date.parse('2024-11-05T12:00:00Z') / 1000);
  });

  it('knows when No won', () => {
    expect(parseMarket(raw({ outcomePrices: '["0","1"]' }))!.yesWon).toBe(false);
  });

  it('skips markets that are not cleanly resolved binaries instead of guessing', () => {
    expect(parseMarket(raw({ outcomePrices: '["0.5","0.5"]' }))).toBeNull();
    expect(parseMarket(raw({ outcomes: '["Up","Down"]' }))).toBeNull();
    expect(parseMarket(raw({ clobTokenIds: '[]' }))).toBeNull();
    expect(parseMarket(raw({ endDate: undefined }))).toBeNull();
    expect(parseMarket(raw({ outcomes: 'not json' }))).toBeNull();
  });
});

describe('priceAt', () => {
  const history = [{ t: 1000, p: 0.2 }, { t: 1000 + DAY, p: 0.3 }, { t: 1000 + 3 * DAY, p: 0.9 }];

  it('is the last price at or before the moment, never a later one', () => {
    expect(priceAt(history, 1000 + DAY + 5, 10 * DAY)).toBe(0.3);
    expect(priceAt(history, 1000 + 3 * DAY - 1, 10 * DAY)).toBe(0.3);
  });

  it('is null when the last known price is too stale to trust, or before the data starts', () => {
    expect(priceAt(history, 1000 + 20 * DAY, 2 * DAY)).toBeNull();
    expect(priceAt(history, 500, 2 * DAY)).toBeNull();
  });
});

describe('buildObservations', () => {
  const market = parseMarket(raw())!;
  const endTs = market.endTs;
  const history = [{ t: endTs - 8 * DAY, p: 0.4 }, { t: endTs - 2 * DAY, p: 0.6 }];

  it('prices each market at the horizon before its scheduled end', () => {
    const obs = buildObservations(market, history, [1, 7]);
    expect(obs.map((o) => [o.horizon, o.p])).toEqual([[1, 0.6], [7, 0.4]]);
    expect(obs.every((o) => o.y === 1 && o.event === 'e1')).toBe(true);
  });

  it('drops a horizon when the market had already closed by then: it could not have been traded', () => {
    const early = parseMarket(raw({ closedTime: new Date((endTs - 5 * DAY) * 1000).toISOString() }))!;
    const obs = buildObservations(early, history, [1]);
    expect(obs).toEqual([]);
  });

  it('drops a horizon with no fresh price', () => {
    expect(buildObservations(market, [{ t: endTs - 60 * DAY, p: 0.5 }], [1])).toEqual([]);
  });
});

describe('bucketOf', () => {
  it('puts prices in non-overlapping buckets and ignores extreme prices that cannot be bought at a profit', () => {
    expect(bucketOf(0.03)).toBe(0);
    expect(bucketOf(0.5)).toBe(3);
    expect(bucketOf(0.97)).toBe(6);
    expect(bucketOf(0.995)).toBeNull();
    expect(bucketOf(0.005)).toBeNull();
  });
});

describe('clusterEdge', () => {
  it('is the mean gain per share with a standard error that treats one event as one draw', () => {
    // Four markets of the same event win together: that is closer to one bet than to four.
    const together = clusterEdge([
      { event: 'a', gain: 0.5 }, { event: 'a', gain: 0.5 }, { event: 'a', gain: 0.5 }, { event: 'a', gain: 0.5 },
    ]);
    const apart = clusterEdge([
      { event: 'a', gain: 0.5 }, { event: 'b', gain: -0.5 }, { event: 'c', gain: 0.5 }, { event: 'd', gain: -0.5 },
    ]);
    expect(together.mean).toBe(0.5);
    expect(together.clusters).toBe(1);
    expect(apart.mean).toBe(0);
    expect(apart.clusters).toBe(4);
  });

  it('gives no verdict from a single cluster', () => {
    expect(clusterEdge([{ event: 'a', gain: 1 }, { event: 'a', gain: 1 }]).p).toBe(1);
  });

  it('finds a real, consistent edge across many clusters', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ event: `e${i}`, gain: i % 10 === 0 ? -0.5 : 0.1 }));
    const r = clusterEdge(rows);
    expect(r.mean).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(0.01);
  });
});

describe('splitByTime and evaluateBuckets', () => {
  const obs = (n: number, over: Partial<Observation> = {}): Observation[] =>
    Array.from({ length: n }, (_, i) => ({
      market: `m${i}`, event: `e${i}`, endTs: i, horizon: 7, p: 0.5, y: i % 2 as 0 | 1, volume: 1e5, ...over,
    }));

  it('splits at the median end time so the held-out half is strictly later', () => {
    const { train, test } = splitByTime(obs(10));
    expect(Math.max(...train.map((o) => o.endTs))).toBeLessThan(Math.min(...test.map((o) => o.endTs)));
    expect(train.length + test.length).toBe(10);
  });

  it('charges the cost on each side and reports both sides of every bucket and horizon', () => {
    const rows = evaluateBuckets(obs(200), 0.02);
    const mid = rows.filter((r) => r.bucket === 3 && r.horizon === 7);
    expect(mid.map((r) => r.side).sort()).toEqual(['no', 'yes']);
    // A fair coin priced at 0.5 loses the cost on either side.
    for (const r of mid) expect(r.mean).toBeLessThan(0);
  });
});
