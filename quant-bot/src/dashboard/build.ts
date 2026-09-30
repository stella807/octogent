import type { Candle } from '../domain/types.ts';
import type { ScreenRow } from '../backtest/screen.ts';
import type { PaperStatus } from '../live/status.ts';
import type { LuckControl } from '../screen-file.ts';
import { buildSwarm, DEFAULT_SWARM, forecastAt, type SwarmConfig } from '../swarm/swarm.ts';
import { evaluateSwarm } from '../swarm/score.ts';

/**
 * Everything the dashboard shows about one coin, computed from closed daily
 * bars only. The forecast and its track record come from the same swarm, so
 * the page can show a lean next to the evidence for trusting it.
 */
export interface CoinSnapshot {
  readonly symbol: string;
  readonly bars: number;
  readonly lastTime: number;
  readonly last: number;
  readonly change1d: number | null;
  readonly change30d: number | null;
  /** Last closes, oldest first, for the sparkline. */
  readonly spark: readonly number[];
  readonly forecast: {
    readonly pUp: number;
    readonly netDemand: number;
    /** Zero when the crowd has shown no recent predictive power. */
    readonly impact: number;
    readonly leadingStyle: string;
    readonly leadingShare: number;
  } | null;
  /** The swarm scored on every past day of this coin, from earlier days only. */
  readonly track: {
    readonly n: number;
    readonly skill: number;
    readonly t: number;
    readonly directionRight: number;
    readonly verdict: 'skill' | 'none' | 'worse';
  } | null;
  readonly screen: Pick<ScreenRow, 'passed' | 'reason' | 'efficiency' | 'oosReturnPct' | 'oosTrades'> | null;
  readonly position: {
    readonly qty: number;
    readonly entryPrice: number | null;
    readonly stopPrice: number | null;
    readonly unrealized: number | null;
  } | null;
}

export interface Dashboard {
  readonly generatedAt: string;
  readonly exchange: string;
  readonly timeframe: '1d';
  readonly strategy: string;
  readonly coins: readonly CoinSnapshot[];
  readonly summary: {
    readonly coins: number;
    readonly forecastable: number;
    /** Coins where the swarm beat the up-rate with t >= 2. */
    readonly skilled: number;
    /** Coins where it did worse with t <= -2. */
    readonly worse: number;
    /** How many t >= 2 results pure chance produces across this many coins (one-sided 2.3%). */
    readonly skilledByChance: number;
    readonly screenPassed: number;
    readonly screenTested: number;
    readonly luck: LuckControl | null;
  };
  readonly paper: PaperStatus | null;
}

const SPARK_BARS = 90;
/** One-sided probability of t >= 2 under no skill. */
const P_T_ABOVE_2 = 0.0228;

export function snapshotCoin(
  symbol: string,
  candles: readonly Candle[],
  screen: ScreenRow | undefined,
  paper: PaperStatus | null,
  config: SwarmConfig = DEFAULT_SWARM,
): CoinSnapshot | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const closeAgo = (n: number): number | null => candles[candles.length - 1 - n]?.close ?? null;
  const change = (n: number): number | null => {
    const then = closeAgo(n);
    return then ? last.close / then - 1 : null;
  };

  let forecast: CoinSnapshot['forecast'] = null;
  let track: CoinSnapshot['track'] = null;
  const state = buildSwarm(candles, config);
  // Enough history for at least a month of scored forecasts before trusting a verdict.
  if (candles.length - 1 >= state.warmup + 30) {
    const f = forecastAt(state, candles.length - 1, 1);
    const lead = f.crowd[0];
    forecast = {
      pUp: f.pUp,
      netDemand: f.netDemand,
      impact: f.impact,
      leadingStyle: lead ? `${lead.archetype.kind === 'trend' ? 'trend follower' : 'contrarian'}, ${lead.archetype.lookback}-day` : '',
      leadingShare: lead?.share ?? 0,
    };
    const { card } = evaluateSwarm(candles, { horizon: 1, config });
    track = {
      n: card.n,
      skill: card.skillVsBaseRate,
      t: card.tStatVsBaseRate,
      directionRight: card.directionalHitRate,
      verdict: card.tStatVsBaseRate >= 2 ? 'skill' : card.tStatVsBaseRate <= -2 ? 'worse' : 'none',
    };
  }

  const held = paper?.positions.find((p) => p.symbol === symbol);
  return {
    symbol,
    bars: candles.length,
    lastTime: last.time,
    last: last.close,
    change1d: change(1),
    change30d: change(30),
    spark: candles.slice(-SPARK_BARS).map((c) => Number(c.close.toPrecision(6))),
    forecast,
    track,
    screen: screen
      ? {
        passed: screen.passed,
        reason: screen.reason,
        efficiency: screen.efficiency,
        oosReturnPct: screen.oosReturnPct,
        oosTrades: screen.oosTrades,
      }
      : null,
    position: held
      ? { qty: held.qty, entryPrice: held.entryPrice, stopPrice: held.stopPrice, unrealized: held.unrealized }
      : null,
  };
}

export function assembleDashboard(input: {
  readonly generatedAt: Date;
  readonly exchange: string;
  readonly strategy: string;
  readonly coins: readonly CoinSnapshot[];
  readonly screenRows: readonly ScreenRow[];
  readonly luck: LuckControl | null;
  readonly paper: PaperStatus | null;
}): Dashboard {
  const tracked = input.coins.filter((c) => c.track !== null);
  return {
    generatedAt: input.generatedAt.toISOString(),
    exchange: input.exchange,
    timeframe: '1d',
    strategy: input.strategy,
    coins: input.coins,
    summary: {
      coins: input.coins.length,
      forecastable: tracked.length,
      skilled: tracked.filter((c) => c.track?.verdict === 'skill').length,
      worse: tracked.filter((c) => c.track?.verdict === 'worse').length,
      skilledByChance: Number((tracked.length * P_T_ABOVE_2).toFixed(1)),
      screenPassed: input.screenRows.filter((r) => r.passed).length,
      screenTested: input.screenRows.filter((r) => r.efficiency !== null || r.oosTrades > 0).length,
      luck: input.luck,
    },
    paper: input.paper,
  };
}

/**
 * Puts the snapshot inside the page itself. A page opened from disk can't
 * fetch a sibling JSON file (browsers block file:// fetches), so the data
 * ships embedded; `<` is escaped so no value can close the script tag.
 */
export function renderDashboardPage(template: string, dashboard: Dashboard, standalone: boolean): string {
  const json = JSON.stringify(dashboard).replace(/</g, '\\u003c');
  const body = template.replace('__DASHBOARD_DATA__', () => json);
  if (!standalone) return body;
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' +
    body + '</body></html>';
}
