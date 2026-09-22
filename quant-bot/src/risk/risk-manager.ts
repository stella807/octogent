/**
 * Hard risk limits, enforced by the same object in backtests and in live
 * trading so the two cannot drift apart.
 *
 * This module is the actual answer to "a bot with no losses". You cannot stop
 * a trade from losing. What you can do is bound how much any single trade,
 * any single day, and any single losing streak is allowed to take out of the
 * account — which is the difference between a drawdown you recover from and
 * one you do not.
 */

export interface RiskLimits {
  /**
   * Fraction of equity risked between entry and stop, in percent. At 1% a
   * trader needs 100 consecutive maximum losses to be wiped out, and can
   * survive the 10-15 loss streaks that every trend system eventually hits.
   * Above ~2% the arithmetic of recovery turns against you quickly.
   */
  readonly riskPerTradePct: number;
  /** Cap on position notional as a percent of equity. Spot cannot exceed 100. */
  readonly maxPositionPct: number;
  /** Realised+unrealised loss within one UTC day that flattens and pauses trading. */
  readonly maxDailyLossPct: number;
  /** Drawdown from peak equity that trips the kill switch permanently. */
  readonly maxDrawdownPct: number;
  /** Stop trading outright below this equity rather than grinding to dust. */
  readonly minEquity: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  riskPerTradePct: 1,
  maxPositionPct: 100,
  maxDailyLossPct: 5,
  maxDrawdownPct: 25,
  minEquity: 0,
};

export type HaltKind = 'none' | 'daily-loss' | 'max-drawdown' | 'min-equity';

export interface RiskState {
  readonly halt: HaltKind;
  /** True while the halt also requires flattening any open position. */
  readonly flatten: boolean;
  readonly reason: string;
  readonly peakEquity: number;
  readonly drawdownPct: number;
  readonly dayStartEquity: number;
  readonly dayLossPct: number;
}

const DAY_MS = 86_400_000;

export class RiskManager {
  readonly limits: RiskLimits;
  #peakEquity: number;
  #dayStartEquity: number;
  #dayIndex: number;
  #dailyHaltedDay: number | null = null;
  #killed = false;
  #killReason: HaltKind = 'none';

  constructor(startingEquity: number, limits: RiskLimits = DEFAULT_LIMITS) {
    validate(limits);
    this.limits = limits;
    this.#peakEquity = startingEquity;
    this.#dayStartEquity = startingEquity;
    this.#dayIndex = Number.NEGATIVE_INFINITY;
  }

  /**
   * Called once per bar with the mark-to-market equity, BEFORE the strategy is
   * consulted. Marking on unrealised equity rather than realised P&L is
   * deliberate: a kill switch that only counts closed trades does not fire
   * during the open position that is actually destroying the account.
   */
  onBar(time: number, equity: number): RiskState {
    const day = Math.floor(time / DAY_MS);
    if (day !== this.#dayIndex) {
      this.#dayIndex = day;
      this.#dayStartEquity = equity;
      // A new UTC day clears yesterday's pause. The drawdown kill switch is
      // not a pause and never clears here.
      if (this.#dailyHaltedDay !== null && this.#dailyHaltedDay !== day) {
        this.#dailyHaltedDay = null;
      }
    }

    if (equity > this.#peakEquity) this.#peakEquity = equity;
    const drawdownPct = this.#peakEquity > 0
      ? ((this.#peakEquity - equity) / this.#peakEquity) * 100
      : 0;
    const dayLossPct = this.#dayStartEquity > 0
      ? ((this.#dayStartEquity - equity) / this.#dayStartEquity) * 100
      : 0;

    if (!this.#killed) {
      if (equity <= this.limits.minEquity) {
        this.#killed = true;
        this.#killReason = 'min-equity';
      } else if (drawdownPct >= this.limits.maxDrawdownPct) {
        this.#killed = true;
        this.#killReason = 'max-drawdown';
      }
    }

    if (this.#killed) {
      return this.#state(this.#killReason, true, drawdownPct, dayLossPct,
        this.#killReason === 'min-equity'
          ? `equity ${equity.toFixed(2)} at or below floor ${this.limits.minEquity}`
          : `drawdown ${drawdownPct.toFixed(2)}% hit the ${this.limits.maxDrawdownPct}% kill switch`);
    }

    if (this.#dailyHaltedDay === day) {
      return this.#state('daily-loss', true, drawdownPct, dayLossPct,
        `trading paused for the day after a ${dayLossPct.toFixed(2)}% loss`);
    }
    if (dayLossPct >= this.limits.maxDailyLossPct) {
      this.#dailyHaltedDay = day;
      return this.#state('daily-loss', true, drawdownPct, dayLossPct,
        `daily loss ${dayLossPct.toFixed(2)}% hit the ${this.limits.maxDailyLossPct}% limit`);
    }

    return this.#state('none', false, drawdownPct, dayLossPct, 'within limits');
  }

  /** True once the drawdown or equity-floor kill switch has fired. Never resets. */
  get killed(): boolean {
    return this.#killed;
  }

  /**
   * Quantity to buy, sized so that being stopped out costs exactly
   * `riskPerTradePct` of equity, then capped by the position limit and by the
   * cash actually available. Returns 0 when no position can be taken safely.
   */
  sizePosition(equity: number, entryPrice: number, stopPrice: number | undefined): number {
    if (equity <= 0 || entryPrice <= 0) return 0;
    const capNotional = equity * (this.limits.maxPositionPct / 100);
    let notional = capNotional;

    if (stopPrice !== undefined && stopPrice > 0 && stopPrice < entryPrice) {
      const riskPerUnit = entryPrice - stopPrice;
      const riskBudget = equity * (this.limits.riskPerTradePct / 100);
      notional = Math.min(capNotional, (riskBudget / riskPerUnit) * entryPrice);
    }
    // Without a stop there is no defined risk per unit, so the position limit
    // is the only thing standing between the strategy and the whole account.

    const qty = notional / entryPrice;
    return qty > 0 && Number.isFinite(qty) ? qty : 0;
  }

  #state(
    halt: HaltKind,
    flatten: boolean,
    drawdownPct: number,
    dayLossPct: number,
    reason: string,
  ): RiskState {
    return {
      halt,
      flatten,
      reason,
      peakEquity: this.#peakEquity,
      drawdownPct,
      dayStartEquity: this.#dayStartEquity,
      dayLossPct,
    };
  }
}

function validate(limits: RiskLimits): void {
  const positive: (keyof RiskLimits)[] = [
    'riskPerTradePct',
    'maxPositionPct',
    'maxDailyLossPct',
    'maxDrawdownPct',
  ];
  for (const key of positive) {
    const value = limits[key];
    if (!(value > 0)) throw new RangeError(`${key} must be > 0, got ${value}`);
  }
  if (limits.maxPositionPct > 100) {
    throw new RangeError(
      `maxPositionPct ${limits.maxPositionPct} exceeds 100: this bot is spot-only and does not use leverage`,
    );
  }
  if (limits.riskPerTradePct > 5) {
    throw new RangeError(
      `riskPerTradePct ${limits.riskPerTradePct} is above the 5% ceiling; at that size a normal losing streak is an account-ending event`,
    );
  }
}

/**
 * Limits that never halt. Only for benchmark runs: a buy-and-hold comparison
 * that gets flattened by a drawdown switch is no longer measuring buy-and-hold,
 * which would quietly flatter every strategy compared against it.
 */
export const BENCHMARK_LIMITS: RiskLimits = {
  riskPerTradePct: 5,
  maxPositionPct: 100,
  maxDailyLossPct: 100,
  maxDrawdownPct: 100,
  minEquity: 0,
};
