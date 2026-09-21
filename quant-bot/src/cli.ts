import { parseArgs } from 'node:util';
import type { Candle, Timeframe } from './domain/types.ts';
import { TIMEFRAME_MS } from './domain/types.ts';
import { DEFAULT_COSTS } from './backtest/costs.ts';
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig } from './backtest/engine.ts';
import { computeMetrics } from './backtest/metrics.ts';
import { DEFAULT_MC_OPTIONS, monteCarlo } from './backtest/monte-carlo.ts';
import { DEFAULT_WF_OPTIONS, walkForward, type Objective } from './backtest/walk-forward.ts';
import { loadCsv } from './data/csv.ts';
import { fetchCandles } from './data/exchange.ts';
import { barsForRange, clipToRange, parseRange, type DateRange } from './data/range.ts';
import { generateCandles } from './data/synthetic.ts';
import { BENCHMARK_LIMITS, DEFAULT_LIMITS, type RiskLimits } from './risk/risk-manager.ts';
import { formatBacktest, formatMonteCarlo, formatPortfolio, formatWalkForward } from './report.ts';
import { buyAndHold, getStrategy, STRATEGIES } from './strategy/index.ts';
import type { Params } from './strategy/types.ts';
import { PaperBroker } from './live/paper-broker.ts';
import { ExchangeBroker, LIVE_CONFIRM_ENV, LIVE_CONFIRM_VALUE } from './live/exchange-broker.ts';
import { LiveRunner } from './live/runner.ts';
import { alignCandles, alignmentCoverage } from './portfolio/align.ts';
import { runPortfolioBacktest } from './portfolio/engine.ts';
import { equalWeight, getPortfolioStrategy, PORTFOLIO_STRATEGIES } from './portfolio/index.ts';

const USAGE = `
quant-bot — crypto strategy research and paper trading

  backtest     Run one strategy over history and print the full risk report
  compare      Run every strategy plus buy-and-hold, side by side
  portfolio    Run a multi-asset strategy against an equal-weight benchmark
  walkforward  Pick parameters out-of-sample and report what survived
  montecarlo   Resample trade order to show the real spread of outcomes
  paper        Trade live market data with simulated fills (no real money)
  live         Trade real funds. Requires --live and ${LIVE_CONFIRM_ENV}=${LIVE_CONFIRM_VALUE}

Data (pick one; defaults to --synthetic so it runs with no network)
  --symbol BTC/USDT      Exchange pair
  --exchange binance     Any ccxt-supported exchange
  --csv path.csv         timestamp,open,high,low,close,volume
  --since 2021-11-01     Start of the window (UTC). Enables bear-only tests.
  --until 2022-12-31     End of the window (UTC)
  --synthetic            Seeded regime-switching simulation, for smoke tests

Common
  --strategy NAME        ${Object.keys(STRATEGIES).join(' | ')}
                         portfolio: ${Object.keys(PORTFOLIO_STRATEGIES).join(' | ')}
  --symbols A,B,C        Universe for the portfolio command
  --timeframe 1d         1m 5m 15m 1h 4h 1d
  --bars 1500            How much history to use
  --equity 10000         Starting equity in quote currency
  --risk 1               Percent of equity risked per trade
  --max-drawdown 25      Percent drawdown that trips the kill switch
  --max-daily-loss 5     Percent daily loss that pauses trading
  --fee-bps 10           Taker fee per side
  --slippage-bps 5       Slippage per side
  --min-order 1          Exchange minimum order size, in quote currency
  --param k=v            Override a strategy parameter (repeatable)
  --json                 Machine-readable output
`;

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  const { values } = parseArgs({
    args: [...argv.slice(1)],
    allowPositionals: false,
    options: {
      strategy: { type: 'string', default: 'donchian-breakout' },
      symbol: { type: 'string', default: 'BTC/USDT' },
      symbols: { type: 'string', default: 'BTC/USD,ETH/USD,SOL/USD,LTC/USD,LINK/USD,AVAX/USD' },
      exchange: { type: 'string', default: 'binance' },
      timeframe: { type: 'string', default: '1d' },
      bars: { type: 'string', default: '1500' },
      equity: { type: 'string', default: '10000' },
      risk: { type: 'string', default: String(DEFAULT_LIMITS.riskPerTradePct) },
      'max-drawdown': { type: 'string', default: String(DEFAULT_LIMITS.maxDrawdownPct) },
      'max-daily-loss': { type: 'string', default: String(DEFAULT_LIMITS.maxDailyLossPct) },
      'max-position': { type: 'string', default: String(DEFAULT_LIMITS.maxPositionPct) },
      'fee-bps': { type: 'string', default: String(DEFAULT_COSTS.feeBps) },
      'slippage-bps': { type: 'string', default: String(DEFAULT_COSTS.slippageBps) },
      'min-order': { type: 'string', default: String(DEFAULT_COSTS.minOrderNotional) },
      folds: { type: 'string', default: String(DEFAULT_WF_OPTIONS.folds) },
      objective: { type: 'string', default: DEFAULT_WF_OPTIONS.objective },
      runs: { type: 'string', default: String(DEFAULT_MC_OPTIONS.runs) },
      csv: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      synthetic: { type: 'boolean', default: false },
      seed: { type: 'string', default: '42' },
      param: { type: 'string', multiple: true, default: [] },
      live: { type: 'boolean', default: false },
      state: { type: 'string', default: '.quant-bot/runner-state.json' },
      json: { type: 'boolean', default: false },
    },
  });

  const timeframe = asTimeframe(values.timeframe as string);
  const limits: RiskLimits = {
    riskPerTradePct: num(values.risk, 'risk'),
    maxPositionPct: num(values['max-position'], 'max-position'),
    maxDailyLossPct: num(values['max-daily-loss'], 'max-daily-loss'),
    maxDrawdownPct: num(values['max-drawdown'], 'max-drawdown'),
    minEquity: 0,
  };
  const config: BacktestConfig = {
    ...DEFAULT_CONFIG,
    startingEquity: num(values.equity, 'equity'),
    costs: {
      feeBps: num(values['fee-bps'], 'fee-bps'),
      slippageBps: num(values['slippage-bps'], 'slippage-bps'),
      minOrderNotional: num(values['min-order'], 'min-order'),
    },
    limits,
    timeframe,
  };
  const range = parseRange(values.since as string | undefined, values.until as string | undefined);
  if (range.since !== undefined && range.until !== undefined && range.since >= range.until) {
    throw new Error('--since must be earlier than --until');
  }
  const bars = barsForRange(range, timeframe, Math.trunc(num(values.bars, 'bars')));
  const overrides = parseParams(values.param as string[]);

  const loadData = (): Promise<Candle[]> => loadCandles({
    csv: values.csv as string | undefined,
    synthetic: values.synthetic as boolean,
    symbol: values.symbol as string,
    exchange: values.exchange as string,
    timeframe,
    bars,
    range,
    seed: Math.trunc(num(values.seed, 'seed')),
  });

  switch (command) {
    case 'backtest': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const result = runBacktest(candles, factory.create(candles, params), config);
      const bench = runBacktest(candles, buyAndHold.create(candles, {}), benchmarkConfig(config));
      if (values.json) {
        emit({ metrics: computeMetrics(result), benchmark: computeMetrics(bench), trades: result.trades });
      } else {
        process.stdout.write(`${formatBacktest(result, bench)}\n`);
      }
      return 0;
    }

    case 'compare': {
      const candles = await loadData();
      const rows: Record<string, unknown>[] = [];
      for (const factory of Object.values(STRATEGIES)) {
        const runConfig = factory.name === buyAndHold.name ? benchmarkConfig(config) : config;
        const result = runBacktest(candles, factory.create(candles, factory.defaults), runConfig);
        const m = computeMetrics(result);
        rows.push({
          strategy: factory.name,
          returnPct: round(m.totalReturnPct),
          maxDDPct: round(m.maxDrawdownPct),
          avgExposurePct: round(m.avgExposurePct),
          calmar: round(m.calmar),
          trades: m.trades,
          lossRatePct: round(m.lossRatePct),
          feesPaid: round(m.totalFees),
        });
      }
      if (values.json) emit(rows);
      else {
        process.stdout.write('\nAll strategies over the same history and the same costs:\n\n');
        // eslint-disable-next-line no-console -- table is the point of this command
        console.table(rows);
        process.stdout.write(
          '\nCompare Calmar, not return: a strategy holding 10% average exposure cannot\n' +
          'match a 100%-exposure benchmark on raw return, and should not be asked to.\n' +
          'If buy-and-hold still wins on Calmar, the honest move is to buy and hold.\n',
        );
      }
      return 0;
    }

    case 'portfolio': {
      const universe = (values.symbols as string).split(',').map((s) => s.trim()).filter(Boolean);
      if (universe.length < 2) {
        throw new Error('--symbols needs at least two symbols for a portfolio');
      }
      const loaded = new Map<string, Candle[]>();
      for (const symbol of universe) {
        loaded.set(symbol, await loadCandles({
          csv: undefined,
          synthetic: values.synthetic as boolean,
          symbol,
          exchange: values.exchange as string,
          timeframe,
          bars,
          range,
          // A distinct seed per symbol, so synthetic universes are not ten
          // copies of the same series pretending to be diversified.
          seed: Math.trunc(num(values.seed, 'seed')) + universe.indexOf(symbol),
        }));
      }
      const series = alignCandles(loaded);
      const factory = getPortfolioStrategy(values.strategy === 'donchian-breakout'
        ? 'cross-sectional-momentum'
        : values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const result = runPortfolioBacktest(series, factory.create(series, params), config);
      const bench = runPortfolioBacktest(
        series,
        equalWeight.create(series, equalWeight.defaults),
        benchmarkConfig(config),
      );
      if (values.json) {
        emit({
          metrics: computeMetrics(result),
          benchmark: computeMetrics(bench),
          contribution: result.contribution,
        });
      } else {
        process.stdout.write(`${formatPortfolio(result, bench, alignmentCoverage(loaded, series))}\n`);
      }
      return 0;
    }

    case 'walkforward': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const result = walkForward(candles, factory, {
        ...DEFAULT_WF_OPTIONS,
        folds: Math.trunc(num(values.folds, 'folds')),
        objective: values.objective as Objective,
        config,
      });
      if (values.json) emit(result);
      else process.stdout.write(`${formatWalkForward(result)}\n`);
      return 0;
    }

    case 'montecarlo': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const result = runBacktest(candles, factory.create(candles, params), config);
      if (result.trades.length < 2) {
        process.stderr.write('Not enough trades to resample. Use more history or a faster strategy.\n');
        return 1;
      }
      const mc = monteCarlo(result.trades, config.startingEquity, {
        ...DEFAULT_MC_OPTIONS,
        runs: Math.trunc(num(values.runs, 'runs')),
      });
      if (values.json) emit(mc);
      else process.stdout.write(`${formatMonteCarlo(mc, config.startingEquity)}\n`);
      return 0;
    }

    case 'paper':
    case 'live': {
      const factory = getStrategy(values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const symbol = values.symbol as string;
      const exchange = values.exchange as string;

      const broker = command === 'live'
        ? liveBroker(values.live as boolean, exchange)
        : new PaperBroker({
          startingCash: config.startingEquity,
          costs: config.costs,
          feed: (sym, tf, count) => fetchCandles({
            exchange, symbol: sym, timeframe: tf, bars: count, cacheDir: 'data/cache',
          }),
        });

      const runner = new LiveRunner({
        broker,
        factory,
        params,
        symbol,
        timeframe,
        limits,
        statePath: values.state as string,
        log: (message) => process.stdout.write(`${message}\n`),
      }, config.startingEquity);

      const controller = new AbortController();
      process.on('SIGINT', () => {
        process.stdout.write('\nstopping after the current poll; any open position is left as-is\n');
        controller.abort();
      });
      await runner.run(controller.signal);
      return 0;
    }

    default:
      process.stderr.write(`unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

/** Strips the risk halts so the benchmark measures the asset, not the risk manager. */
function benchmarkConfig(config: BacktestConfig): BacktestConfig {
  return { ...config, limits: BENCHMARK_LIMITS };
}

function liveBroker(liveFlag: boolean, exchange: string): ExchangeBroker {
  if (!liveFlag) {
    throw new Error(
      'the `live` command also needs the --live flag. Two gates, on purpose: this spends real money.',
    );
  }
  return ExchangeBroker.fromEnv(exchange);
}

async function loadCandles(options: {
  csv: string | undefined;
  synthetic: boolean;
  symbol: string;
  exchange: string;
  timeframe: Timeframe;
  bars: number;
  range: DateRange;
  seed: number;
}): Promise<Candle[]> {
  if (options.csv) return clipToRange(await loadCsv(options.csv), options.range);
  if (options.synthetic) {
    const generated = generateCandles({
      bars: options.bars,
      timeframe: options.timeframe,
      seed: options.seed,
      ...(options.range.since === undefined ? {} : { startTime: options.range.since }),
    });
    return clipToRange(generated, options.range);
  }
  const candles = await fetchCandles({
    exchange: options.exchange,
    symbol: options.symbol,
    timeframe: options.timeframe,
    bars: options.bars,
    since: options.range.since,
    until: options.range.until,
    cacheDir: 'data/cache',
  });
  if (candles.length === 0) {
    throw new Error(
      `no candles returned for ${options.symbol} on ${options.exchange} in that range; try a different exchange or a later --since`,
    );
  }
  return candles;
}

function parseParams(entries: readonly string[]): Params {
  const out: Record<string, number> = {};
  for (const entry of entries) {
    const [key, raw] = entry.split('=');
    if (!key || raw === undefined) throw new Error(`--param expects key=value, got "${entry}"`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--param ${key} must be numeric, got "${raw}"`);
    out[key] = value;
  }
  return out;
}

function asTimeframe(value: string): Timeframe {
  if (value in TIMEFRAME_MS) return value as Timeframe;
  throw new Error(`unsupported timeframe "${value}". Use one of ${Object.keys(TIMEFRAME_MS).join(', ')}`);
}

function num(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got "${String(value)}"`);
  return parsed;
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

const isEntry = process.argv[1] !== undefined
  && (process.argv[1].endsWith('cli.ts') || process.argv[1].endsWith('cli.js'));
if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
