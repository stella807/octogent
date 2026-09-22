import type { Candle } from '../domain/types.ts';
import type { Strategy, StrategyFactory } from './types.ts';

/**
 * The benchmark every other strategy has to beat, and the reason this file
 * exists at all. Most crypto strategies that look brilliant in a backtest are
 * just long exposure with extra steps, and they underperform this once fees
 * are charged. If a strategy cannot beat buy-and-hold on risk-adjusted terms,
 * the honest answer is to buy and hold.
 */
export const buyAndHold: StrategyFactory = {
  name: 'buy-and-hold',
  defaults: {},
  grid: {},
  create(_candles: readonly Candle[]): Strategy {
    return {
      name: 'buy-and-hold',
      params: {},
      warmup: 0,
      signalAt: () => ({ target: 1, reason: 'benchmark: always long' }),
    };
  },
};
