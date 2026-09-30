import { buyAndHold } from './buy-and-hold.ts';
import { donchianBreakout } from './donchian-breakout.ts';
import { emaCrossover } from './ema-crossover.ts';
import { rsiMeanReversion } from './rsi-mean-reversion.ts';
import { takeProfitScalp } from './take-profit-scalp.ts';
import { volTarget } from './vol-target.ts';
import { tsmom } from './tsmom.ts';
import { bollingerReversion } from './bollinger-reversion.ts';
import { donchianSentiment } from './donchian-sentiment.ts';
import { bxtrenderAdx } from './bxtrender-adx.ts';
import { masterConsensus } from './master-consensus.ts';
import { emaZoneReversal } from './ema-zone-reversal.ts';
import { gridRange } from './grid-range.ts';
import { dcaSafety } from './dca-safety.ts';
import { trendHold } from './trend-hold.ts';
import { coinFlipStrategy } from './coin-flip.ts';
import { trendHoldWhales } from './trend-hold-whales.ts';
import { trendHoldDual, trendHoldSlope, trendHoldTrail } from './trend-hold-variants.ts';
import { trendVote } from './trend-vote.ts';
import { LONG_FLAT_STRATEGIES } from './long-flat.ts';
import { VOTE_STRATEGIES } from './vote-strategies.ts';
import type { StrategyFactory } from './types.ts';

export const STRATEGIES: Readonly<Record<string, StrategyFactory>> = {
  [buyAndHold.name]: buyAndHold,
  [emaCrossover.name]: emaCrossover,
  [donchianBreakout.name]: donchianBreakout,
  [rsiMeanReversion.name]: rsiMeanReversion,
  [takeProfitScalp.name]: takeProfitScalp,
  [volTarget.name]: volTarget,
  [tsmom.name]: tsmom,
  [bollingerReversion.name]: bollingerReversion,
  [donchianSentiment.name]: donchianSentiment,
  [bxtrenderAdx.name]: bxtrenderAdx,
  [masterConsensus.name]: masterConsensus,
  [emaZoneReversal.name]: emaZoneReversal,
  [gridRange.name]: gridRange,
  [dcaSafety.name]: dcaSafety,
  [trendHold.name]: trendHold,
  [coinFlipStrategy.name]: coinFlipStrategy,
  [trendHoldWhales.name]: trendHoldWhales,
  [trendHoldDual.name]: trendHoldDual,
  [trendHoldTrail.name]: trendHoldTrail,
  [trendHoldSlope.name]: trendHoldSlope,
  [trendVote.name]: trendVote,
  ...Object.fromEntries(LONG_FLAT_STRATEGIES.map((f) => [f.name, f])),
  ...Object.fromEntries(VOTE_STRATEGIES.map((f) => [f.name, f])),
};

export function getStrategy(name: string): StrategyFactory {
  const factory = STRATEGIES[name];
  if (!factory) {
    throw new Error(
      `unknown strategy "${name}". Available: ${Object.keys(STRATEGIES).join(', ')}`,
    );
  }
  return factory;
}

export {
  buyAndHold,
  donchianBreakout,
  emaCrossover,
  rsiMeanReversion,
  takeProfitScalp,
  volTarget,
  tsmom,
  bollingerReversion,
  donchianSentiment,
  bxtrenderAdx,
  masterConsensus,
  emaZoneReversal,
  gridRange,
  dcaSafety,
};
export * from './types.ts';
