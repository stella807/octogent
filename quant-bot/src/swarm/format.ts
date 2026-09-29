import type { Scorecard } from './score.ts';
import type { SwarmForecast } from './swarm.ts';

const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;

export function formatSwarmForecast(f: SwarmForecast, symbol: string, timeframe: string, lastClose: number): string {
  const lines = [
    `SWARM FORECAST  ${symbol}  next ${f.horizon} × ${timeframe}  (from the close at ${lastClose})`,
    '================================================================',
    `  P(up)                        ${pct(f.pUp)}`,
    `  Expected move                ${f.expectedLogReturn >= 0 ? '+' : ''}${pct(Math.expm1(f.expectedLogReturn), 2)}`,
    `  Crowd net demand             ${f.netDemand >= 0 ? '+' : ''}${f.netDemand.toFixed(3)}  (-1 all selling … +1 all buying)`,
    `  Fitted crowd impact          ${f.impact.toExponential(2)}`,
  ];
  if (f.impact === 0) {
    lines.push(
      '',
      '  The crowd has shown no predictive power on recent bars, so its vote is',
      '  given zero weight: this forecast is just the recent historical up-rate.',
    );
  }
  lines.push('', 'CROWD (largest styles)');
  for (const c of f.crowd.slice(0, 5)) {
    const name = `${c.archetype.kind === 'trend' ? 'trend follower' : 'contrarian'}, ${c.archetype.lookback}-bar`;
    const stance = c.demand > 0.05 ? 'buying' : c.demand < -0.05 ? 'selling' : 'neutral';
    lines.push(`  ${name.padEnd(26)} ${pct(c.share).padStart(6)} of crowd, ${stance} (${c.demand.toFixed(2)})`);
  }
  lines.push(
    '',
    'Not evidence of anything until `swarm --evaluate` says so on this market.',
  );
  return lines.join('\n');
}

export function formatScorecard(card: Scorecard, symbol: string, timeframe: string, horizon: number): string {
  const verdict = card.tStatVsBaseRate >= 2
    ? 'Beat the historical up-rate by more than chance explains.'
    : card.tStatVsBaseRate <= -2
      ? 'WORSE than the historical up-rate, by more than chance explains.'
      : 'No evidence of skill: indistinguishable from just using the historical up-rate.';
  const lines = [
    `SWARM SCORECARD  ${symbol}  ${horizon} × ${timeframe} ahead, ${card.n} forecasts, each made from past bars only`,
    '================================================================',
    `  Brier score (lower is better)`,
    `    swarm                      ${card.brier.toFixed(4)}`,
    `    always 50% (coin flip)     ${card.brierCoinFlip.toFixed(4)}`,
    `    historical up-rate         ${card.brierBaseRate.toFixed(4)}`,
    `  Skill vs coin flip           ${card.skillVsCoinFlip >= 0 ? '+' : ''}${pct(card.skillVsCoinFlip, 2)}`,
    `  Skill vs historical up-rate  ${card.skillVsBaseRate >= 0 ? '+' : ''}${pct(card.skillVsBaseRate, 2)}   t = ${card.tStatVsBaseRate.toFixed(2)}`,
    `  Direction right              ${pct(card.directionalHitRate)} of ${card.directionalCalls} calls`,
    '',
    'CALIBRATION  (when the swarm said X%, how often did it go up?)',
  ];
  for (const b of card.calibration) {
    lines.push(
      `  said ${pct(b.lo, 0).padStart(4)}–${pct(b.hi, 0).padEnd(5)} ${String(b.n).padStart(5)} times   ` +
      `avg said ${pct(b.meanP)}   went up ${pct(b.actualUpRate)}`,
    );
  }
  lines.push('', `VERDICT  ${verdict}`);
  return lines.join('\n');
}
