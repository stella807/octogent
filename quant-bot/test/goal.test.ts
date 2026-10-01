import { describe, expect, it } from 'vitest';
import { formatGoal, monthsToTarget, targetCapital } from '../src/research/goal.ts';

describe('targetCapital', () => {
  it('is the daily target times 365 over the yearly return', () => {
    expect(targetCapital(140, 35)).toBeCloseTo(146_000, 0);
    expect(targetCapital(5, 20)).toBeCloseTo(9_125, 0);
  });

  it('refuses a return that is not positive', () => {
    expect(() => targetCapital(140, 0)).toThrow(/positive/);
    expect(() => targetCapital(140, -5)).toThrow(/positive/);
  });
});

describe('monthsToTarget', () => {
  it('is zero when already there', () => {
    expect(monthsToTarget(1000, 500, 35, 0)).toBe(0);
  });

  it('compounds monthly with no deposits: 100 doubles in about 2.3 years at 35%', () => {
    const months = monthsToTarget(100, 200, 35, 0) as number;
    expect(months / 12).toBeGreaterThan(2.2);
    expect(months / 12).toBeLessThan(2.4);
  });

  it('shortens with deposits', () => {
    const none = monthsToTarget(25, 10_000, 35, 0) as number;
    const some = monthsToTarget(25, 10_000, 35, 100) as number;
    expect(some).toBeLessThan(none);
  });

  it('returns null when the target is beyond a century, instead of a silly number', () => {
    expect(monthsToTarget(25, 1e15, 1, 0)).toBeNull();
  });

  it('returns null for a return that is not positive and no deposits can help', () => {
    expect(monthsToTarget(25, 1000, 0, 0)).toBeNull();
  });
});

describe('formatGoal', () => {
  it('states the required account and that a loss year resets it, without promising anything', () => {
    const text = formatGoal({ daily: 140, start: 25, monthlyDeposit: 0, returns: [10, 20, 35] });
    expect(text).toMatch(/\$146,000/);
    expect(text).toMatch(/not a forecast/i);
    expect(text).toMatch(/years/);
  });
});
