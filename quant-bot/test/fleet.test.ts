import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { coinFlipStrategy } from '../src/strategy/coin-flip.ts';
import {
  botStatePath,
  FAST_SYMBOLS,
  formatFleetStatus,
  parseFleet,
  planCoreFleet,
  planFleet,
  rankByDollarVolume,
  type BotSpec,
} from '../src/live/fleet.ts';
import type { PaperStatus } from '../src/live/status.ts';

const DAY = 86_400_000;
const bars = (n: number, price: number, volume: number): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ time: i * DAY, open: price, high: price, low: price, close: price, volume }));

describe('coin-flip strategy', () => {
  const candles = bars(2000, 100, 1);

  it('decides from the bar alone, so a replay and a live run agree', () => {
    const a = coinFlipStrategy.create(candles, { seed: 1 });
    const b = coinFlipStrategy.create(candles.slice(0, 500), { seed: 1 });
    for (const i of [0, 10, 250, 499]) expect(b.signalAt(i, null).target).toBe(a.signalAt(i, null).target);
  });

  it('is long about half the time and changes with the seed', () => {
    const a = coinFlipStrategy.create(candles, { seed: 1 });
    const b = coinFlipStrategy.create(candles, { seed: 2 });
    const longs = candles.filter((_, i) => a.signalAt(i, null).target > 0).length;
    expect(longs / candles.length).toBeGreaterThan(0.45);
    expect(longs / candles.length).toBeLessThan(0.55);
    const differ = candles.filter((_, i) => a.signalAt(i, null).target !== b.signalAt(i, null).target).length;
    expect(differ).toBeGreaterThan(candles.length / 4);
  });
});

describe('rankByDollarVolume', () => {
  it('keeps the most-traded coins that have enough history, most traded first', () => {
    const ranked = rankByDollarVolume({
      'BIG/USD': bars(300, 100, 1000),
      'NEW/USD': bars(50, 100, 1e9),
      'MID/USD': bars(300, 10, 500),
      'SMALL/USD': bars(300, 1, 10),
    }, { minBars: 201, top: 2, window: 30 });
    expect(ranked).toEqual(['BIG/USD', 'MID/USD']);
  });
});

describe('planFleet', () => {
  const top = Array.from({ length: 32 }, (_, i) => `C${i}/USD`);
  const bots = planFleet(top);

  it('builds the strategy grid, trend-hold on 32 coins, and 32 fast bots', () => {
    expect(bots.filter((b) => b.group === 'daily strategies')).toHaveLength(12);
    expect(bots.filter((b) => b.group === 'trend-hold x32')).toHaveLength(32);
    const fast = bots.filter((b) => b.group === 'fast (1-minute)');
    expect(fast).toHaveLength(32);
    expect(new Set(fast.flatMap((b) => b.symbols))).toEqual(new Set(FAST_SYMBOLS));
  });

  it('gives every group a luck control or benchmark', () => {
    expect(bots.some((b) => b.group === 'daily strategies' && b.strategy === 'coin-flip')).toBe(true);
    expect(bots.some((b) => b.group === 'daily strategies' && b.strategy === 'buy-and-hold')).toBe(true);
    expect(bots.filter((b) => b.group === 'fast (1-minute)' && b.strategy === 'coin-flip')).toHaveLength(4);
  });

  it('names every bot uniquely and safely for a folder name', () => {
    const names = bots.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9-]+$/);
  });

  it('round-trips through the fleet file', () => {
    const parsed = parseFleet(JSON.stringify({ exchange: 'coinbase', createdAt: 'x', bots }));
    expect(parsed.bots).toHaveLength(76);
  });
});

describe('planCoreFleet', () => {
  const bots = planCoreFleet();
  const full = new Set(planFleet(Array.from({ length: 32 }, (_, i) => `C${i}/USD`)).map((b) => b.name));

  it('is ten bots with a coin-flip control and a benchmark', () => {
    expect(bots).toHaveLength(10);
    expect(bots.filter((b) => b.strategy === 'coin-flip')).toHaveLength(2);
    expect(bots.some((b) => b.strategy === 'buy-and-hold')).toBe(true);
    expect(bots.some((b) => b.strategy === 'dca-safety')).toBe(false);
  });

  it('reuses the full fleet\'s names, so kept bots keep their accounts', () => {
    for (const b of bots) expect(full.has(b.name)).toBe(true);
  });
});

describe('parseFleet', () => {
  const bot: BotSpec = {
    name: 'a', group: 'g', strategy: 'trend-hold', symbols: ['BTC/USD'], timeframe: '1d',
    equity: 25, feeBps: 60, maxDrawdownPct: 60,
  };
  const file = (bots: unknown[]) => JSON.stringify({ exchange: 'coinbase', createdAt: 'x', bots });

  it('rejects duplicate names, which would make two bots share one account', () => {
    expect(() => parseFleet(file([bot, bot]))).toThrow(/duplicate/);
  });

  it('rejects a name that could escape the fleet folder', () => {
    expect(() => parseFleet(file([{ ...bot, name: '../evil' }]))).toThrow(/name/);
  });

  it('rejects unknown strategies and timeframes', () => {
    expect(() => parseFleet(file([{ ...bot, strategy: 'nope' }]))).toThrow(/unknown strategy/);
    expect(() => parseFleet(file([{ ...bot, timeframe: '7s' }]))).toThrow(/timeframe/);
  });

  it('keeps each bot in its own folder', () => {
    expect(botStatePath('.quant-bot/fleet', 'a')).toMatch(/fleet[\\/]a[\\/]runner-state\.json$/);
  });
});

describe('formatFleetStatus', () => {
  const status = (equity: number, fees: number): PaperStatus => ({
    startingCash: 25, cash: equity, equity, partial: false, pnl: equity - 25, pnlPct: (equity / 25 - 1) * 100,
    withdrawn: 0, buys: 1, sells: 1, feesPaid: fees, positions: [], realizedBySymbol: {}, killed: false, killReason: null,
  });
  const spec = (name: string, strategy: string): BotSpec => ({
    name, group: 'fast (1-minute)', strategy, symbols: ['BTC/USD'], timeframe: '1m', equity: 25, feeBps: 60, maxDrawdownPct: 15,
  });

  it('totals each group and puts the coin-flip control next to the rest', () => {
    const text = formatFleetStatus([
      { spec: spec('fast-a', 'tsmom'), status: status(20, 3) },
      { spec: spec('fast-b', 'coin-flip'), status: status(22, 2) },
      { spec: spec('fast-c', 'grid-range'), status: null },
    ]);
    expect(text).toMatch(/fast \(1-minute\)/i);
    expect(text).toMatch(/-\$8\.00/);
    expect(text).toMatch(/ALL BOTS  \$42\.00 now, profit -\$8\.00/);
    expect(text).toMatch(/coin-flip/);
    expect(text).toMatch(/not started/);
  });

  it('says how far the fleet is from paying for its next bot', () => {
    const text = formatFleetStatus([], { added: 1, queued: 63, profit: 30, needed: 20 });
    expect(text).toMatch(/1 bot added from profits, 63 queued/);
    expect(text).toMatch(/\$20\.00 more profit/);
  });
});
