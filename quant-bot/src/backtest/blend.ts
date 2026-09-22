import type { EquityPoint, Timeframe, Trade } from '../domain/types.ts';
import type { Candle } from '../domain/types.ts';
import type { BacktestConfig, BacktestResult } from './engine.ts';
import { DEFAULT_CONFIG, runBacktest } from './engine.ts';
import type { StrategyContext } from '../strategy/types.ts';
import type { Strategy, StrategyFactory, Params } from '../strategy/types.ts';

export interface BlendMember {
  readonly factory: StrategyFactory;
  readonly params: Params;
  /** Fraction of total starting equity given to this strategy, in (0, 1]. */
  readonly weight: number;
  readonly context?: StrategyContext | undefined;
}

export interface BlendTrade extends Trade {
  readonly strategy: string;
}

export interface BlendResult {
  readonly config: BacktestConfig;
  readonly equityCurve: readonly EquityPoint[];
  readonly trades: readonly BlendTrade[];
  readonly startingEquity: number;
  readonly endingEquity: number;
  readonly barsTested: number;
  /** Each member's OWN result, run in isolation at its allocated capital. */
  readonly members: ReadonlyMap<string, BacktestResult>;
  readonly firstHalt: null;
}

/**
 * Runs several strategies at once on the same asset, each managing its own
 * fixed slice of starting capital, and combines them into one account.
 *
 * This is the strategy-level counterpart to portfolio mode's asset-level
 * diversification: instead of spreading risk across coins, it spreads risk
 * across DECISION RULES on the same coin. The mechanism is identical to why
 * that helps — two strategies rarely draw down at the same time for the same
 * reason, so the combined equity curve is smoother than either alone, even
 * though it is built from nothing but the two curves already measured
 * separately. Combining strategies does not create edge that was not already
 * in each one; it only reduces how much any single strategy's bad stretch
 * costs the whole account.
 *
 * Capital is fixed per member at the start, not rebalanced between them — a
 * strategy that loses money does not get topped back up from one that is
 * winning. That is deliberate: rebalancing between strategies would mean a
 * losing strategy keeps getting fresh capital indefinitely, which is a
 * different (and much riskier) design than simply running both.
 */
export function runBlend(
  candles: readonly Candle[],
  members: readonly BlendMember[],
  config: BacktestConfig = DEFAULT_CONFIG,
): BlendResult {
  if (members.length === 0) throw new RangeError('runBlend needs at least one member');
  const weightSum = members.reduce((a, m) => a + m.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    throw new RangeError(`blend weights must sum to 1, got ${weightSum}`);
  }
  for (const m of members) {
    if (m.weight <= 0) throw new RangeError(`blend weight must be > 0, got ${m.weight} for ${m.factory.name}`);
  }
  const names = members.map((m) => m.factory.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate !== undefined) {
    // Results are keyed by strategy name; a duplicate would silently
    // overwrite an earlier member's result rather than losing data loudly.
    // It also would not mean what a caller likely wants -- running the same
    // decision rule twice is not diversification, it is one position sized
    // at the sum of both weights.
    throw new RangeError(`blend cannot run the same strategy ("${duplicate}") twice; use one member at the combined weight instead`);
  }

  const results = new Map<string, BacktestResult>();
  for (const member of members) {
    const subConfig: BacktestConfig = { ...config, startingEquity: config.startingEquity * member.weight };
    const strategy: Strategy = member.factory.create(candles, member.params, member.context);
    results.set(member.factory.name, runBacktest(candles, strategy, subConfig));
  }

  const n = candles.length;
  const equityCurve: EquityPoint[] = [];
  for (let i = 0; i < n; i += 1) {
    let equity = 0;
    let invested = 0;
    for (const result of results.values()) {
      const point = result.equityCurve[i];
      if (!point) continue;
      equity += point.equity;
      invested += point.equity * point.exposure;
    }
    equityCurve.push({
      time: (candles[i] as Candle).time,
      equity,
      exposure: equity > 0 ? invested / equity : 0,
    });
  }

  const trades: BlendTrade[] = [];
  for (const [name, result] of results) {
    for (const trade of result.trades) trades.push({ ...trade, strategy: name });
  }
  trades.sort((a, b) => a.exitTime - b.exitTime);

  const endingEquity = [...results.values()].reduce((a, r) => a + r.endingEquity, 0);

  return {
    config,
    equityCurve,
    trades,
    startingEquity: config.startingEquity,
    endingEquity,
    barsTested: n,
    members: results,
    firstHalt: null,
  };
}

/** Adapts a blend result to the shape `computeMetrics` expects. */
export function asBacktestResult(result: BlendResult): BacktestResult {
  return {
    strategy: { name: 'blend', params: {} },
    config: result.config,
    equityCurve: result.equityCurve,
    trades: result.trades,
    startingEquity: result.startingEquity,
    endingEquity: result.endingEquity,
    firstHalt: null,
    barsTested: result.barsTested,
  };
}

export type { Timeframe };
