import type { BacktestResult } from './backtest/engine.ts';
import { computeMetrics, type Metrics } from './backtest/metrics.ts';
import type { MonteCarloResult } from './backtest/monte-carlo.ts';
import { minimumViableEquity, roundTripCost } from './backtest/costs.ts';
import type { WalkForwardResult } from './backtest/walk-forward.ts';
import { asBacktestResult, type PortfolioResult } from './portfolio/engine.ts';
import type { SearchResult } from './backtest/search.ts';

const money = (n: number): string =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const pct = (n: number): string => `${n >= 0 ? '' : ''}${n.toFixed(2)}%`;
const ratio = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : 'n/a');
/** Profit factor's infinity has a specific, misleading meaning worth spelling out. */
const profitFactor = (n: number): string =>
  (Number.isFinite(n) ? n.toFixed(2) : 'n/a (no losing trades in this sample)');

function row(label: string, value: string): string {
  return `  ${label.padEnd(28)} ${value}`;
}

export function formatBacktest(result: BacktestResult, benchmark?: BacktestResult): string {
  const m = computeMetrics(result);
  const lines: string[] = [];
  lines.push(`\n${result.strategy.name}  ${JSON.stringify(result.strategy.params)}`);
  lines.push(`${'='.repeat(64)}`);
  lines.push('RETURN');
  lines.push(row('Starting equity', money(m.startingEquity)));
  lines.push(row('Ending equity', money(m.endingEquity)));
  lines.push(row('Total return', pct(m.totalReturnPct)));
  lines.push(row('CAGR', pct(m.cagrPct)));
  lines.push(row('Time in market', pct(m.timeInMarketPct)));
  lines.push(row('Avg exposure', pct(m.avgExposurePct)));

  lines.push('\nRISK  (the part the reels leave out)');
  lines.push(row('Max drawdown', pct(m.maxDrawdownPct)));
  lines.push(row('Longest drawdown', `${m.maxDrawdownDurationBars} bars`));
  lines.push(row('Sharpe (annualised)', ratio(m.sharpe)));
  lines.push(row('Sortino', ratio(m.sortino)));
  lines.push(row('Calmar (CAGR / max DD)', ratio(m.calmar)));

  lines.push('\nTRADES');
  lines.push(row('Closed trades', String(m.trades)));
  lines.push(row('Wins / losses', `${m.wins} / ${m.losses}`));
  lines.push(row('Win rate', pct(m.winRatePct)));
  lines.push(row('LOSS RATE', pct(m.lossRatePct)));
  lines.push(row('Worst losing streak', `${m.maxConsecutiveLosses} trades`));
  lines.push(row('Profit factor', profitFactor(m.profitFactor)));
  lines.push(row('Expectancy / trade', money(m.expectancy)));
  lines.push(row('Avg win / avg loss', `${money(m.avgWin)} / ${money(-m.avgLoss)}`));
  lines.push(row('Payoff ratio', ratio(m.payoffRatio)));
  lines.push(row('Largest single loss', money(m.largestLoss)));
  lines.push(row('Stopped out', `${m.stoppedOutCount} times`));
  lines.push(row('Total fees paid', money(m.totalFees)));
  lines.push(row('Round-trip cost', pct(roundTripCost(result.config.costs) * 100)));

  if (result.firstHalt) {
    lines.push('\nRISK HALT');
    lines.push(row(result.firstHalt.kind, result.firstHalt.reason));
    lines.push(row('Halted at', new Date(result.firstHalt.time).toISOString().slice(0, 10)));
  }

  if (benchmark) {
    const b = computeMetrics(benchmark);
    lines.push('\nVS BUY-AND-HOLD');
    lines.push(row('Buy & hold return', pct(b.totalReturnPct)));
    lines.push(row('Buy & hold max DD', pct(b.maxDrawdownPct)));
    lines.push(row('Buy & hold avg exposure', pct(b.avgExposurePct)));
    lines.push(row('Excess return', pct(m.totalReturnPct - b.totalReturnPct)));
    const verdict = m.calmar > b.calmar
      ? 'strategy wins on risk-adjusted terms'
      : 'buy-and-hold wins on risk-adjusted terms — the strategy is not earning its complexity';
    lines.push(row('Verdict', verdict));
  }

  lines.push(...realityCheck(m, result));
  return lines.join('\n');
}

/**
 * Printed on every report. Sample size is the thing most likely to make these
 * numbers meaningless, and it is the thing nobody checks voluntarily.
 */
function realityCheck(m: Metrics, result: BacktestResult): string[] {
  const notes: string[] = [];
  const { costs, limits } = result.config;
  // A 2.5x ATR stop on a daily crypto bar sits roughly 10% below entry.
  const floor = minimumViableEquity(costs, limits.riskPerTradePct, limits.maxPositionPct, 10);
  if (m.startingEquity < floor) {
    notes.push(
      `At ${money(m.startingEquity)} the risk limits size a position below the ${money(costs.minOrderNotional)} exchange minimum, so real orders would be REJECTED. This account needs about ${money(floor)} before it can trade these settings at all.`,
    );
  }
  const rejected = result.rejectedOrders ?? 0;
  if (rejected > 0) {
    notes.push(`${rejected} orders were below the exchange minimum and never placed.`);
  }
  if (m.trades < 30) {
    notes.push(`${m.trades} trades is too few to distinguish edge from luck; treat every ratio above as noise.`);
  }
  if (!Number.isFinite(m.profitFactor)) {
    notes.push('No losing trades in this sample. That is a sample-size artefact, not a property of the strategy.');
  }
  if (m.maxDrawdownPct > 30) {
    notes.push(`A ${m.maxDrawdownPct.toFixed(0)}% drawdown means a ${(100 * m.maxDrawdownPct / (100 - m.maxDrawdownPct)).toFixed(0)}% gain is needed just to get back to even.`);
  }
  if (m.winRatePct > 70 && m.payoffRatio < 1) {
    notes.push('High win rate with a payoff ratio below 1: many small wins funding a few large losses. This shape blows up.');
  }
  if (notes.length === 0) return [];
  return ['\nREALITY CHECK', ...notes.map((n) => `  - ${n}`)];
}

export function formatWalkForward(result: WalkForwardResult): string {
  const lines: string[] = [];
  lines.push(`\nWalk-forward: ${result.strategy}`);
  lines.push('='.repeat(64));
  lines.push('Parameters are chosen per fold using only prior bars; the numbers');
  lines.push('below are from bars the optimiser never saw.\n');

  for (const fold of result.folds) {
    const is = fold.inSampleMetrics;
    const oos = fold.outOfSampleMetrics;
    lines.push(`  Fold ${fold.index}  bars ${fold.outOfSample.from}-${fold.outOfSample.to}  ${JSON.stringify(fold.chosenParams)}`);
    lines.push(`    in-sample  return ${pct(is.totalReturnPct).padStart(9)}  maxDD ${pct(is.maxDrawdownPct).padStart(8)}  trades ${is.trades}`);
    lines.push(`    OUT-SAMPLE return ${pct(oos.totalReturnPct).padStart(9)}  maxDD ${pct(oos.maxDrawdownPct).padStart(8)}  trades ${oos.trades}`);
  }

  const m = result.outOfSampleMetrics;
  lines.push(`\n  Stitched out-of-sample result (${result.folds.length} folds)`);
  lines.push(row('Total return', pct(m.totalReturnPct)));
  lines.push(row('Max drawdown', pct(m.maxDrawdownPct)));
  lines.push(row('Loss rate', pct(m.lossRatePct)));
  lines.push(row('Out-of-sample trades', String(m.trades)));
  lines.push(row('Profit factor', profitFactor(m.profitFactor)));
  lines.push(row('Walk-forward efficiency', ratio(result.efficiency)));
  lines.push(
    result.efficiency >= 0.5
      ? '\n  Efficiency >= 0.5: the edge survived unseen data reasonably well.'
      : '\n  Efficiency < 0.5: most of the in-sample edge was curve fitting. Do not trade this.',
  );
  if (m.trades < 30) {
    lines.push(`  Only ${m.trades} out-of-sample trades. That is too few to conclude anything;`);
    lines.push('  use more history, a shorter timeframe, or more folds before believing it.');
  }
  return lines.join('\n');
}

export function formatMonteCarlo(mc: MonteCarloResult, startingEquity: number): string {
  const lines: string[] = [];
  lines.push(`\nMonte Carlo: ${mc.runs} resampled orderings of ${mc.tradesPerRun} trades`);
  lines.push('='.repeat(64));
  lines.push('Same trades, different sequence. The spread is how much of the');
  lines.push('backtest was luck of ordering rather than edge.\n');
  lines.push(row('Final equity  5th pct', money(mc.finalEquity.p5)));
  lines.push(row('              median', money(mc.finalEquity.median)));
  lines.push(row('              95th pct', money(mc.finalEquity.p95)));
  lines.push(row('              worst path', money(mc.finalEquity.worst)));
  lines.push(row('Max drawdown  median', pct(mc.maxDrawdownPct.median)));
  lines.push(row('              95th pct', pct(mc.maxDrawdownPct.p95)));
  lines.push(row('              worst path', pct(mc.maxDrawdownPct.worst)));
  lines.push('');
  lines.push(row('P(ending below start)', pct(mc.probabilityOfLoss * 100)));
  lines.push(row('P(50%+ drawdown)', pct(mc.probabilityOfRuin * 100)));
  lines.push(
    `\n  Starting equity was ${money(startingEquity)}. "P(ending below start)" is the`,
  );
  lines.push('  honest answer to "what are the chances this loses money". It is not zero,');
  lines.push('  and for any real strategy it never will be.');
  return lines.join('\n');
}

export function formatPortfolio(
  result: PortfolioResult,
  benchmark: PortfolioResult,
  coverage?: ReadonlyMap<string, number>,
): string {
  const lines: string[] = [];
  lines.push(formatBacktest(asBacktestResult(result), asBacktestResult(benchmark)));
  lines.push('\nPER-SYMBOL CONTRIBUTION');
  const entries = Object.entries(result.contribution).sort((a, b) => b[1] - a[1]);
  for (const [symbol, pnl] of entries) {
    const trades = result.trades.filter((t) => t.symbol === symbol).length;
    lines.push(row(symbol, `${money(pnl).padStart(14)}   ${trades} trades`));
  }
  const winners = entries.filter(([, pnl]) => pnl > 0).length;
  lines.push(
    `\n  ${winners} of ${entries.length} symbols contributed positively. Concentration in one`,
  );
  lines.push('  symbol means the diversification is nominal, not real.');

  if (coverage) {
    const thin = [...coverage.entries()].filter(([, c]) => c < 0.9);
    if (thin.length > 0) {
      lines.push('\n  History trimmed to the timestamps every symbol shares:');
      for (const [symbol, c] of thin) {
        lines.push(`    ${symbol}: ${(c * 100).toFixed(0)}% of its own bars survived alignment`);
      }
    }
  }
  return lines.join('\n');
}

export function formatSearch(result: SearchResult, fullGridSize: number): string {
  const lines: string[] = [];
  lines.push(`\nSearch: ${result.strategy}`);
  lines.push('='.repeat(64));
  lines.push(`Full parameter grid: ${fullGridSize.toLocaleString()} combinations.`);
  lines.push(`Tested: ${result.candidatesTested.toLocaleString()} (${result.candidatesSkipped} invalid, skipped).`);
  lines.push(`Train: bars ${result.trainBars.from}-${result.trainBars.to}  |  Test (held out): bars ${result.testBars.from}-${result.testBars.to}\n`);

  lines.push('The question this answers: across thousands of candidates, does');
  lines.push('doing well on training data predict doing well on data it never saw?\n');

  lines.push(row('Train/test Calmar correlation', result.trainTestCorrelation.toFixed(3)));
  lines.push(row('Test Calmar: 10th / 50th / 90th pct',
    `${result.testCalmarPercentiles.p10.toFixed(2)} / ${result.testCalmarPercentiles.p50.toFixed(2)} / ${result.testCalmarPercentiles.p90.toFixed(2)}`));
  lines.push(row('Fraction with positive test Calmar', `${(result.testCalmarPositiveFraction * 100).toFixed(1)}%`));

  if (result.bestOnTrain) {
    lines.push('\nWhat "just pick the best one" would have gotten you:');
    lines.push(row('Best candidate, by TRAIN Calmar', result.bestOnTrain.trainCalmar.toFixed(2)));
    lines.push(row('  ...that same candidate, on TEST', result.bestOnTrain.testCalmar.toFixed(2)));
    lines.push(row('  params', JSON.stringify(result.bestOnTrain.params)));
  }

  lines.push('');
  if (Math.abs(result.trainTestCorrelation) < 0.15) {
    lines.push(`Correlation near zero: which candidates looked best on training data was`);
    lines.push(`close to unrelated to which ones actually did well afterward. Testing more`);
    lines.push(`candidates from this grid does not find more edge -- it just raises the odds`);
    lines.push(`that some candidate got lucky on the training window, which is a false`);
    lines.push(`positive waiting to be mistaken for a discovery.`);
  } else if (result.trainTestCorrelation > 0) {
    lines.push(`Positive correlation: training performance had SOME real relationship to`);
    lines.push(`what happened afterward, though the size of the correlation is what decides`);
    lines.push(`whether that is worth trusting -- weak positive correlation across a huge`);
    lines.push(`grid is still mostly noise with a small real signal buried in it.`);
  } else {
    lines.push(`Negative correlation: candidates that looked BETTER on training data did`);
    lines.push(`WORSE afterward. That is the signature of overfitting a large search space --`);
    lines.push(`the best-looking candidates were the ones most specifically tuned to`);
    lines.push(`quirks of the training window that did not repeat.`);
  }
  return lines.join('\n');
}
