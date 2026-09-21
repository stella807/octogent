import { buyAndHold } from './buy-and-hold.ts';
import { donchianBreakout } from './donchian-breakout.ts';
import { emaCrossover } from './ema-crossover.ts';
import { rsiMeanReversion } from './rsi-mean-reversion.ts';
import { takeProfitScalp } from './take-profit-scalp.ts';
import type { StrategyFactory } from './types.ts';

export const STRATEGIES: Readonly<Record<string, StrategyFactory>> = {
  [buyAndHold.name]: buyAndHold,
  [emaCrossover.name]: emaCrossover,
  [donchianBreakout.name]: donchianBreakout,
  [rsiMeanReversion.name]: rsiMeanReversion,
  [takeProfitScalp.name]: takeProfitScalp,
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

export { buyAndHold, donchianBreakout, emaCrossover, rsiMeanReversion, takeProfitScalp };
export * from './types.ts';
