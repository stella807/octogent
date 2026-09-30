import type { Candle } from '../domain/types.ts';
import { closes, ema, sma } from '../indicators/index.ts';
import { param, type StrategyFactory } from './types.ts';
import { at, check, longFlat, supertrendUp, windowExtreme } from './long-flat.ts';

/**
 * Three strategies built on one idea that survived testing here: agreement
 * across several views is sturdier than any single line (`trend-vote`). Each
 * is all in or all out with no stop price, like the other long/flat rules.
 */

/** 1. Hold while at least `minVotes` of three return horizons are positive. */
export const momentumVote = longFlat(
  'momentum-vote',
  { short: 30, mid: 90, long: 180, bandPct: 3, minVotes: 2 },
  { bandPct: [0, 3, 6], minVotes: [2, 3] },
  (candles, p) => {
    const short = param(p, 'short', 30);
    const mid = param(p, 'mid', 90);
    const long = param(p, 'long', 180);
    const band = param(p, 'bandPct', 3) / 100;
    const minVotes = param(p, 'minVotes', 2);
    check(short < mid && mid < long, `momentum-vote needs short < mid < long, got ${short}, ${mid}, ${long}`);
    check(short >= 1 && band >= 0, 'momentum-vote needs short >= 1 and bandPct >= 0');
    check([1, 2, 3].includes(minVotes), `momentum-vote needs minVotes of 1, 2 or 3, got ${minVotes}`);
    const price = closes(candles);
    /** Horizons with a return above `edge`; entry demands a margin, holding tolerates a small dip. */
    const votes = (i: number, edge: number): number => (i < long ? 0 : [short, mid, long]
      .filter((k) => (price[i] as number) / (price[i - k] as number) - 1 > edge).length);
    return {
      params: { short, mid, long, bandPct: band * 100, minVotes },
      warmup: long,
      enter: (i) => votes(i, band) >= minVotes,
      hold: (i) => votes(i, -band) >= minVotes,
    };
  },
);

/** 2. Trend-hold, entered only while volume is rising: its 20-bar average above its 100-bar average. */
export const volumeTrend = longFlat(
  'volume-trend',
  { period: 200, bandPct: 2, fastVol: 20, slowVol: 100 },
  { bandPct: [0, 2], fastVol: [10, 20] },
  (candles, p) => {
    const period = param(p, 'period', 200);
    const band = param(p, 'bandPct', 2) / 100;
    const fastVol = param(p, 'fastVol', 20);
    const slowVol = param(p, 'slowVol', 100);
    check(fastVol < slowVol, `volume-trend needs fastVol < slowVol, got ${fastVol} >= ${slowVol}`);
    check(band >= 0, `volume-trend needs bandPct >= 0, got ${band * 100}`);
    const price = closes(candles);
    const ma = sma(price, period);
    const volume = candles.map((c: Candle) => c.volume);
    const fast = sma(volume, fastVol);
    const slow = sma(volume, slowVol);
    return {
      params: { period, bandPct: band * 100, fastVol, slowVol },
      warmup: Math.max(period, slowVol),
      enter: (i) => {
        const m = at(ma, i);
        const f = at(fast, i);
        const s = at(slow, i);
        return m !== null && f !== null && s !== null && s > 0 && (price[i] as number) > m * (1 + band) && f > s;
      },
      hold: (i) => { const m = at(ma, i); return m !== null && (price[i] as number) > m * (1 - band); },
    };
  },
);

/**
 * 3. An ensemble of five signals from different families: moving average,
 * momentum, supertrend, MACD sign and position in the 100-bar channel. Enter
 * when at least `enterVotes` agree; keep holding while at least `holdVotes` do.
 */
export const familyVote = longFlat(
  'family-vote',
  { enterVotes: 3, holdVotes: 2 },
  { enterVotes: [3, 4], holdVotes: [2, 3] },
  (candles, p) => {
    const enterVotes = param(p, 'enterVotes', 3);
    const holdVotes = param(p, 'holdVotes', 2);
    check(holdVotes <= enterVotes && holdVotes >= 1 && enterVotes <= 5, `family-vote needs 1 <= holdVotes <= enterVotes <= 5, got ${holdVotes}, ${enterVotes}`);
    const price = closes(candles);
    const ma200 = sma(price, 200);
    const fast = ema(price, 12);
    const slow = ema(price, 26);
    const trend = supertrendUp(candles, 10, 3);
    const highs = windowExtreme(candles.map((c) => c.high), 100, 'max');
    const lows = windowExtreme(candles.map((c) => c.low), 100, 'min');
    const signals = (i: number): number | null => {
      const m = at(ma200, i);
      const f = at(fast, i);
      const s = at(slow, i);
      const hi = at(highs, i);
      const lo = at(lows, i);
      if (m === null || f === null || s === null || hi === null || lo === null || i < 90) return null;
      const close = price[i] as number;
      return [
        close > m,                                       // moving average
        close > (price[i - 90] as number),               // momentum
        trend[i] === true,                               // supertrend
        f - s > 0,                                       // MACD sign
        close > (hi + lo) / 2,                           // upper half of the 100-bar channel
      ].filter(Boolean).length;
    };
    return {
      params: { enterVotes, holdVotes },
      warmup: 200,
      enter: (i) => { const n = signals(i); return n !== null && n >= enterVotes; },
      hold: (i) => { const n = signals(i); return n !== null && n >= holdVotes; },
    };
  },
);

export const VOTE_STRATEGIES: readonly StrategyFactory[] = [momentumVote, volumeTrend, familyVote];
