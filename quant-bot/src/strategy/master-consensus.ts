import type { Candle, Position, Signal } from '../domain/types.ts';
import { FLAT } from '../domain/types.ts';
import { atr, closes, mcginleyDynamic, tdfi, tsi } from '../indicators/index.ts';
import { param, type Params, type Strategy, type StrategyFactory } from './types.ts';

/**
 * Three indicators marked in the same viral checklist screenshot as
 * bxtrender-adx, combined into what the screenshot's caption called a
 * "master strategy": a trend baseline, a momentum oscillator, and a
 * volume-weighted force index, each from a different signal family so they
 * are not just three names for the same underlying calculation wearing
 * different clothes.
 *
 *   - McGinley Dynamic: an adaptive moving average. Price above it is the
 *     trend baseline reading bullish.
 *   - TSI (True Strength Index): double-smoothed momentum. Positive is
 *     bullish momentum.
 *   - TDFI (Trend Direction Force Index): volume-weighted, ATR-normalised
 *     force. This repo's implementation does not replicate the extra
 *     min-max normalisation some published variants apply on top of the
 *     documented core formula, so its magnitude is not on the same ~0.05
 *     scale those variants use -- only its SIGN is used here, which the
 *     normalisation does not change.
 *
 * All three must agree on direction to trade: a three-way consensus rather
 * than a magnitude threshold on any single one, since only one of the three
 * indicators here is calibrated to a scale this repo actually verified.
 * That is the "master strategy" a checklist screenshot's caption implies --
 * built for real and about to be tested exactly as rigorously as everything
 * else tonight, including the strategies this same screenshot already
 * contributed that failed walk-forward.
 */
export const masterConsensus: StrategyFactory = {
  name: 'master-consensus',
  defaults: {
    mcginleyPeriod: 14,
    tsiLongPeriod: 25, tsiShortPeriod: 13,
    tdfiAtrPeriod: 14, tdfiSmoothPeriod: 13,
    atrStopMult: 2.5,
  },
  grid: {
    mcginleyPeriod: [10, 14, 20],
    tsiLongPeriod: [15, 25, 40],
    atrStopMult: [2, 2.5, 3],
  },
  create(candles: readonly Candle[], params: Params): Strategy {
    const mcginleyPeriod = param(params, 'mcginleyPeriod', 14);
    const tsiLongPeriod = param(params, 'tsiLongPeriod', 25);
    const tsiShortPeriod = param(params, 'tsiShortPeriod', 13);
    const tdfiAtrPeriod = param(params, 'tdfiAtrPeriod', 14);
    const tdfiSmoothPeriod = param(params, 'tdfiSmoothPeriod', 13);
    const stopMult = param(params, 'atrStopMult', 2.5);
    if (tsiShortPeriod >= tsiLongPeriod) {
      throw new RangeError(`master-consensus needs tsiShortPeriod < tsiLongPeriod, got ${tsiShortPeriod} >= ${tsiLongPeriod}`);
    }

    const price = closes(candles);
    const mdLine = mcginleyDynamic(price, mcginleyPeriod);
    const tsiLine = tsi(price, tsiLongPeriod, tsiShortPeriod);
    const tdfiLine = tdfi(candles, tdfiAtrPeriod, tdfiSmoothPeriod);
    const atrLine = atr(candles, 14);

    const warmup = Math.max(
      mcginleyPeriod,
      tsiLongPeriod + tsiShortPeriod,
      tdfiAtrPeriod + tdfiSmoothPeriod,
      14,
    ) + 2;

    return {
      name: 'master-consensus',
      params: { mcginleyPeriod, tsiLongPeriod, tsiShortPeriod, tdfiAtrPeriod, tdfiSmoothPeriod, atrStopMult: stopMult },
      warmup,
      signalAt(i: number, position: Position | null): Signal {
        const md = mdLine[i];
        const tsiValue = tsiLine[i];
        const tdfiValue = tdfiLine[i];
        if (md === null || md === undefined || tsiValue === null || tsiValue === undefined
          || tdfiValue === null || tdfiValue === undefined) {
          return FLAT;
        }
        const close = (candles[i] as Candle).close;
        const atrValue = atrLine[i] ?? 0;

        const baselineUp = close > md;
        const momentumUp = tsiValue > 0;
        const forceUp = tdfiValue > 0;
        const allAgreeUp = baselineUp && momentumUp && forceUp;

        if (position === null) {
          if (!allAgreeUp) {
            const dissent = [!baselineUp && 'baseline', !momentumUp && 'momentum', !forceUp && 'force']
              .filter(Boolean).join(', ');
            return { target: 0, reason: `no consensus: ${dissent} disagree` };
          }
          return {
            target: 1,
            stopPrice: close - stopMult * atrValue,
            reason: `all three agree bullish (baseline, TSI ${tsiValue.toFixed(1)}, TDFI sign +)`,
          };
        }

        // Exit as soon as any one of the three breaks consensus -- holding
        // out for all three to flip bearish would give back most of a move
        // waiting for confirmation that was already gone.
        if (!allAgreeUp) {
          return { target: 0, reason: 'consensus broken: at least one indicator turned' };
        }
        const raw = close - stopMult * atrValue;
        return { target: 1, stopPrice: Math.max(position.stopPrice ?? raw, raw), reason: 'consensus holds' };
      },
    };
  },
};
