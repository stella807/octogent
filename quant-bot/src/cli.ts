import { parseArgs } from 'node:util';
import type { Candle, Timeframe } from './domain/types.ts';
import { TIMEFRAME_MS } from './domain/types.ts';
import { DEFAULT_COSTS } from './backtest/costs.ts';
import { DEFAULT_CONFIG, runBacktest, type BacktestConfig } from './backtest/engine.ts';
import { computeMetrics } from './backtest/metrics.ts';
import { DEFAULT_MC_OPTIONS, monteCarlo } from './backtest/monte-carlo.ts';
import { DEFAULT_WF_OPTIONS, walkForward, type Objective } from './backtest/walk-forward.ts';
import { loadCsv } from './data/csv.ts';
import { fetchCandles, listMarkets } from './data/exchange.ts';
import { mapPool } from './concurrency.ts';
import { buildSwarm, DEFAULT_SWARM, forecastAt } from './swarm/swarm.ts';
import { evaluateSwarm } from './swarm/score.ts';
import { coinFlip, formatBinary, runBinary, type BinaryOptions, type Call } from './backtest/binary.ts';
import { formatScorecard, formatSwarmForecast } from './swarm/format.ts';
import { assembleDashboard, renderDashboardPage, snapshotCoin, type CoinSnapshot } from './dashboard/build.ts';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { barsForRange, clipToRange, parseRange, type DateRange } from './data/range.ts';
import { generateCandles } from './data/synthetic.ts';
import { BENCHMARK_LIMITS, CONSERVATIVE_LIMITS, DEFAULT_LIMITS, type RiskLimits } from './risk/risk-manager.ts';
import { formatBacktest, formatMonteCarlo, formatPortfolio, formatSearch, formatWalkForward } from './report.ts';
import { buyAndHold, getStrategy, STRATEGIES } from './strategy/index.ts';
import type { Params } from './strategy/types.ts';
import { PaperBroker, PRICE_LOOKBACK_MINUTES, readPaperAccount } from './live/paper-broker.ts';
import { StateStore } from './live/state-store.ts';
import { formatLiveStatus, formatPaperStatus, liveBaselinePath, liveStatus, paperAccountPath, paperStatus, type PaperStatus } from './live/status.ts';
import { readLiveBaseline, recordLiveBaseline } from './live/baseline.ts';
import { DEFAULT_SCREEN, failed as failedScreen, screenSymbol, shuffleBars, type ScreenCriteria, type ScreenRow } from './backtest/screen.ts';
import { formatScreen, readScreenFile, screenPath, writeScreenFile } from './screen-file.ts';
import { connectReadOnly, ExchangeBroker, LIVE_CONFIRM_ENV, LIVE_CONFIRM_VALUE, readAccount, type AccountSnapshot } from './live/exchange-broker.ts';
import { LiveRunner } from './live/runner.ts';
import { TelegramNotifier } from './live/notifier.ts';
import {
  botStatePath,
  consensusVerdict,
  demotionReason,
  addValidators,
  botSpec,
  DEFAULT_BOT_EQUITY,
  describeConsensus,
  isControl,
  promotionVerdict,
  shadowStatePath,
  TRIAL_MS,
  type Consensus,
  type Validation,
  type Vote,
  REVALIDATE_MS,
  sameTrade,
  type BotLife,
  type DeadBot,
  expansionProgress,
  formatFleetStatus,
  parseFleet,
  minEquityFor,
  planCoreFleet,
  planExpansion,
  planFleet,
  planReserve,
  rankByDollarVolume,
  type BotFunds,
  type BotSpec,
  type FleetFile,
} from './live/fleet.ts';
import { alignCandles, alignmentCoverage } from './portfolio/align.ts';
import { alignSentiment, fetchSentiment } from './data/sentiment.ts';
import type { StrategyContext } from './strategy/types.ts';
import { runPortfolioBacktest } from './portfolio/engine.ts';
import { equalWeight, getPortfolioStrategy, PORTFOLIO_STRATEGIES } from './portfolio/index.ts';
import { asBacktestResult as blendAsBacktestResult, runBlend } from './backtest/blend.ts';
import { expandFineGrid, range as gridRange, runSearch } from './backtest/search.ts';

const USAGE = `
quant-bot — crypto strategy research and paper trading

  backtest     Run one strategy over history and print the full risk report
  compare      Run every strategy plus buy-and-hold, side by side
  portfolio    Run a multi-asset strategy against an equal-weight benchmark
  blend        Run several strategies at once, each on its own slice of capital
  search       Test thousands of parameter combinations, train vs. held-out test
  walkforward  Pick parameters out-of-sample and report what survived
  montecarlo   Resample trade order to show the real spread of outcomes
  paper        Trade live market data with simulated fills (no real money)
  fleet-init   Plan a paper fleet of 10 bots sharing --budget (default $250), the rest of the 76-bot plan queued; --size full starts all 76
  fleet        Run every bot in the fleet file at once; adds queued bots as realized profits pay for them
  fleet-status Every fleet bot's profit, grouped, next to its coin-flip control
  fleet-add    Add candidates (--strategy on --symbols) as validators; they trade real money only once the fleet deems them worthy
  status       Paper account profit/loss and every open position; --live reads your real exchange account
  screen       Walk-forward test a strategy on every --quote market of an exchange; keep what passes
  swarm        Simulate a crowd of rule-based traders to forecast P(up); --evaluate scores it honestly
  binary       Bet up/down with fixed-payout binary options on past prices; every signal vs a coin flip
  dashboard    Snapshot every screened coin (forecast, track record, screen, paper position) for the dashboard page
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
  --symbols A,B,C        Several symbols: portfolio universe, screen universe, or
                         paper/live on one shared account. "screened" = last screen's passes
  --quote USD            screen: which markets to test when --symbols is not given
  --min-trades 10        screen: out-of-sample trades a pass needs
  --min-efficiency 0.5   screen: walk-forward efficiency a pass needs
  --min-folds 3          screen: walk-forward folds that efficiency must be averaged over
  --control              screen: also screen every market with its days shuffled, to count passes due to luck
  --concurrency 8        screen: markets fetched at once (one shared, rate-limited connection)
  --horizon 1            swarm: bars ahead to forecast
  --paths 500            swarm: simulated futures per forecast (horizon > 1)
  --evaluate             swarm: score every past forecast instead of printing today's
  --expiry 1             binary: bars until a bet settles
  --payout 80            binary: % profit on a winning bet (a loss costs the whole stake)
  --stake-pct 2          binary: % of equity staked per bet
  --out path.html        dashboard: where to write the page (default dashboard/market-eye.html, data beside it as .json)
  --strategies A,B       Strategies to run at once, for the blend command
  --weights 0.5,0.5       Capital split for blend (default: equal)
  --timeframe 1d         1m 5m 15m 1h 4h 1d
  --bars 1500            How much history to use
  --equity 10000         Starting equity in quote currency
  --risk 1               Percent of equity risked per trade
  --max-drawdown 15      Percent drawdown that trips the kill switch
                         (research default is 25; see docs/architecture.md)
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
      symbols: { type: 'string' },
      quote: { type: 'string', default: 'USD' },
      'min-trades': { type: 'string', default: String(DEFAULT_SCREEN.minTrades) },
      'min-efficiency': { type: 'string', default: String(DEFAULT_SCREEN.minEfficiency) },
      'min-folds': { type: 'string', default: String(DEFAULT_SCREEN.minFolds) },
      concurrency: { type: 'string', default: '8' },
      horizon: { type: 'string', default: '1' },
      paths: { type: 'string', default: String(DEFAULT_SWARM.paths) },
      evaluate: { type: 'boolean', default: false },
      expiry: { type: 'string', default: '1' },
      payout: { type: 'string', default: '80' },
      'stake-pct': { type: 'string', default: '2' },
      control: { type: 'boolean', default: false },
      out: { type: 'string' },
      strategies: { type: 'string' },
      weights: { type: 'string' },
      exchange: { type: 'string', default: 'binance' },
      timeframe: { type: 'string', default: '1d' },
      bars: { type: 'string', default: '1500' },
      equity: { type: 'string', default: '10000' },
      risk: { type: 'string', default: String(DEFAULT_LIMITS.riskPerTradePct) },
      'max-drawdown': { type: 'string', default: String(CONSERVATIVE_LIMITS.maxDrawdownPct) },
      'max-daily-loss': { type: 'string', default: String(DEFAULT_LIMITS.maxDailyLossPct) },
      'max-position': { type: 'string', default: String(DEFAULT_LIMITS.maxPositionPct) },
      'fee-bps': { type: 'string', default: String(DEFAULT_COSTS.feeBps) },
      'slippage-bps': { type: 'string', default: String(DEFAULT_COSTS.slippageBps) },
      'min-order': { type: 'string', default: String(DEFAULT_COSTS.minOrderNotional) },
      folds: { type: 'string', default: String(DEFAULT_WF_OPTIONS.folds) },
      objective: { type: 'string', default: DEFAULT_WF_OPTIONS.objective },
      runs: { type: 'string', default: String(DEFAULT_MC_OPTIONS.runs) },
      candidates: { type: 'string', default: '10000' },
      csv: { type: 'string' },
      since: { type: 'string' },
      until: { type: 'string' },
      synthetic: { type: 'boolean', default: false },
      seed: { type: 'string', default: '42' },
      param: { type: 'string', multiple: true, default: [] },
      live: { type: 'boolean', default: false },
      state: { type: 'string' },
      json: { type: 'boolean', default: false },
      fleet: { type: 'string', default: '.quant-bot/fleet/fleet.json' },
      size: { type: 'string', default: 'core' },
      budget: { type: 'string', default: '250' },
      group: { type: 'string', default: 'added' },
    },
  });

  const statePath = (values.state as string | undefined) ?? defaultStatePath(command, values.live as boolean);
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
      const context = await loadContext(factory.name, candles);
      const result = runBacktest(candles, factory.create(candles, params, context), config);
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
        const context = await loadContext(factory.name, candles);
        const result = runBacktest(candles, factory.create(candles, factory.defaults, context), runConfig);
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
      const universe = splitSymbols(values.symbols as string | undefined ?? DEFAULT_PORTFOLIO_UNIVERSE);
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

    case 'blend': {
      const names = (values.strategies as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean);
      if (!names || names.length < 2) {
        throw new Error('blend needs --strategies A,B (at least two, comma separated)');
      }
      const weightStrs = (values.weights as string | undefined)?.split(',').map((s) => s.trim());
      const weights = weightStrs
        ? weightStrs.map((w) => num(w, 'weights'))
        : names.map(() => 1 / names.length);
      if (weights.length !== names.length) {
        throw new Error(`--weights has ${weights.length} entries but --strategies has ${names.length}`);
      }

      const candles = await loadData();
      const members = await Promise.all(names.map(async (name, idx) => {
        const factory = getStrategy(name);
        const context = await loadContext(factory.name, candles);
        return { factory, params: factory.defaults, weight: weights[idx] as number, context };
      }));

      const result = runBlend(candles, members, config);
      const bench = runBacktest(candles, buyAndHold.create(candles, {}), benchmarkConfig(config));

      if (values.json) {
        emit({
          metrics: computeMetrics(blendAsBacktestResult(result)),
          benchmark: computeMetrics(bench),
          members: Object.fromEntries(
            [...result.members].map(([name, r]) => [name, computeMetrics(r)]),
          ),
        });
      } else {
        const combined = computeMetrics(blendAsBacktestResult(result));
        process.stdout.write(formatBacktest(blendAsBacktestResult(result), bench));
        process.stdout.write('\n\nPER-STRATEGY (run alone, at its allocated capital)\n');
        for (const [name, r] of result.members) {
          const m = computeMetrics(r);
          process.stdout.write(
            `  ${name.padEnd(22)} return ${m.totalReturnPct.toFixed(2).padStart(8)}%  maxDD ${m.maxDrawdownPct.toFixed(2).padStart(6)}%  calmar ${m.calmar.toFixed(2)}\n`,
          );
        }
        process.stdout.write(
          `\n  Combined: return ${combined.totalReturnPct.toFixed(2)}%  maxDD ${combined.maxDrawdownPct.toFixed(2)}%  calmar ${combined.calmar.toFixed(2)}\n`,
        );
        process.stdout.write(
          combined.calmar > Math.max(...[...result.members.values()].map((r) => computeMetrics(r).calmar))
            ? '\n  Combined Calmar beats every strategy run alone: the blend reduced risk without giving up return.\n'
            : '\n  Combined Calmar does NOT beat the best strategy run alone: blending added no value here.\n',
        );
      }
      return 0;
    }

    case 'search': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const fineGrid = FINE_GRIDS[factory.name];
      if (!fineGrid) {
        throw new Error(
          `search has no fine-grained grid defined for "${factory.name}". Available: ${Object.keys(FINE_GRIDS).join(', ')}`,
        );
      }
      const allCandidates = expandFineGrid(fineGrid);
      const result = runSearch(candles, factory, allCandidates, {
        trainRatio: 0.6,
        config,
        maxCandidates: Math.trunc(num(values.candidates, 'candidates')),
      });
      if (values.json) {
        emit(result);
      } else {
        process.stdout.write(formatSearch(result, allCandidates.length));
      }
      return 0;
    }

    case 'walkforward': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const context = await loadContext(factory.name, candles);
      const result = walkForward(candles, factory, {
        ...DEFAULT_WF_OPTIONS,
        folds: Math.trunc(num(values.folds, 'folds')),
        objective: values.objective as Objective,
        config,
        ...(context?.sentiment ? { sentiment: context.sentiment } : {}),
      });
      if (values.json) emit(result);
      else process.stdout.write(`${formatWalkForward(result)}\n`);
      return 0;
    }

    case 'montecarlo': {
      const candles = await loadData();
      const factory = getStrategy(values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const context = await loadContext(factory.name, candles);
      const result = runBacktest(candles, factory.create(candles, params, context), config);
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

    case 'status': {
      if (values.live) {
        const quote = values.quote as string;
        const snapshot = await readAccount(await connectReadOnly(values.exchange as string), quote);
        const summary = liveStatus(
          snapshot.balances,
          snapshot.prices,
          quote,
          await new StateStore(statePath).load(),
          await readLiveBaseline(liveBaselinePath(statePath)),
        );
        if (values.json) emit(summary);
        else process.stdout.write(`${formatLiveStatus(summary)}\n`);
        return 0;
      }
      const summary = await loadPaperStatus(statePath, values.exchange as string);
      if (!summary) {
        process.stderr.write(`No paper account at ${paperAccountPath(statePath)}. Start one with the \`paper\` command.\n`);
        return 1;
      }
      if (values.json) emit(summary);
      else process.stdout.write(`${formatPaperStatus(summary)}\n`);
      return 0;
    }

    case 'swarm': {
      const candles = await loadData();
      const horizon = Math.trunc(num(values.horizon, 'horizon'));
      const swarmConfig = { ...DEFAULT_SWARM, paths: Math.trunc(num(values.paths, 'paths')) };
      const symbol = values.synthetic ? 'synthetic' : values.symbol as string;
      if (values.evaluate) {
        const { card } = evaluateSwarm(candles, { horizon, config: swarmConfig });
        if (values.json) emit(card);
        else process.stdout.write(`${formatScorecard(card, symbol, timeframe, horizon)}\n`);
        return 0;
      }
      const state = buildSwarm(candles, swarmConfig);
      const last = candles.length - 1;
      const forecast = forecastAt(state, last, horizon);
      if (values.json) emit(forecast);
      else process.stdout.write(`${formatSwarmForecast(forecast, symbol, timeframe, (candles[last] as Candle).close)}\n`);
      return 0;
    }

    case 'binary': {
      const candles = await loadData();
      const options: BinaryOptions = {
        expiryBars: Math.trunc(num(values.expiry, 'expiry')),
        payout: num(values.payout, 'payout') / 100,
        stakePct: num(values['stake-pct'], 'stake-pct') / 100,
        minStake: config.costs.minOrderNotional,
        startingEquity: config.startingEquity,
      };
      const factory = getStrategy(values.strategy as string);
      const strategy = factory.create(candles, { ...factory.defaults, ...overrides });
      const swarm = buildSwarm(candles, { ...DEFAULT_SWARM, paths: Math.trunc(num(values.paths, 'paths')) });
      const signals: { label: string; predict: (t: number) => Call | null }[] = [
        {
          label: 'swarm',
          predict: (t) => {
            if (t < swarm.warmup) return null;
            const p = forecastAt(swarm, t, options.expiryBars).pUp;
            return p > 0.5 ? 'up' : p < 0.5 ? 'down' : null;
          },
        },
        // Strategies here are long-only, so "flat" means no bet rather than a down call.
        { label: factory.name, predict: (t) => (strategy.signalAt(t, null).target > 0 ? 'up' : null) },
        { label: 'always up', predict: () => 'up' },
        { label: 'coin flip', predict: coinFlip(Math.trunc(num(values.seed, 'seed'))) },
      ];
      const rows = signals.map(({ label, predict }) => ({ label, result: runBinary(candles, predict, options) }));
      if (values.json) emit(rows.map(({ label, result }) => ({ label, ...result, bets: result.bets.length })));
      else process.stdout.write(`${formatBinary(rows, options, values.synthetic ? 'synthetic' : values.symbol as string, timeframe)}\n`);
      return 0;
    }

    case 'dashboard': {
      const exchange = values.exchange as string;
      const screen = await readScreenFile(screenPath(statePath));
      const universe = values.symbols
        ? splitSymbols(values.symbols as string)
        : screen?.rows.map((r) => r.symbol) ?? await listMarkets(exchange, values.quote as string);
      const screenBySymbol = new Map((screen?.rows ?? []).map((r) => [r.symbol, r]));
      const paper = await loadPaperStatus(statePath, exchange);
      let done = 0;
      const snapshots = await mapPool(universe, Math.trunc(num(values.concurrency, 'concurrency')), async (symbol) => {
        let snap: CoinSnapshot | null = null;
        try {
          const candles = await fetchCandles({ exchange, symbol, timeframe: '1d', bars, cacheDir: 'data/cache' });
          snap = snapshotCoin(symbol, candles, screenBySymbol.get(symbol), paper);
        } catch {
          // A market that won't load is left off the board rather than shown with invented numbers.
        }
        done += 1;
        process.stderr.write(`[${done}/${universe.length}] ${symbol}\n`);
        return snap;
      });
      const dashboard = assembleDashboard({
        generatedAt: new Date(),
        exchange,
        strategy: screen?.strategy ?? (values.strategy as string),
        coins: snapshots.filter((c): c is CoinSnapshot => c !== null),
        screenRows: screen?.rows ?? [],
        luck: screen?.luck ?? null,
        paper,
      });
      const out = (values.out as string | undefined) ?? 'dashboard/market-eye.html';
      const template = await readFile(new URL('./dashboard/template.html', import.meta.url), 'utf8');
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, renderDashboardPage(template, dashboard, true), 'utf8');
      await writeFile(out.replace(/\.html$/, '') + '.json', JSON.stringify(dashboard), 'utf8');
      process.stdout.write(
        `Wrote ${out}: ${dashboard.coins.length} coins, ${dashboard.summary.forecastable} with a swarm track record, ` +
        `${dashboard.summary.skilled} showing skill (${dashboard.summary.skilledByChance} expected by chance).\n`,
      );
      return 0;
    }

    case 'screen': {
      const factory = getStrategy(values.strategy as string);
      const exchange = values.exchange as string;
      const universe = values.symbols
        ? splitSymbols(values.symbols as string)
        : await listMarkets(exchange, values.quote as string);
      const criteria: ScreenCriteria = {
        minEfficiency: num(values['min-efficiency'], 'min-efficiency'),
        minTrades: Math.trunc(num(values['min-trades'], 'min-trades')),
        minFolds: Math.trunc(num(values['min-folds'], 'min-folds')),
      };
      const wfOptions = {
        ...DEFAULT_WF_OPTIONS,
        folds: Math.trunc(num(values.folds, 'folds')),
        objective: values.objective as Objective,
        config,
      };
      let done = 0;
      const started = Date.now();
      const control = values.control as boolean;
      const results = await mapPool(
        universe,
        Math.trunc(num(values.concurrency, 'concurrency')),
        async (symbol, i): Promise<{ row: ScreenRow; shuffled: ScreenRow | null }> => {
          let row: ScreenRow;
          let shuffled: ScreenRow | null = null;
          try {
            const candles = await loadCandles({
              csv: undefined, synthetic: values.synthetic as boolean, symbol, exchange, timeframe, bars, range,
              seed: Math.trunc(num(values.seed, 'seed')) + i,
            });
            row = screenSymbol(symbol, candles, factory, wfOptions, criteria);
            if (control) shuffled = screenSymbol(symbol, shuffleBars(candles, i + 1), factory, wfOptions, criteria);
          } catch (error) {
            row = failedScreen(symbol, 0, `no data: ${error instanceof Error ? error.message : String(error)}`);
          }
          done += 1;
          process.stderr.write(`[${done}/${universe.length}] ${symbol} (${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
          return { row, shuffled };
        },
      );
      const rows = results.map((r) => r.row);
      const controlRows = results.flatMap((r) => (r.shuffled ? [r.shuffled] : []));
      const luck = control
        // Same denominator as the real screen: markets with enough data to test.
        ? {
          tested: controlRows.filter((r) => r.efficiency !== null || r.oosTrades > 0).length,
          passed: controlRows.filter((r) => r.passed).length,
        }
        : undefined;
      const passed = rows.filter((r) => r.passed).map((r) => r.symbol);
      await writeScreenFile(screenPath(statePath), {
        exchange, strategy: factory.name, timeframe, screenedAt: new Date().toISOString(), symbols: passed, rows,
        ...(luck ? { luck } : {}),
      });
      if (values.json) emit({ rows, luck });
      else process.stdout.write(`${formatScreen(rows, factory.name, exchange, luck)}\n`);
      return 0;
    }

    case 'fleet-init': {
      const path = values.fleet as string;
      if (await exists(path)) {
        throw new Error(`${path} already exists. Delete it to re-plan; each bot's account lives in its own folder and is kept.`);
      }
      const exchange = values.exchange as string;
      if (values.size !== 'full' && values.size !== 'core') {
        throw new Error(`--size must be core or full, got "${String(values.size)}"`);
      }
      // The budget is split evenly across the ten starting bots; bots added later cost the same.
      const perBot = Number((num(values.budget, 'budget') / 10).toFixed(2));
      if (perBot < minEquityFor({ strategy: 'buy-and-hold', timeframe: '1d' })) {
        throw new Error(`a $${String(values.budget)} budget gives each of 10 bots $${perBot}, under the exchange's $1 minimum order`);
      }
      const top = await rankTopCoins(exchange, values.quote as string, Math.trunc(num(values.concurrency, 'concurrency')));
      const full = planFleet(top, perBot);
      const bots = values.size === 'full' ? full.filter((b) => minEquityFor(b) <= b.equity) : planCoreFleet(perBot);
      const fleet: FleetFile = {
        exchange,
        createdAt: new Date().toISOString(),
        budget: bots.reduce((sum, b) => sum + b.equity, 0),
        bots,
        reserve: planReserve(full, bots),
        added: [],
      };
      await writeFleet(path, fleet);
      process.stdout.write(
        `Wrote ${path}: ${bots.length} bots running, ${fleet.reserve?.length ?? 0} more queued to add ` +
        `as profits pay for them. Most-traded coins: ${top.join(', ')}\n`,
      );
      return 0;
    }

    case 'fleet': {
      const fleetPath = values.fleet as string;
      const fleetDir = dirname(fleetPath);
      const initial = parseFleet(await readFile(fleetPath, 'utf8'));
      const exchange = initial.exchange;
      const controller = new AbortController();
      /** Running bots by name: traders on real (paper) money, validators on validator money. */
      const live = new Map<string, { broker: PaperBroker; stop: AbortController; run: Promise<void>; role: 'trader' | 'validator' }>();
      const runs: Promise<void>[] = [];
      const start = (spec: BotSpec, role: 'trader' | 'validator', statePath: string): void => {
        const factory = getStrategy(spec.strategy);
        const broker = new PaperBroker({
          startingCash: spec.equity,
          costs: { ...config.costs, feeBps: spec.feeBps },
          accountPath: paperAccountPath(statePath),
          feed: (sym, tf, count) => fetchCandles({
            exchange, symbol: sym, timeframe: tf, bars: count, cacheDir: 'data/cache', noCache: true,
          }),
        });
        const tag = role === 'validator' ? `${spec.name} (validator)` : spec.name;
        // No notifier: one message per fill across dozens of bots would bury anything that mattered.
        const runner = new LiveRunner({
          broker,
          factory,
          params: { ...factory.defaults, ...spec.params },
          symbols: spec.symbols,
          timeframe: spec.timeframe,
          limits: { ...limits, maxDrawdownPct: spec.maxDrawdownPct },
          statePath,
          log: (message) => process.stdout.write(`[${tag}] ${message}\n`),
        }, spec.equity);
        const stop = new AbortController();
        controller.signal.addEventListener('abort', () => stop.abort());
        const run = runner.run(stop.signal);
        live.set(spec.name, { broker, stop, run, role });
        runs.push(run);
      };
      const tradingPath = (fleet: FleetFile, name: string): string =>
        botStatePath(fleetDir, name, fleet.life?.[name]?.generation ?? 1);
      const validatorPath = (fleet: FleetFile, name: string): string =>
        shadowStatePath(fleetDir, name, fleet.life?.[name]?.shadowRound ?? 1);
      for (const spec of initial.bots) start(spec, 'trader', tradingPath(initial, spec.name));
      for (const spec of initial.validators ?? []) start(spec, 'validator', validatorPath(initial, spec.name));

      const candlesFor = (spec: BotSpec, symbol: string): Promise<Candle[]> => fetchCandles({
        exchange, symbol, timeframe: spec.timeframe, bars: spec.timeframe === '1d' ? 3000 : 10_000, cacheDir: 'data/cache',
      });
      /** Walk-forward on one market, and on the same market shuffled: skill has to show on the first and not the second. */
      const test = async (spec: BotSpec, symbol: string): Promise<Validation | null> => {
        try {
          const candles = await candlesFor(spec, symbol);
          const wfConfig: BacktestConfig = {
            ...config,
            startingEquity: spec.equity,
            timeframe: spec.timeframe,
            costs: { ...config.costs, feeBps: spec.feeBps },
            limits: { ...limits, maxDrawdownPct: spec.maxDrawdownPct },
          };
          const factory = getStrategy(spec.strategy);
          const options = { ...DEFAULT_WF_OPTIONS, config: wfConfig };
          const real = screenSymbol(symbol, candles, factory, options);
          const luck = screenSymbol(symbol, shuffleBars(candles, 1), factory, options);
          return { passed: real.passed, luckPassed: luck.passed, reason: real.reason };
        } catch {
          // No verdict this round: a data outage is not evidence against a strategy.
          return null;
        }
      };

      /** Stops a trader, sells what it holds, and hands its cash back. Returns the cash. */
      const retire = async (spec: BotSpec): Promise<number> => {
        const bot = live.get(spec.name);
        if (!bot) return 0;
        bot.stop.abort();
        await bot.run;
        live.delete(spec.name);
        if (bot.role !== 'trader') return 0;
        for (const symbol of spec.symbols) {
          const { qty } = await bot.broker.balance(symbol);
          if (qty <= 0) continue;
          try {
            await bot.broker.marketSell(symbol, qty);
          } catch (error) {
            // Under the $1 minimum it cannot be sold; it stays in the account, recorded as held.
            process.stdout.write(`[fleet] ${spec.name} could not sell ${symbol}: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        const { cash } = await bot.broker.balance(spec.symbols[0] as string);
        return bot.broker.withdraw(cash);
      };

      // Keep the good ones, not the lucky ones. Once an hour: validate every
      // bot on its own market (and against its shuffled market), let every
      // bot's market vote on every strategy, demote traders that fail or do
      // not make money, and promote validators the fleet deems worthy.
      const lifecycle = async (): Promise<void> => {
        let fleet = parseFleet(await readFile(fleetPath, 'utf8'));
        const nowMs = Date.now();
        const now = new Date(nowMs).toISOString();
        const life: Record<string, BotLife> = { ...fleet.life };
        const fresh = (at: string | undefined): boolean => at !== undefined && nowMs - Date.parse(at) < REVALIDATE_MS;
        // Validators added from outside (fleet-add) start trading validator money here.
        for (const spec of fleet.validators ?? []) {
          if (live.has(spec.name)) continue;
          life[spec.name] ??= { bornAt: now, shadowRound: 1 };
          start(spec, 'validator', shadowStatePath(fleetDir, spec.name, life[spec.name]?.shadowRound ?? 1));
          process.stdout.write(`[fleet] ${spec.name} joins the validators\n`);
        }
        const budget = fleet.budget ?? fleet.bots
          .filter((b) => !(fleet.added ?? []).some((a) => a.name === b.name))
          .reduce((sum, b) => sum + b.equity, 0);

        // 1. Each contestant's own market, re-tested daily.
        const validationOf = async (spec: BotSpec): Promise<Validation | null> => {
          const current = life[spec.name];
          if (current?.validatedAt && fresh(current.validatedAt) && current.validPassed !== undefined) {
            return { passed: current.validPassed, luckPassed: current.luckPassed ?? false, reason: current.validation ?? '' };
          }
          const v = await test(spec, spec.symbols[0] as string);
          if (v) {
            life[spec.name] = {
              ...(current ?? { bornAt: now }),
              validatedAt: now, validation: v.reason, validPassed: v.passed, luckPassed: v.luckPassed,
            };
          }
          return v;
        };

        // 2. The fleet's consensus per strategy: every member's market votes, once a day.
        const consensus: Record<string, Consensus & { at: string }> = { ...fleet.consensus };
        const consensusOf = async (spec: BotSpec): Promise<Consensus | null> => {
          const key = `${spec.strategy}@${spec.timeframe}`;
          const cached = consensus[key];
          if (cached && fresh(cached.at)) return cached;
          const members = [...fleet.bots, ...(fleet.validators ?? [])].filter((b) => b.timeframe === spec.timeframe);
          const markets = [...new Set(members.flatMap((b) => b.symbols))];
          const votes: Vote[] = [];
          for (const market of markets) {
            const v = await test(spec, market);
            if (v) votes.push({ market, passed: v.passed, luckPassed: v.luckPassed });
          }
          if (votes.length === 0) return null;
          const verdict = { ...consensusVerdict(votes), at: now };
          consensus[key] = verdict;
          process.stdout.write(`[fleet] consensus on ${key}: ${verdict.approved ? 'worthy' : 'not worthy'}, ${describeConsensus(verdict)}\n`);
          return verdict;
        };

        // 3. Demote traders that fail, were lucky, lost consensus, or are not making money.
        const prices = priceCache(exchange);
        const statuses = new Map<string, PaperStatus>();
        for (const spec of fleet.bots) {
          const status = await loadPaperStatus(tradingPath(fleet, spec.name), exchange, prices);
          if (status) statuses.set(spec.name, status);
        }
        const coinFlip = (timeframe: string): number | null => {
          const control = fleet.bots.find((b) => b.strategy === 'coin-flip' && b.timeframe === timeframe);
          return control ? statuses.get(control.name)?.pnlPct ?? null : null;
        };
        let treasury = fleet.treasury ?? 0;
        const demoted: DeadBot[] = [];
        const toValidators: BotSpec[] = [];
        for (const spec of fleet.bots) {
          const status = statuses.get(spec.name);
          if (!status || isControl(spec.strategy)) continue;
          (life[spec.name] ??= { bornAt: now });
          const reason = demotionReason({
            spec,
            status,
            ageMs: nowMs - Date.parse(life[spec.name]?.bornAt ?? now),
            validation: await validationOf(spec),
          }, coinFlip(spec.timeframe), await consensusOf(spec));
          if (!reason) continue;
          const returned = await retire(spec);
          treasury += returned;
          const round = (life[spec.name]?.shadowRound ?? 0) + 1;
          life[spec.name] = { ...(life[spec.name] as BotLife), demotedAt: now, shadowRound: round };
          demoted.push({ name: spec.name, at: now, reason, returned });
          toValidators.push(spec);
          process.stdout.write(`[fleet] ${spec.name} demoted to validator: ${reason}. Returned $${returned.toFixed(2)} to the treasury\n`);
        }
        const demotedNames = new Set(demoted.map((d) => d.name));
        fleet = {
          ...fleet,
          budget,
          treasury,
          life,
          consensus,
          bots: fleet.bots.filter((b) => !demotedNames.has(b.name)),
          validators: [...(fleet.validators ?? []), ...toValidators],
          dead: [...(fleet.dead ?? []), ...demoted],
        };
        for (const spec of toValidators) start(spec, 'validator', validatorPath(fleet, spec.name));
        await writeFleet(fleetPath, fleet);

        // 4. Promotions, while there is money for them: validators first (a
        //    proven validator record is the strongest evidence here), then
        //    queued candidates. Candidates that are not worthy become
        //    validators instead of being thrown away.
        const fund = async (cost: number): Promise<{ paidBy: string; fundedBy: Record<string, number> | null } | null> => {
          if ((fleet.treasury ?? 0) >= cost) {
            fleet = { ...fleet, treasury: Number(((fleet.treasury ?? 0) - cost).toFixed(8)) };
            return { paidBy: 'the treasury', fundedBy: null };
          }
          const funds = await fleetFunds(fleet, fleetDir, prices, (name) => tradingPath(fleet, name));
          const value = funds.reduce((sum, f) => sum + f.equity, 0) + (fleet.treasury ?? 0);
          const plan = planExpansion(funds, { principal: budget, added: (fleet.added ?? []).length, cost, value });
          if (!plan) return null;
          const fundedBy: Record<string, number> = {};
          for (const [name, amount] of Object.entries(plan)) {
            const donor = live.get(name);
            if (donor?.role === 'trader') fundedBy[name] = await donor.broker.withdraw(amount);
          }
          return { paidBy: Object.entries(fundedBy).map(([n, a]) => `${n} $${a.toFixed(2)}`).join(', '), fundedBy };
        };
        const canAfford = async (cost: number): Promise<boolean> => {
          if ((fleet.treasury ?? 0) >= cost) return true;
          const funds = await fleetFunds(fleet, fleetDir, prices, (name) => tradingPath(fleet, name));
          const value = funds.reduce((sum, f) => sum + f.equity, 0) + (fleet.treasury ?? 0);
          return planExpansion(funds, { principal: budget, added: (fleet.added ?? []).length, cost, value }) !== null;
        };
        const promote = async (spec: BotSpec, reason: string, fromValidators: boolean): Promise<boolean> => {
          const paid = await fund(spec.equity);
          if (!paid) return false;
          if (fromValidators) await retire(spec);
          const generation = (fleet.life?.[spec.name]?.generation ?? (fromValidators && fleet.life?.[spec.name]?.demotedAt ? 1 : 0)) + 1;
          const { demotedAt: _dropped, ...rest } = fleet.life?.[spec.name] ?? { bornAt: now };
          fleet = {
            ...fleet,
            bots: [...fleet.bots, spec],
            validators: (fleet.validators ?? []).filter((v) => v.name !== spec.name),
            reserve: (fleet.reserve ?? []).filter((b) => b.name !== spec.name),
            added: paid.fundedBy ? [...(fleet.added ?? []), { name: spec.name, at: now, fundedBy: paid.fundedBy }] : fleet.added ?? [],
            life: { ...fleet.life, [spec.name]: { ...rest, bornAt: now, generation } },
          };
          await writeFleet(fleetPath, fleet);
          process.stdout.write(`[fleet] ${spec.name} promoted to trader (${reason}), paid for by ${paid.paidBy}\n`);
          start(spec, 'trader', tradingPath(fleet, spec.name));
          return true;
        };

        const validatorsByRecord: { spec: BotSpec; pnl: number }[] = [];
        for (const spec of fleet.validators ?? []) {
          const shadow = await loadPaperStatus(validatorPath(fleet, spec.name), exchange, prices);
          validatorsByRecord.push({ spec, pnl: shadow?.pnl ?? 0 });
        }
        validatorsByRecord.sort((a, b) => b.pnl - a.pnl);
        for (const { spec } of validatorsByRecord) {
          if (fleet.bots.some((b) => sameTrade(b, spec))) continue;
          if (!(await canAfford(spec.equity))) break;
          const lifeNow = life[spec.name];
          const shadow = await loadPaperStatus(validatorPath(fleet, spec.name), exchange, prices);
          const verdict = promotionVerdict({
            validation: await validationOf(spec),
            consensus: await consensusOf(spec),
            demoted: lifeNow?.demotedAt !== undefined,
            shadow: shadow && lifeNow?.demotedAt ? { pnl: shadow.pnl, ageMs: nowMs - Date.parse(lifeNow.demotedAt) } : null,
            trialMs: TRIAL_MS[spec.timeframe] ?? (TRIAL_MS['1d'] as number),
          });
          if (verdict.promote) await promote(spec, verdict.reason, true);
        }
        for (;;) {
          const next = (fleet.reserve ?? []).find((b) => !isControl(b.strategy)
            && ![...fleet.bots, ...(fleet.validators ?? [])].some((r) => sameTrade(r, b)));
          if (!next || !(await canAfford(next.equity))) break;
          const verdict = promotionVerdict({
            validation: await validationOf(next),
            consensus: await consensusOf(next),
            demoted: false,
            shadow: null,
          });
          if (verdict.promote) {
            if (!(await promote(next, verdict.reason, false))) break;
            continue;
          }
          // Not worthy yet: it joins the validators, votes with its market, and can be promoted later.
          life[next.name] = { ...(life[next.name] ?? { bornAt: now }), shadowRound: 1 };
          fleet = {
            ...fleet,
            life: { ...fleet.life, ...life },
            reserve: (fleet.reserve ?? []).filter((b) => b.name !== next.name),
            validators: [...(fleet.validators ?? []), next],
          };
          await writeFleet(fleetPath, fleet);
          process.stdout.write(`[fleet] ${next.name} joins the validators: ${verdict.reason}\n`);
          start(next, 'validator', validatorPath(fleet, next.name));
        }
        await writeFleet(fleetPath, { ...fleet, life: { ...life, ...fleet.life }, consensus });
      };
      const tick = (): void => {
        lifecycle().catch((error: unknown) => {
          process.stdout.write(`[fleet] lifecycle check failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      };
      const timer = setInterval(tick, LIFECYCLE_CHECK_MS);
      setTimeout(tick, 60_000);

      process.on('SIGINT', () => {
        process.stdout.write('\nstopping every bot after its current poll; open positions are left as-is\n');
        clearInterval(timer);
        controller.abort();
      });
      process.stdout.write(
        `fleet: ${initial.bots.length} traders and ${initial.validators?.length ?? 0} validators on ${exchange} ` +
        `(paper, no real money), ${initial.reserve?.length ?? 0} queued. Traders must stay validated, keep the ` +
        `fleet's consensus and make money; validators trade again once the fleet deems them worthy.\n`,
      );
      // One process, one shared rate-limited exchange connection: dozens of
      // separate processes would each open their own and trip the exchange's limits.
      await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve()));
      await Promise.all(runs);
      return 0;
    }

    case 'fleet-add': {
      const fleetPath = values.fleet as string;
      const fleet = parseFleet(await readFile(fleetPath, 'utf8'));
      if (!values.symbols) throw new Error('fleet-add needs --symbols, e.g. --symbols PEPE/USD,BONK/USD');
      const factory = getStrategy(values.strategy as string);
      const group = values.group as string;
      const prefix = group.toLowerCase().split(/\s+/)[0]?.replace(/[^a-z0-9]/g, '') || 'added';
      const equity = fleet.bots[0]?.equity ?? DEFAULT_BOT_EQUITY;
      const candidates = splitSymbols(values.symbols as string)
        .map((symbol) => botSpec(group, prefix, factory.name, symbol, timeframe, equity));
      const next = addValidators(fleet, candidates);
      await writeFleet(fleetPath, next);
      const added = (next.validators ?? []).length - (fleet.validators ?? []).length;
      process.stdout.write(
        `Added ${added} of ${candidates.length} as validators (the rest are already in the fleet). A running fleet ` +
        `starts them within the hour; they trade validator money until the fleet deems them worthy.\n`,
      );
      return 0;
    }

    case 'fleet-status': {
      const fleetPath = values.fleet as string;
      const fleetDir = dirname(fleetPath);
      const fleet = parseFleet(await readFile(fleetPath, 'utf8'));
      const prices = priceCache(fleet.exchange);
      const rows = await mapPool(fleet.bots, 4, async (spec) => ({
        spec,
        status: await loadPaperStatus(botStatePath(fleetDir, spec.name, fleet.life?.[spec.name]?.generation ?? 1), fleet.exchange, prices),
      }));
      const validators = await mapPool(fleet.validators ?? [], 4, async (spec) => {
        const life = fleet.life?.[spec.name];
        return {
          spec,
          shadow: await loadPaperStatus(shadowStatePath(fleetDir, spec.name, life?.shadowRound ?? 1), fleet.exchange, prices),
          demoted: life?.demotedAt !== undefined,
          // A demoted bot shows why it lost its money; a candidate shows its latest test.
          note: (life?.demotedAt !== undefined
            ? [...(fleet.dead ?? [])].reverse().find((d) => d.name === spec.name)?.reason
            : undefined) ?? life?.validation ?? 'waiting for its first validation',
        };
      });
      const added = new Set((fleet.added ?? []).map((a) => a.name));
      const principal = fleet.budget
        ?? rows.filter((r) => !added.has(r.spec.name)).reduce((sum, r) => sum + (r.status?.startingCash ?? r.spec.equity), 0);
      const treasury = fleet.treasury ?? 0;
      const fleetEquity = rows.reduce((sum, r) => sum + (r.status?.equity ?? r.spec.equity), 0) + treasury;
      const expansion = {
        added: added.size,
        queued: fleet.reserve?.length ?? 0,
        ...expansionProgress({
          principal,
          fleetEquity,
          added: added.size,
          cost: fleet.reserve?.[0]?.equity ?? fleet.bots[0]?.equity ?? 0,
        }),
        treasury,
        dead: fleet.dead ?? [],
        rejected: fleet.rejected?.length ?? 0,
        validators,
        consensus: fleet.consensus ?? {},
      };
      if (values.json) emit({ rows, expansion });
      else process.stdout.write(`${formatFleetStatus(rows, expansion)}\n`);
      return 0;
    }

    case 'paper':
    case 'live': {
      const factory = getStrategy(values.strategy as string);
      const params = { ...factory.defaults, ...overrides };
      const exchange = values.exchange as string;
      const symbols = await resolveTradeSymbols(values, factory.name, exchange, statePath);

      const live = command === 'live' ? liveBroker(values.live as boolean, exchange) : null;
      const broker = live ?? new PaperBroker({
          startingCash: config.startingEquity,
          costs: config.costs,
          accountPath: paperAccountPath(statePath),
          feed: (sym, tf, count) => fetchCandles({
            exchange, symbol: sym, timeframe: tf, bars: count, cacheDir: 'data/cache', noCache: true,
          }),
        });

      // Live risk limits are measured from the real balance, not --equity: a
      // $25 account started with the $10,000 default would read as a 99.75%
      // drawdown and trip the kill switch on its first bar.
      let startingEquity = config.startingEquity;
      if (live) {
        const quote = quoteOf(symbols);
        const snapshot = await live.account(quote);
        startingEquity = tradedEquity(snapshot, symbols, quote);
        if (!(startingEquity > 0)) throw new Error(`the ${exchange} account holds no ${quote} to trade with`);
        const baseline = await recordLiveBaseline(liveBaselinePath(statePath), accountEquity(snapshot), quote);
        process.stdout.write(
          `real account: ${money(startingEquity)} ${quote} available to the bot; ` +
          `profit is measured from ${money(baseline.startingEquity)} (${baseline.startedAt.slice(0, 10)})\n`,
        );
      }

      const runner = new LiveRunner({
        broker,
        factory,
        params,
        symbols,
        timeframe,
        limits,
        statePath,
        log: (message) => process.stdout.write(`${message}\n`),
        notifier: TelegramNotifier.fromEnv(),
      }, startingEquity);

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

/**
 * Live trading keeps its own state file. Sharing the paper one would hand the
 * live bot a paper position's entry and stop, and a paper kill switch.
 */
export function defaultStatePath(command: string, live: boolean): string {
  return command === 'live' || (command === 'status' && live)
    ? '.quant-bot/live-state.json'
    : '.quant-bot/runner-state.json';
}

function quoteOf(symbols: readonly string[]): string {
  const quotes = new Set(symbols.map((s) => s.split('/')[1] ?? ''));
  const [quote] = quotes;
  // The runner shares one cash balance across symbols, so they must share its currency.
  if (quotes.size !== 1 || !quote) throw new Error(`live symbols must share one quote currency: ${symbols.join(', ')}`);
  return quote;
}

/** Cash plus the coins the bot trades: the same equity the runner's risk checks see. */
function tradedEquity(snapshot: AccountSnapshot, symbols: readonly string[], quote: string): number {
  const bases = new Set(symbols.map((s) => s.split('/')[0] ?? ''));
  return accountEquity(snapshot, (asset) => asset === quote || bases.has(asset));
}

function accountEquity(snapshot: AccountSnapshot, include: (asset: string) => boolean = () => true): number {
  return Object.entries(snapshot.balances)
    .filter(([asset]) => include(asset))
    .reduce((sum, [asset, qty]) => sum + qty * (snapshot.prices[asset] ?? 0), 0);
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
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

/**
 * Fine-grained grids for the `search` command -- deliberately much finer than
 * each strategy's own `.grid` (which is coarse on purpose, for walk-forward's
 * per-fold optimisation). These are sized to land near 10,000 real candidates
 * for donchian-breakout specifically, since that is the strategy this
 * feature exists to give an honest answer about.
 */
const FINE_GRIDS: Readonly<Record<string, Readonly<Record<string, readonly number[]>>>> = {
  'donchian-breakout': {
    entry: gridRange(10, 200, 5),
    exit: gridRange(5, 100, 5),
    atrStopMult: gridRange(1.5, 4.5, 0.25),
  },
  'ema-crossover': {
    fast: gridRange(5, 60, 2),
    slow: gridRange(20, 200, 5),
    atrStopMult: gridRange(1.5, 4.5, 0.25),
  },
};

/** Strategies whose signal depends on the sentiment side-channel. */
const SENTIMENT_STRATEGIES = new Set(['donchian-sentiment']);

async function loadContext(
  strategyName: string,
  candles: readonly Candle[],
): Promise<StrategyContext | undefined> {
  if (!SENTIMENT_STRATEGIES.has(strategyName)) return undefined;
  const sentiment = await fetchSentiment();
  return { sentiment: alignSentiment(candles, sentiment) };
}


/** The paper account marked to current prices, or null when no account exists yet. */
async function loadPaperStatus(
  statePath: string,
  exchange: string,
  priceOf: (symbol: string) => Promise<number | null> = priceCache(exchange),
): Promise<PaperStatus | null> {
  const account = await readPaperAccount(paperAccountPath(statePath));
  if (!account) return null;
  const state = await new StateStore(statePath).load();
  const prices: Record<string, number | null> = {};
  for (const [symbol, qty] of Object.entries(account.holdings)) {
    if (qty > 0) prices[symbol] = await priceOf(symbol);
  }
  return paperStatus(account, state, prices);
}

/** Latest price per symbol, fetched once however many accounts hold it. */
function priceCache(exchange: string): (symbol: string) => Promise<number | null> {
  const cache = new Map<string, Promise<number | null>>();
  return (symbol) => {
    let price = cache.get(symbol);
    if (!price) {
      price = fetchCandles({
        exchange, symbol, timeframe: '1m', bars: PRICE_LOOKBACK_MINUTES, cacheDir: 'data/cache', noCache: true,
      })
        .then((recent) => recent[recent.length - 1]?.close ?? null)
        // Unpriced positions are reported as such rather than guessed at.
        .catch(() => null);
      cache.set(symbol, price);
    }
    return price;
  };
}

/** How often the fleet validates, retires and replaces bots. */
const LIFECYCLE_CHECK_MS = 60 * 60 * 1000;

async function rankTopCoins(exchange: string, quote: string, concurrency: number): Promise<string[]> {
  const markets = await listMarkets(exchange, quote);
  let done = 0;
  const histories = await mapPool(markets, concurrency, async (symbol) => {
    let candles: Candle[] = [];
    try {
      candles = await fetchCandles({ exchange, symbol, timeframe: '1d', bars: 260, cacheDir: 'data/cache' });
    } catch {
      // A market that will not load is simply not a candidate.
    }
    done += 1;
    if (done % 50 === 0) process.stderr.write(`  ranked ${done}/${markets.length} markets\n`);
    return [symbol, candles] as const;
  });
  return rankByDollarVolume(Object.fromEntries(histories), { minBars: 201, top: 32, window: 30 });
}

async function writeFleet(path: string, fleet: FleetFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(fleet, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Every running bot's money, from its saved account, for the expansion check. */
async function fleetFunds(
  fleet: FleetFile,
  fleetDir: string,
  priceOf: (symbol: string) => Promise<number | null>,
  pathOf: (name: string) => string = (name) => botStatePath(fleetDir, name),
): Promise<BotFunds[]> {
  const out: BotFunds[] = [];
  for (const spec of fleet.bots) {
    const status = await loadPaperStatus(pathOf(spec.name), fleet.exchange, priceOf);
    if (!status) continue;
    out.push({
      name: spec.name,
      startingCash: status.startingCash,
      cash: status.cash,
      equity: status.equity,
      realized: Object.values(status.realizedBySymbol).reduce((sum, v) => sum + v, 0),
      withdrawn: status.withdrawn,
    });
  }
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_PORTFOLIO_UNIVERSE = 'BTC/USD,ETH/USD,SOL/USD,LTC/USD,LINK/USD,AVAX/USD';

function splitSymbols(list: string): string[] {
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * `--symbols screened` trades exactly what the last `screen` passed — the
 * "everything that is profitable" universe — and refuses if that screen was
 * for a different strategy or exchange, since its passes would mean nothing.
 */
async function resolveTradeSymbols(
  values: Record<string, unknown>,
  strategy: string,
  exchange: string,
  statePath: string,
): Promise<string[]> {
  const list = values['symbols'] as string | undefined;
  if (list === undefined) return [values['symbol'] as string];
  if (list !== 'screened') return splitSymbols(list);
  const path = screenPath(statePath);
  const screen = await readScreenFile(path);
  if (!screen) throw new Error(`no screen results at ${path}; run \`screen\` first`);
  const timeframe = values['timeframe'] as string;
  if (screen.strategy !== strategy || screen.exchange !== exchange || screen.timeframe !== timeframe) {
    // A pass on daily bars says nothing about the same parameters on hourly
    // bars — the lookbacks mean entirely different spans of time.
    throw new Error(
      `the last screen was ${screen.strategy} on ${screen.exchange} ${screen.timeframe} bars, ` +
      `not ${strategy} on ${exchange} ${timeframe}; re-run screen with matching flags`,
    );
  }
  if (screen.symbols.length === 0) throw new Error('the last screen passed no symbols; nothing to trade');
  return [...screen.symbols];
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
