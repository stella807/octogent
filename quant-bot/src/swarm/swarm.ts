import type { Candle } from '../domain/types.ts';
import { mulberry32 } from '../backtest/monte-carlo.ts';

/**
 * A free, rule-based take on "simulate a crowd, rehearse the future many
 * times": no language model, no API key, runs in milliseconds.
 *
 * The crowd is a population of trading styles:
 *   - trend followers, each watching a different lookback, who buy what has
 *     been rising;
 *   - mean reverters, each anchored to a different average, who buy what has
 *     fallen below it;
 *   - noise traders, represented by the part of every price move the rest of
 *     the crowd does not explain.
 *
 * The crowd evolves: each bar, every style's paper profit is scored and the
 * population drifts toward whatever has been working (heterogeneous-agent
 * "adaptive belief" dynamics, Brock & Hommes 1998). That is how a market
 * herds into momentum and later flips to reversal.
 *
 * The one honest constraint that matters: how strongly the crowd's net
 * demand moves price is fitted only on bars before the forecast, by
 * regression. If the crowd has not actually predicted anything recently, that
 * fit is near zero and the forecast collapses to the plain historical up-rate
 * instead of inventing confidence.
 */
export type ArchetypeKind = 'trend' | 'revert';

export interface Archetype {
  readonly kind: ArchetypeKind;
  readonly lookback: number;
}

/**
 * Both sides of the crowd get the same horizons. An asymmetric set — a
 * 2-bar trend follower with no 2-bar contrarian — leaves the swarm unable to
 * see short-term reversal at all, which the scorecard caught.
 */
const LOOKBACKS = [2, 5, 10, 20, 50, 100];

export const DEFAULT_ARCHETYPES: readonly Archetype[] = [
  ...LOOKBACKS.map((lookback) => ({ kind: 'trend' as const, lookback })),
  ...LOOKBACKS.map((lookback) => ({ kind: 'revert' as const, lookback })),
];

export interface SwarmConfig {
  readonly archetypes: readonly Archetype[];
  /** How hard the crowd herds toward recently profitable styles. 0 = fixed, equal mix. */
  readonly herding: number;
  /**
   * Weight each bar keeps of a style's past profitability (0..1). 0.99 judges
   * styles on roughly the last 100 bars. At 0.95 (~20 bars) the crowd chased
   * luck: in a reverting market its dominant style changed every ~5 bars and
   * threw away most of a real signal (correlation with the next move 0.28 for
   * the average mix, 0.09 live).
   */
  readonly memory: number;
  /** Trailing bars used to fit how strongly net demand moves price. */
  readonly fitWindow: number;
  /** Simulated futures per forecast. */
  readonly paths: number;
  readonly seed: number;
}

export const DEFAULT_SWARM: SwarmConfig = {
  archetypes: DEFAULT_ARCHETYPES,
  herding: 2,
  memory: 0.99,
  fitWindow: 250,
  paths: 500,
  seed: 42,
};

const VOL_WINDOW = 20;

/**
 * Everything the swarm knows at each bar, computed in one causal pass: every
 * entry at index t depends only on bars 0..t.
 */
export interface SwarmState {
  readonly config: SwarmConfig;
  /** Log closes. */
  readonly x: readonly number[];
  /** Trailing volatility of 1-bar log returns; null during warmup. */
  readonly vol: readonly (number | null)[];
  /** Each style's demand in [-1, 1] at bar t; null during warmup. */
  readonly demand: readonly (readonly number[] | null)[];
  /** Population share of each style at bar t (sums to 1). */
  readonly share: readonly (readonly number[])[];
  /** Crowd net demand at bar t: sum of share * demand. */
  readonly net: readonly (number | null)[];
  /** First bar a forecast can be made from. */
  readonly warmup: number;
}

export function buildSwarm(candles: readonly Candle[], config: SwarmConfig = DEFAULT_SWARM): SwarmState {
  validate(config);
  const k = config.archetypes.length;
  const maxLookback = Math.max(...config.archetypes.map((a) => a.lookback));
  const x = candles.map((c) => Math.log(c.close));
  const vol: (number | null)[] = [];
  const demand: (number[] | null)[] = [];
  const share: number[][] = [];
  const net: (number | null)[] = [];
  const fitness = new Array<number>(k).fill(0);

  for (let t = 0; t < x.length; t += 1) {
    vol.push(trailingVol(x, t));
    const d = demandsAt(x, t, vol[t] ?? null, config.archetypes);
    demand.push(d);

    // Score yesterday's positions against today's move, then re-mix the crowd.
    const prev = demand[t - 1];
    const prevVol = vol[t - 1];
    if (prev && prevVol) {
      const move = ((x[t] as number) - (x[t - 1] as number)) / prevVol;
      for (let j = 0; j < k; j += 1) {
        fitness[j] = config.memory * (fitness[j] as number) + (prev[j] as number) * move;
      }
    }
    const s = softmax(fitness, config.herding);
    share.push(s);
    net.push(d ? d.reduce((sum, v, j) => sum + v * (s[j] as number), 0) : null);
  }

  return {
    config, x, vol, demand, share, net,
    warmup: maxLookback + VOL_WINDOW + config.fitWindow + 1,
  };
}

export interface SwarmForecast {
  /** Bar index the forecast was made from; uses bars 0..t only. */
  readonly t: number;
  readonly horizon: number;
  /** Share of simulated futures that ended above the price at t. */
  readonly pUp: number;
  /** Mean simulated log return over the horizon. */
  readonly expectedLogReturn: number;
  /** Fitted price impact of the crowd's net demand; near 0 means no recent predictive power. */
  readonly impact: number;
  /** Fitted per-bar drift. */
  readonly drift: number;
  /** Crowd net demand at t, in [-1, 1]. */
  readonly netDemand: number;
  /** Styles sorted by current population share, largest first. */
  readonly crowd: readonly { readonly archetype: Archetype; readonly share: number; readonly demand: number }[];
}

/**
 * Plays the crowd forward `paths` times from bar t and counts how many
 * futures end up. Seeded per bar, so a forecast is identical whether it is
 * made live or reproduced later inside a backtest.
 */
export function forecastAt(state: SwarmState, t: number, horizon = 1): SwarmForecast {
  if (!Number.isInteger(horizon) || horizon < 1) throw new RangeError(`horizon must be an integer >= 1, got ${horizon}`);
  if (t < state.warmup || t >= state.x.length) {
    throw new RangeError(`bar ${t} is outside the forecastable range [${state.warmup}, ${state.x.length - 1}]`);
  }
  const { config } = state;
  const fit = fitImpact(state, t);
  const shares = state.share[t] as readonly number[];
  const demands = state.demand[t] as readonly number[];
  const crowd = config.archetypes
    .map((archetype, j) => ({ archetype, share: shares[j] as number, demand: demands[j] as number }))
    .sort((a, b) => b.share - a.share);
  const netDemand = state.net[t] as number;

  if (horizon === 1) {
    // One step has a closed form: count the resampled noise draws that would
    // land above zero. Exact, so the score carries no Monte Carlo noise.
    const mu = fit.drift + fit.impact * netDemand;
    const up = fit.residuals.filter((e) => mu + e > 0).length;
    const meanResidual = fit.residuals.reduce((a, e) => a + e, 0) / fit.residuals.length;
    return {
      t, horizon, pUp: up / fit.residuals.length, expectedLogReturn: mu + meanResidual,
      impact: fit.impact, drift: fit.drift, netDemand, crowd,
    };
  }

  const rand = mulberry32(config.seed + t * 7919);
  const maxLookback = Math.max(...config.archetypes.map((a) => a.lookback));
  const history = state.x.slice(Math.max(0, t - maxLookback - VOL_WINDOW - 1), t + 1);

  let up = 0;
  let sumReturn = 0;
  for (let p = 0; p < config.paths; p += 1) {
    const path = [...history];
    const fitness = [...(state.share[t] as number[])].map((s) => Math.log(Math.max(s, 1e-12)) / Math.max(config.herding, 1e-9));
    let s = state.share[t] as readonly number[];
    let d = state.demand[t] as readonly number[];
    let v = state.vol[t] as number;
    for (let step = 0; step < horizon; step += 1) {
      const pathDemand = d.reduce((sum, value, j) => sum + value * (s[j] as number), 0);
      const residual = fit.residuals[Math.floor(rand() * fit.residuals.length)] as number;
      const r = fit.drift + fit.impact * pathDemand + residual;
      path.push((path[path.length - 1] as number) + r);
      if (step === horizon - 1) break;
      // The crowd keeps evolving inside the simulated future, too.
      for (let j = 0; j < d.length; j += 1) fitness[j] = config.memory * (fitness[j] as number) + (d[j] as number) * (r / v);
      s = softmax(fitness, config.herding);
      const last = path.length - 1;
      v = trailingVol(path, last) ?? v;
      d = demandsAt(path, last, v, config.archetypes) ?? d;
    }
    const total = (path[path.length - 1] as number) - (state.x[t] as number);
    if (total > 0) up += 1;
    sumReturn += total;
  }

  return {
    t,
    horizon,
    pUp: up / config.paths,
    expectedLogReturn: sumReturn / config.paths,
    impact: fit.impact,
    drift: fit.drift,
    netDemand,
    crowd,
  };
}

interface ImpactFit {
  readonly drift: number;
  readonly impact: number;
  /** What the crowd did not explain; resampled as the noise traders. */
  readonly residuals: readonly number[];
}

/** OLS of next-bar log return on crowd net demand, over bars that closed by t. */
function fitImpact(state: SwarmState, t: number): ImpactFit {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let s = t - state.config.fitWindow; s < t; s += 1) {
    const n = state.net[s];
    if (s < 0 || n === null || n === undefined) continue;
    xs.push(n);
    ys.push((state.x[s + 1] as number) - (state.x[s] as number));
  }
  const m = xs.length;
  const meanX = xs.reduce((a, v) => a + v, 0) / m;
  const meanY = ys.reduce((a, v) => a + v, 0) / m;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < m; i += 1) {
    sxx += ((xs[i] as number) - meanX) ** 2;
    sxy += ((xs[i] as number) - meanX) * ((ys[i] as number) - meanY);
  }
  const raw = sxx > 1e-12 ? sxy / sxx : 0;
  // Empirical-Bayes shrinkage: keep only the part of the fitted impact that
  // stands out from its own standard error. On 250 bars of pure noise the raw
  // slope is never exactly zero, and trusting it makes the swarm lean on
  // patterns that are not there — measurably worse than the plain up-rate.
  const rawResidualVar = ys.reduce((acc, y, i) => {
    const e = y - (meanY - raw * meanX) - raw * (xs[i] as number);
    return acc + e * e;
  }, 0) / Math.max(m - 2, 1);
  const se2 = sxx > 1e-12 ? rawResidualVar / sxx : Infinity;
  const impact = raw === 0 ? 0 : raw * Math.max(0, 1 - se2 / (raw * raw));
  const drift = meanY - impact * meanX;
  const residuals = ys.map((y, i) => y - drift - impact * (xs[i] as number));
  return { drift, impact, residuals };
}

function trailingVol(x: readonly number[], t: number): number | null {
  if (t < VOL_WINDOW) return null;
  let sum = 0;
  let sumSq = 0;
  for (let i = t - VOL_WINDOW + 1; i <= t; i += 1) {
    const r = (x[i] as number) - (x[i - 1] as number);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / VOL_WINDOW;
  const variance = Math.max(sumSq / VOL_WINDOW - mean * mean, 0);
  return Math.max(Math.sqrt(variance), 1e-6);
}

function demandsAt(
  x: readonly number[],
  t: number,
  vol: number | null,
  archetypes: readonly Archetype[],
): number[] | null {
  if (vol === null) return null;
  const out: number[] = [];
  for (const a of archetypes) {
    if (t < a.lookback) return null;
    const scale = vol * Math.sqrt(a.lookback);
    if (a.kind === 'trend') {
      out.push(Math.tanh(((x[t] as number) - (x[t - a.lookback] as number)) / scale));
    } else {
      let mean = 0;
      for (let i = t - a.lookback + 1; i <= t; i += 1) mean += x[i] as number;
      mean /= a.lookback;
      out.push(-Math.tanh(((x[t] as number) - mean) / scale));
    }
  }
  return out;
}

function softmax(fitness: readonly number[], herding: number): number[] {
  const scaled = fitness.map((f) => herding * f);
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, v) => a + v, 0);
  return exps.map((v) => v / total);
}

function validate(c: SwarmConfig): void {
  if (c.archetypes.length === 0) throw new RangeError('the swarm needs at least one archetype');
  for (const a of c.archetypes) {
    if (!Number.isInteger(a.lookback) || a.lookback < 1) throw new RangeError(`archetype lookback must be an integer >= 1, got ${a.lookback}`);
  }
  if (c.herding < 0) throw new RangeError(`herding must be >= 0, got ${c.herding}`);
  if (c.memory < 0 || c.memory > 1) throw new RangeError(`memory must be in [0, 1], got ${c.memory}`);
  if (!Number.isInteger(c.fitWindow) || c.fitWindow < 30) throw new RangeError(`fitWindow must be an integer >= 30, got ${c.fitWindow}`);
  if (!Number.isInteger(c.paths) || c.paths < 1) throw new RangeError(`paths must be an integer >= 1, got ${c.paths}`);
}
