import { describe, expect, it } from 'vitest';
import { CONSERVATIVE_LIMITS, DEFAULT_LIMITS, RiskManager, type RiskLimits } from '../src/risk/risk-manager.ts';

const DAY = 86_400_000;
const t = (day: number, hour = 0): number => Date.UTC(2024, 0, 1 + day) + hour * 3_600_000;

const limits = (overrides: Partial<RiskLimits> = {}): RiskLimits => ({
  ...DEFAULT_LIMITS,
  ...overrides,
});

describe('position sizing', () => {
  it('sizes so that hitting the stop costs exactly the risk budget', () => {
    const risk = new RiskManager(10_000, limits({ riskPerTradePct: 1 }));
    // Stop is $10 below a $100 entry, so 1% of 10,000 = $100 of risk buys 10 units.
    const qty = risk.sizePosition(10_000, 100, 90);
    expect(qty).toBeCloseTo(10, 9);
    expect((100 - 90) * qty).toBeCloseTo(100, 9);
  });

  it('shrinks the position as the stop widens, instead of taking more risk', () => {
    const risk = new RiskManager(10_000, limits({ riskPerTradePct: 1 }));
    const tight = risk.sizePosition(10_000, 100, 98);
    const wide = risk.sizePosition(10_000, 100, 80);
    expect(wide).toBeLessThan(tight);
    expect((100 - 98) * tight).toBeCloseTo((100 - 80) * wide, 6);
  });

  it('caps at the position limit when the stop is very tight', () => {
    const risk = new RiskManager(10_000, limits({ riskPerTradePct: 1, maxPositionPct: 50 }));
    const qty = risk.sizePosition(10_000, 100, 99.99);
    expect(qty * 100).toBeLessThanOrEqual(5_000 + 1e-9);
  });

  it('falls back to the position cap when no stop is supplied', () => {
    const risk = new RiskManager(10_000, limits({ maxPositionPct: 40 }));
    expect(risk.sizePosition(10_000, 100, undefined) * 100).toBeCloseTo(4_000, 6);
  });

  it('returns zero rather than a nonsense size on a broken stop', () => {
    const risk = new RiskManager(10_000, limits());
    expect(risk.sizePosition(0, 100, 90)).toBe(0);
    // A stop above the entry is not a stop; fall back to the cap, never to Infinity.
    expect(Number.isFinite(risk.sizePosition(10_000, 100, 110))).toBe(true);
  });
});

describe('drawdown kill switch', () => {
  it('fires at the limit and never un-fires, even if equity recovers', () => {
    const risk = new RiskManager(10_000, limits({ maxDrawdownPct: 20 }));
    expect(risk.onBar(t(0), 10_000).halt).toBe('none');
    expect(risk.onBar(t(1), 12_000).halt).toBe('none');
    // 12,000 peak; 20% down is 9,600.
    expect(risk.onBar(t(2), 9_500).halt).toBe('max-drawdown');
    expect(risk.killed).toBe(true);
    // A recovery to a new high must NOT re-enable trading.
    expect(risk.onBar(t(3), 20_000).halt).toBe('max-drawdown');
    expect(risk.onBar(t(400), 99_999).flatten).toBe(true);
  });

  it('measures drawdown from the peak, not from the starting equity', () => {
    const risk = new RiskManager(10_000, limits({ maxDrawdownPct: 20 }));
    risk.onBar(t(0), 10_000);
    risk.onBar(t(1), 50_000);
    // Still up 100% on the account, but 60% off the peak: that is the number
    // that decides whether the strategy has stopped working.
    expect(risk.onBar(t(2), 20_000).halt).toBe('max-drawdown');
  });
});

describe('daily loss limit', () => {
  it('pauses trading for the rest of the day and resumes the next day', () => {
    const risk = new RiskManager(10_000, limits({ maxDailyLossPct: 5, maxDrawdownPct: 90 }));
    expect(risk.onBar(t(0, 0), 10_000).halt).toBe('none');
    expect(risk.onBar(t(0, 6), 9_400).halt).toBe('daily-loss');
    expect(risk.onBar(t(0, 12), 9_900).halt).toBe('daily-loss');
    // New UTC day re-anchors and clears the pause.
    expect(risk.onBar(t(1, 0), 9_900).halt).toBe('none');
    expect(risk.killed).toBe(false);
  });

  it('re-anchors the daily baseline so a slow bleed is measured per day', () => {
    const risk = new RiskManager(10_000, limits({ maxDailyLossPct: 5, maxDrawdownPct: 90 }));
    risk.onBar(t(0), 10_000);
    risk.onBar(t(1), 9_700); // -3% on day 1, allowed
    expect(risk.onBar(t(1, 12), 9_600).halt).toBe('none');
    expect(risk.onBar(t(2), 9_600).halt).toBe('none');
    expect(risk.onBar(t(2, 12), 9_100).halt).toBe('daily-loss'); // -5.2% within day 2
  });
});

describe('limit validation', () => {
  it('refuses leverage, because a liquidatable account is a different bot', () => {
    expect(() => new RiskManager(1_000, limits({ maxPositionPct: 300 }))).toThrow(/leverage/);
  });

  it('refuses a per-trade risk that no losing streak could survive', () => {
    expect(() => new RiskManager(1_000, limits({ riskPerTradePct: 25 }))).toThrow(/losing streak/);
  });

  it('refuses non-positive limits', () => {
    expect(() => new RiskManager(1_000, limits({ maxDrawdownPct: 0 }))).toThrow(RangeError);
  });
});

describe('equity floor', () => {
  it('stops trading at the floor instead of grinding the account to dust', () => {
    const risk = new RiskManager(1_000, limits({ minEquity: 500, maxDrawdownPct: 90 }));
    expect(risk.onBar(t(0), 1_000).halt).toBe('none');
    expect(risk.onBar(t(1), 480).halt).toBe('min-equity');
    expect(risk.killed).toBe(true);
  });
});

describe('halt precedence', () => {
  it('reports the drawdown kill switch even on a day that also broke the daily limit', () => {
    const risk = new RiskManager(10_000, limits({ maxDailyLossPct: 5, maxDrawdownPct: 10 }));
    risk.onBar(t(0), 10_000);
    const state = risk.onBar(t(0, 6), 8_000);
    expect(state.halt).toBe('max-drawdown');
    expect(state.flatten).toBe(true);
  });
});

describe('time handling', () => {
  it('treats bars within the same UTC day as one day', () => {
    const risk = new RiskManager(10_000, limits());
    const first = risk.onBar(t(0, 1), 10_000);
    const later = risk.onBar(t(0, 23), 9_900);
    expect(later.dayStartEquity).toBe(first.dayStartEquity);
    expect(DAY).toBe(86_400_000);
  });
});

describe('CONSERVATIVE_LIMITS', () => {
  it('is tighter than the research default, and only on drawdown', () => {
    expect(CONSERVATIVE_LIMITS.maxDrawdownPct).toBeLessThan(DEFAULT_LIMITS.maxDrawdownPct);
    expect(CONSERVATIVE_LIMITS.maxDrawdownPct).toBe(15);
    // Every other limit is inherited unchanged.
    expect(CONSERVATIVE_LIMITS.riskPerTradePct).toBe(DEFAULT_LIMITS.riskPerTradePct);
    expect(CONSERVATIVE_LIMITS.maxDailyLossPct).toBe(DEFAULT_LIMITS.maxDailyLossPct);
  });

  it('passes the same validation every other limit set does', () => {
    expect(() => new RiskManager(10_000, CONSERVATIVE_LIMITS)).not.toThrow();
  });
});
