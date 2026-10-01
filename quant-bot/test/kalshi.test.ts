import { describe, expect, it } from 'vitest';
import {
  buildKalshiObservations, kalshiFee, parseKalshiCandles, parseKalshiMarket, runKalshiStudy, seriesOf, type KalshiCandle,
} from '../src/research/kalshi.ts';

const raw = (over: Record<string, unknown> = {}) => ({
  ticker: 'KXTEMPNYCH-26AUG15-T80', event_ticker: 'KXTEMPNYCH-26AUG15', market_type: 'binary', status: 'finalized', result: 'yes',
  open_time: '2026-08-15T13:00:00Z', close_time: '2026-08-15T14:00:00Z', volume_fp: '120.5', ...over,
});

describe('parseKalshiMarket', () => {
  it('reads a settled binary market', () => {
    expect(parseKalshiMarket(raw())).toMatchObject({
      ticker: 'KXTEMPNYCH-26AUG15-T80', event: 'KXTEMPNYCH-26AUG15', series: 'KXTEMPNYCH', yesWon: true, volume: 120.5,
    });
  });

  it('skips parlays, unsettled and ambiguous markets rather than guessing', () => {
    expect(parseKalshiMarket(raw({ mve_collection_ticker: 'KXMVE-1' }))).toBeNull();
    expect(parseKalshiMarket(raw({ result: '' }))).toBeNull();
    expect(parseKalshiMarket(raw({ result: 'scalar' }))).toBeNull();
    expect(parseKalshiMarket(raw({ market_type: 'scalar' }))).toBeNull();
    expect(parseKalshiMarket(raw({ open_time: 'nope' }))).toBeNull();
  });

  it('takes the series from the event ticker', () => {
    expect(seriesOf('KXINTLFRIENDLYTOTAL-26OCT01ABC')).toBe('KXINTLFRIENDLYTOTAL');
  });
});

describe('parseKalshiCandles', () => {
  const body = { candlesticks: [
    { end_period_ts: 1000, yes_ask: { close_dollars: '0.60' }, yes_bid: { close_dollars: '0.55' }, volume_fp: '4.0' },
    { end_period_ts: 2000, yes_ask: { close_dollars: '0.70' }, yes_bid: {}, volume_fp: '0' },
  ] };

  it('keeps each hour\'s closing ask and bid and drops hours with no two-sided quote', () => {
    expect(parseKalshiCandles(body)).toEqual([{ t: 1000, ask: 0.6, bid: 0.55, volume: 4 }]);
  });

  it('rejects a body of the wrong shape', () => {
    expect(() => parseKalshiCandles({ nope: 1 })).toThrow(/candlesticks/);
  });
});

describe('kalshiFee', () => {
  it('is 7% of price times one minus price, rounded up to the cent', () => {
    expect(kalshiFee(0.5)).toBe(0.02);
    expect(kalshiFee(0.99)).toBe(0.01);
    expect(kalshiFee(0.01)).toBe(0.01);
  });
});

describe('buildKalshiObservations', () => {
  const market = parseKalshiMarket(raw({ open_time: '1970-01-01T00:00:00Z', close_time: '1970-01-01T05:00:00Z' }))!;
  const H = 3600;
  const candles: KalshiCandle[] = [
    { t: 1 * H, ask: 0.5, bid: 0.48, volume: 5 },
    { t: 2 * H, ask: 0.6, bid: 0.58, volume: 5 },
    { t: 3 * H, ask: 0.9, bid: 0.88, volume: 5 },
  ];

  it('prices each market at fixed hours after it opened, from a quote that was already published', () => {
    const obs = buildKalshiObservations(market, candles, [1, 2]);
    expect(obs.map((o) => [o.afterOpenHours, o.ask, o.bid])).toEqual([[1, 0.5, 0.48], [2, 0.6, 0.58]]);
    expect(obs.every((o) => o.y === 1)).toBe(true);
  });

  it('uses the quote at the anchor, never a later one', () => {
    const obs = buildKalshiObservations(market, candles, [2]);
    expect(obs[0]!.ask).toBe(0.6);
  });

  it('skips an anchor at or after the close, and a spread too wide to trade', () => {
    const wide: KalshiCandle[] = [{ t: 1 * H, ask: 0.9, bid: 0.3, volume: 1 }];
    expect(buildKalshiObservations(market, wide, [1])).toEqual([]);
    expect(buildKalshiObservations(market, candles, [5, 6])).toEqual([]);
  });
});

describe('runKalshiStudy', () => {
  it('charges the real ask plus fee and cannot confirm a rule on a fair coin', () => {
    const obs = Array.from({ length: 600 }, (_, i) => ({
      market: `m${i}`, event: `e${i}`, series: 'S', endTs: i, afterOpenHours: 1,
      ask: 0.52, bid: 0.48, y: (i % 2) as 0 | 1,
    }));
    const study = runKalshiStudy(obs);
    expect(study.observations).toBe(600);
    expect(study.selected.filter((r) => r.confirmed)).toEqual([]);
    for (const r of study.all) expect(r.mean).toBeLessThan(0);
  });
});
