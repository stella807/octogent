import { crossSectionalMomentum } from './cross-sectional-momentum.ts';
import { equalWeight } from './equal-weight.ts';
import type { PortfolioStrategyFactory } from './types.ts';

export const PORTFOLIO_STRATEGIES: Readonly<Record<string, PortfolioStrategyFactory>> = {
  [equalWeight.name]: equalWeight,
  [crossSectionalMomentum.name]: crossSectionalMomentum,
};

export function getPortfolioStrategy(name: string): PortfolioStrategyFactory {
  const factory = PORTFOLIO_STRATEGIES[name];
  if (!factory) {
    throw new Error(
      `unknown portfolio strategy "${name}". Available: ${Object.keys(PORTFOLIO_STRATEGIES).join(', ')}`,
    );
  }
  return factory;
}

export { alignCandles, alignmentCoverage } from './align.ts';
export { crossSectionalMomentum, equalWeight };
export * from './engine.ts';
export * from './types.ts';
