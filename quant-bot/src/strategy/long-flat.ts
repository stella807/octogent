import type { Candle, Position, Signal } from '../domain/types.ts';
import { adx, atr, closes, ema, rsi, sma, stdev, type Series } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Thirteen all-in / all-out strategies from different families (breakouts,
 * moving averages, momentum, volatility, regression, cloud). Each is only an
 * entry rule and a hold rule; the shared wrapper turns them into a strategy.
 *
 * All of them share three constraints, for the same reasons `trend-hold` does:
 * no stop price (a tight stop shrinks the position to a sliver under 1%-risk
 * sizing), all in or all out (the live runner cannot scale positions), and
 * every rule is causal: slot `i` reads candles `0..i` only.
 */
interface Rules {
  readonly params: Params;
  readonly warmup: number;
  /** Take a new position at bar `i`. False whenever data is not yet available. */
  readonly enter: (i: number) => boolean;
  /** Keep the open position at bar `i`. */
  readonly hold: (i: number) => boolean;
}

type Build = (candles: readonly Candle[], params: Params) => Rules;

export function longFlat(
  name: string,
  defaults: Params,
  grid: Readonly<Record<string, readonly number[]>>,
  build: Build,
): StrategyFactory {
  return {
    name,
    defaults,
    grid,
    create(candles: readonly Candle[], params: Params): Strategy {
      const rules = build(candles, { ...defaults, ...params });
      return {
        name,
        params: rules.params,
        warmup: rules.warmup,
        signalAt(i: number, position: Position | null): Signal {
          if (position !== null) {
            return rules.hold(i) ? { target: 1, reason: `${name}: holding` } : { target: 0, reason: `${name}: exit` };
          }
          return rules.enter(i) ? { target: 1, reason: `${name}: entry` } : { target: 0 };
        },
      };
    },
  };
}

export const at = (s: Series, i: number): number | null => s[i] ?? null;

/** Highest of the `n` values BEFORE bar i (excludes i), so a close can break it. */
export function priorExtreme(values: readonly number[], n: number, pick: 'max' | 'min'): Series {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = n; i < values.length; i += 1) {
    let v = values[i - 1] as number;
    for (let j = i - n; j < i; j += 1) v = pick === 'max' ? Math.max(v, values[j] as number) : Math.min(v, values[j] as number);
    out[i] = v;
  }
  return out;
}

/** Extreme of the `n` values ending AT bar i (includes i). */
export function windowExtreme(values: readonly number[], n: number, pick: 'max' | 'min'): Series {
  const out: (number | null)[] = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i += 1) {
    let v = values[i] as number;
    for (let j = i - n + 1; j <= i; j += 1) v = pick === 'max' ? Math.max(v, values[j] as number) : Math.min(v, values[j] as number);
    out[i] = v;
  }
  return out;
}

export function check(cond: boolean, message: string): void {
  if (!cond) throw new RangeError(message);
}

/** Supertrend direction per bar: a trailing ATR band that flips the trend when price closes through it. */
export function supertrendUp(candles: readonly Candle[], period: number, mult: number): boolean[] {
  const range = atr(candles, period);
  const up: boolean[] = new Array(candles.length).fill(false);
  let upper = 0;
  let lower = 0;
  let trendUp = false;
  let started = false;
  for (let i = 0; i < candles.length; i += 1) {
    const a = at(range, i);
    if (a === null) continue;
    const c = candles[i] as Candle;
    const mid = (c.high + c.low) / 2;
    const bandUpper = mid + mult * a;
    const bandLower = mid - mult * a;
    if (!started) {
      upper = bandUpper;
      lower = bandLower;
      trendUp = c.close > upper;
      started = true;
    } else {
      const prevClose = (candles[i - 1] as Candle).close;
      upper = bandUpper < upper || prevClose > upper ? bandUpper : upper;
      lower = bandLower > lower || prevClose < lower ? bandLower : lower;
      trendUp = trendUp ? c.close >= lower : c.close > upper;
    }
    up[i] = trendUp;
  }
  return up;
}

/** 1. Enter on a close above the prior N-bar high; leave on a close below the prior M-bar low. */
export const channelHold = longFlat(
  'channel-hold',
  { entry: 55, exit: 20 },
  { entry: [40, 55, 80], exit: [15, 20] },
  (candles, p) => {
    const entry = param(p, 'entry', 55);
    const exit = param(p, 'exit', 20);
    check(exit < entry, `channel-hold needs exit < entry, got ${exit} >= ${entry}`);
    const price = closes(candles);
    const high = priorExtreme(price, entry, 'max');
    const low = priorExtreme(price, exit, 'min');
    return {
      params: { entry, exit },
      warmup: entry,
      enter: (i) => { const h = at(high, i); return h !== null && price[i]! > h; },
      hold: (i) => { const l = at(low, i); return l !== null && price[i]! > l; },
    };
  },
);

/** 2. Golden cross: hold while the fast EMA is above the slow EMA. */
export const goldenCross = longFlat(
  'golden-cross',
  { fast: 50, slow: 200, bandPct: 1 },
  { fast: [30, 50], bandPct: [0, 2] },
  (candles, p) => {
    const fast = param(p, 'fast', 50);
    const slow = param(p, 'slow', 200);
    const band = param(p, 'bandPct', 1) / 100;
    check(fast < slow, `golden-cross needs fast < slow, got ${fast} >= ${slow}`);
    const price = closes(candles);
    const f = ema(price, fast);
    const s = ema(price, slow);
    const above = (i: number, edge: number): boolean => { const a = at(f, i); const b = at(s, i); return a !== null && b !== null && a > b * edge; };
    return { params: { fast, slow, bandPct: band * 100 }, warmup: slow, enter: (i) => above(i, 1 + band), hold: (i) => above(i, 1 - band) };
  },
);

/** 3. MACD above zero and above its signal line; hold while above zero. */
export const macdHold = longFlat(
  'macd-hold',
  { fast: 12, slow: 26, signal: 9 },
  { fast: [12, 20], slow: [26, 50] },
  (candles, p) => {
    const fast = param(p, 'fast', 12);
    const slow = param(p, 'slow', 26);
    const signal = param(p, 'signal', 9);
    check(fast < slow, `macd-hold needs fast < slow, got ${fast} >= ${slow}`);
    const price = closes(candles);
    const f = ema(price, fast);
    const s = ema(price, slow);
    const macd: (number | null)[] = price.map((_, i) => (f[i] != null && s[i] != null ? (f[i] as number) - (s[i] as number) : null));
    const start = macd.findIndex((v) => v !== null);
    const sig: (number | null)[] = new Array(price.length).fill(null);
    if (start >= 0) {
      const line = ema(macd.slice(start) as number[], signal);
      line.forEach((v, k) => { sig[start + k] = v; });
    }
    return {
      params: { fast, slow, signal },
      warmup: slow + signal,
      enter: (i) => { const m = macd[i]; const g = sig[i]; return m != null && g != null && m > 0 && m > g; },
      hold: (i) => { const m = macd[i]; return m != null && m > 0; },
    };
  },
);

/** 4. RSI momentum inside an uptrend: strong RSI above the 200-bar average. */
export const rsiTrend = longFlat(
  'rsi-trend',
  { period: 200, rsiIn: 60, rsiOut: 40 },
  { rsiIn: [55, 60], rsiOut: [40, 45] },
  (candles, p) => {
    const period = param(p, 'period', 200);
    const rsiIn = param(p, 'rsiIn', 60);
    const rsiOut = param(p, 'rsiOut', 40);
    check(rsiOut < rsiIn, `rsi-trend needs rsiOut < rsiIn, got ${rsiOut} >= ${rsiIn}`);
    const price = closes(candles);
    const ma = sma(price, period);
    const r = rsi(price, 14);
    return {
      params: { period, rsiIn, rsiOut },
      warmup: period,
      enter: (i) => { const m = at(ma, i); const v = at(r, i); return m !== null && v !== null && price[i]! > m && v > rsiIn; },
      hold: (i) => { const m = at(ma, i); const v = at(r, i); return m !== null && v !== null && price[i]! > m && v > rsiOut; },
    };
  },
);

/** 5. Supertrend: a trailing ATR band that flips the trend when price closes through it. */
export const supertrendHold = longFlat(
  'supertrend-hold',
  { period: 10, mult: 3 },
  { period: [10, 20], mult: [2, 3] },
  (candles, p) => {
    const period = param(p, 'period', 10);
    const mult = param(p, 'mult', 3);
    check(mult > 0, `supertrend-hold needs mult > 0, got ${mult}`);
    const up = supertrendUp(candles, period, mult);
    return { params: { period, mult }, warmup: period + 1, enter: (i) => up[i] === true, hold: (i) => up[i] === true };
  },
);

/** 6. ADX trend strength: a strong trend (ADX high) with +DI over -DI. */
export const adxTrend = longFlat(
  'adx-trend',
  { period: 14, adxMin: 25 },
  { adxMin: [20, 25, 30] },
  (candles, p) => {
    const period = param(p, 'period', 14);
    const adxMin = param(p, 'adxMin', 25);
    const d = adx(candles, period);
    return {
      params: { period, adxMin },
      warmup: period * 2 + 1,
      enter: (i) => { const a = at(d.adx, i); const plus = at(d.plusDI, i); const minus = at(d.minusDI, i); return a !== null && plus !== null && minus !== null && a > adxMin && plus > minus; },
      hold: (i) => { const plus = at(d.plusDI, i); const minus = at(d.minusDI, i); return plus !== null && minus !== null && plus > minus; },
    };
  },
);

/** 7. Keltner breakout: a close above the EMA plus a multiple of ATR; hold above the EMA. */
export const keltnerHold = longFlat(
  'keltner-hold',
  { period: 20, atrPeriod: 10, mult: 2 },
  { period: [20, 50], mult: [1.5, 2] },
  (candles, p) => {
    const period = param(p, 'period', 20);
    const atrPeriod = param(p, 'atrPeriod', 10);
    const mult = param(p, 'mult', 2);
    const price = closes(candles);
    const mid = ema(price, period);
    const range = atr(candles, atrPeriod);
    return {
      params: { period, atrPeriod, mult },
      warmup: Math.max(period, atrPeriod) + 1,
      enter: (i) => { const m = at(mid, i); const a = at(range, i); return m !== null && a !== null && price[i]! > m + mult * a; },
      hold: (i) => { const m = at(mid, i); return m !== null && price[i]! > m; },
    };
  },
);

/** 8. Bollinger trend: a close above the upper band (mean + k standard deviations); hold above the mean. */
export const bollingerTrend = longFlat(
  'bollinger-trend',
  { period: 20, k: 2 },
  { period: [20, 50], k: [1.5, 2] },
  (candles, p) => {
    const period = param(p, 'period', 20);
    const k = param(p, 'k', 2);
    const price = closes(candles);
    const mid = sma(price, period);
    const sd = stdev(price, period);
    return {
      params: { period, k },
      warmup: period,
      enter: (i) => { const m = at(mid, i); const s = at(sd, i); return m !== null && s !== null && price[i]! > m + k * s; },
      hold: (i) => { const m = at(mid, i); return m !== null && price[i]! > m; },
    };
  },
);

/** 9. Near the 252-bar high in an uptrend; hold until 15% below that high. */
export const highProximity = longFlat(
  'high-proximity',
  { lookback: 252, nearPct: 5, exitPct: 15, trend: 100 },
  { nearPct: [5, 10], exitPct: [15, 25] },
  (candles, p) => {
    const lookback = param(p, 'lookback', 252);
    const nearPct = param(p, 'nearPct', 5);
    const exitPct = param(p, 'exitPct', 15);
    const trend = param(p, 'trend', 100);
    check(nearPct < exitPct, `high-proximity needs nearPct < exitPct, got ${nearPct} >= ${exitPct}`);
    const price = closes(candles);
    const top = windowExtreme(price, lookback, 'max');
    const ma = sma(price, trend);
    return {
      params: { lookback, nearPct, exitPct, trend },
      warmup: lookback,
      enter: (i) => { const h = at(top, i); const m = at(ma, i); return h !== null && m !== null && price[i]! >= h * (1 - nearPct / 100) && price[i]! > m; },
      hold: (i) => { const h = at(top, i); return h !== null && price[i]! >= h * (1 - exitPct / 100); },
    };
  },
);

/** 10. Ichimoku: price above the cloud (spans projected from 26 bars ago) with the conversion line over the base line. */
export const ichimokuHold = longFlat(
  'ichimoku-hold',
  { tenkan: 9, kijun: 26, senkou: 52 },
  { tenkan: [9, 12], kijun: [26, 34] },
  (candles, p) => {
    const tenkan = param(p, 'tenkan', 9);
    const kijun = param(p, 'kijun', 26);
    const senkou = param(p, 'senkou', 52);
    check(tenkan < kijun && kijun < senkou, `ichimoku-hold needs tenkan < kijun < senkou, got ${tenkan}, ${kijun}, ${senkou}`);
    const high = candles.map((c) => c.high);
    const low = candles.map((c) => c.low);
    const mid = (n: number): (number | null)[] => {
      const hi = windowExtreme(high, n, 'max');
      const lo = windowExtreme(low, n, 'min');
      return hi.map((h, i) => (h !== null && lo[i] != null ? (h + (lo[i] as number)) / 2 : null));
    };
    const conv = mid(tenkan);
    const base = mid(kijun);
    const spanB = mid(senkou);
    /** The cloud plotted at bar i was computed `kijun` bars earlier. */
    const cloudTop = (i: number): number | null => {
      const j = i - kijun;
      const c = at(conv, j);
      const b = at(base, j);
      const sb = at(spanB, j);
      return c !== null && b !== null && sb !== null ? Math.max((c + b) / 2, sb) : null;
    };
    return {
      params: { tenkan, kijun, senkou },
      warmup: senkou + kijun,
      enter: (i) => { const t = cloudTop(i); const c = at(conv, i); const b = at(base, i); return t !== null && c !== null && b !== null && candles[i]!.close > t && c > b; },
      hold: (i) => { const t = cloudTop(i); return t !== null && candles[i]!.close > t; },
    };
  },
);

/** 11. Calm trend: above the 200-bar average, but only entered when recent volatility is below its longer-run level. */
export const calmTrend = longFlat(
  'calm-trend',
  { period: 200, bandPct: 2, shortVol: 20, longVol: 100 },
  { bandPct: [0, 2], shortVol: [20, 30] },
  (candles, p) => {
    const period = param(p, 'period', 200);
    const band = param(p, 'bandPct', 2) / 100;
    const shortVol = param(p, 'shortVol', 20);
    const longVol = param(p, 'longVol', 100);
    check(shortVol < longVol, `calm-trend needs shortVol < longVol, got ${shortVol} >= ${longVol}`);
    const price = closes(candles);
    const ma = sma(price, period);
    const r = price.map((v, i) => (i === 0 ? 0 : Math.log(v / (price[i - 1] as number))));
    const fastSd = stdev(r, shortVol);
    const slowSd = stdev(r, longVol);
    return {
      params: { period, bandPct: band * 100, shortVol, longVol },
      warmup: Math.max(period, longVol),
      enter: (i) => { const m = at(ma, i); const a = at(fastSd, i); const b = at(slowSd, i); return m !== null && a !== null && b !== null && price[i]! > m * (1 + band) && a < b; },
      hold: (i) => { const m = at(ma, i); return m !== null && price[i]! > m * (1 - band); },
    };
  },
);

/** 12. Regression trend: a clean, rising log-price line over N bars (positive slope and R-squared above a floor). */
export const regressionTrend = longFlat(
  'regression-trend',
  { window: 100, r2Min: 0.6 },
  { window: [60, 100], r2Min: [0.5, 0.7] },
  (candles, p) => {
    const window = Math.trunc(param(p, 'window', 100));
    const r2Min = param(p, 'r2Min', 0.6);
    check(window >= 10, `regression-trend needs window >= 10, got ${window}`);
    const logs = closes(candles).map((v) => Math.log(v));
    const xMean = (window - 1) / 2;
    let sxx = 0;
    for (let k = 0; k < window; k += 1) sxx += (k - xMean) ** 2;
    const fit = (i: number): { slope: number; r2: number } | null => {
      if (i < window - 1) return null;
      let yMean = 0;
      for (let k = 0; k < window; k += 1) yMean += logs[i - window + 1 + k] as number;
      yMean /= window;
      let sxy = 0;
      let syy = 0;
      for (let k = 0; k < window; k += 1) {
        const dy = (logs[i - window + 1 + k] as number) - yMean;
        sxy += (k - xMean) * dy;
        syy += dy * dy;
      }
      return { slope: sxy / sxx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 0 };
    };
    return {
      params: { window, r2Min },
      warmup: window,
      enter: (i) => { const f = fit(i); return f !== null && f.slope > 0 && f.r2 >= r2Min; },
      hold: (i) => { const f = fit(i); return f !== null && f.slope > 0; },
    };
  },
);

/** 13. Dip in an uptrend: buy a short-term RSI washout while above the 200-bar average; sell the bounce or the trend break. */
export const dipInUptrend = longFlat(
  'dip-in-uptrend',
  { period: 200, rsiPeriod: 5, rsiIn: 30, rsiOut: 60 },
  { rsiIn: [25, 30, 35], rsiOut: [55, 65] },
  (candles, p) => {
    const period = param(p, 'period', 200);
    const rsiPeriod = param(p, 'rsiPeriod', 5);
    const rsiIn = param(p, 'rsiIn', 30);
    const rsiOut = param(p, 'rsiOut', 60);
    check(rsiIn < rsiOut, `dip-in-uptrend needs rsiIn < rsiOut, got ${rsiIn} >= ${rsiOut}`);
    const price = closes(candles);
    const ma = sma(price, period);
    const r = rsi(price, rsiPeriod);
    return {
      params: { period, rsiPeriod, rsiIn, rsiOut },
      warmup: period,
      enter: (i) => { const m = at(ma, i); const v = at(r, i); return m !== null && v !== null && price[i]! > m && v < rsiIn; },
      hold: (i) => { const m = at(ma, i); const v = at(r, i); return m !== null && v !== null && price[i]! > m && v < rsiOut; },
    };
  },
);

export const LONG_FLAT_STRATEGIES: readonly StrategyFactory[] = [
  channelHold, goldenCross, macdHold, rsiTrend, supertrendHold, adxTrend, keltnerHold,
  bollingerTrend, highProximity, ichimokuHold, calmTrend, regressionTrend, dipInUptrend,
];
