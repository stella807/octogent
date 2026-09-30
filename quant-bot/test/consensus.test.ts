import { describe, expect, it } from 'vitest';
import {
  binomialTail,
  consensusVerdict,
  demotionReason,
  promotionVerdict,
  TRIAL_MS,
  type BotSpec,
} from '../src/live/fleet.ts';
import { formatFleetStatus } from '../src/live/fleet.ts';
import type { PaperStatus } from '../src/live/status.ts';

const DAY = 86_400_000;
const spec = (strategy: string, symbol = 'BTC/USD'): BotSpec => ({
  name: `x-${strategy}`, group: 'g', strategy, symbols: [symbol], timeframe: '1d', equity: 2.5, feeBps: 60, maxDrawdownPct: 60,
});
const status = (pnl: number): PaperStatus => ({
  startingCash: 2.5, cash: 2.5 + pnl, equity: 2.5 + pnl, partial: false, pnl, pnlPct: (pnl / 2.5) * 100, withdrawn: 0,
  buys: 1, sells: 1, feesPaid: 0, positions: [], realizedBySymbol: {}, killed: false, killReason: null,
});

describe('binomialTail', () => {
  it('is the chance of k or more passes if each pass were luck at rate p', () => {
    expect(binomialTail(0, 10, 0.05)).toBeCloseTo(1, 12);
    expect(binomialTail(1, 1, 0.05)).toBeCloseTo(0.05, 12);
    // 5 of 13 markets when luck passes 5%: about 0.3%.
    expect(binomialTail(5, 13, 0.05)).toBeLessThan(0.005);
    expect(binomialTail(1, 13, 0.05)).toBeGreaterThan(0.4);
  });
});

describe('consensusVerdict', () => {
  const vote = (market: string, passed: boolean, luckPassed = false) => ({ market, passed, luckPassed });

  it('approves a strategy that passes on far more markets than luck would', () => {
    const v = consensusVerdict([
      vote('ETH', true), vote('XRP', true), vote('ZEC', true), vote('UNI', true), vote('XLM', true),
      vote('SOL', false), vote('NEAR', false), vote('SUI', false), vote('LINK', false), vote('DOGE', false),
      vote('ADA', false), vote('QNT', false, true),
    ]);
    expect(v.approved).toBe(true);
    expect(v.passes).toBe(5);
    expect(v.voters).toBe(12);
  });

  it('rejects a strategy whose passes are no more than luck produces', () => {
    const v = consensusVerdict([vote('A', true), vote('B', false), vote('C', false), vote('D', false), vote('E', false)]);
    expect(v.approved).toBe(false);
  });

  it('raises the bar when shuffled markets pass too, since that is what luck looks like here', () => {
    const lucky = [vote('A', true, true), vote('B', true, true), vote('C', true, true), vote('D', false, true), vote('E', false)];
    expect(consensusVerdict(lucky).approved).toBe(false);
  });

  it('needs a quorum: one or two markets cannot speak for a strategy', () => {
    expect(consensusVerdict([vote('A', true), vote('B', true)]).approved).toBe(false);
  });

  it('counts each market once', () => {
    expect(consensusVerdict([vote('A', true), vote('A', true), vote('A', true)]).voters).toBe(1);
  });
});

describe('demotionReason', () => {
  const lucky = { passed: true, luckPassed: true, reason: 'efficiency 0.9' };
  const good = { passed: true, luckPassed: false, reason: 'efficiency 0.9' };

  it('demotes a trader whose pass also shows up on shuffled data — it was luck', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(0.1), ageMs: DAY, validation: lucky }, null, null);
    expect(r).toMatch(/passes on shuffled prices too/);
  });

  it('demotes a trader whose strategy has lost the fleet\'s consensus', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(0.1), ageMs: DAY, validation: good }, null,
      { approved: false, passes: 1, voters: 8, luckRate: 0.05, pValue: 0.34 });
    expect(r).toMatch(/lost the fleet's consensus/);
  });

  it('keeps a validated, consensus-approved trader through its trial', () => {
    expect(demotionReason({ spec: spec('trend-hold'), status: status(-0.1), ageMs: DAY, validation: good }, 5,
      { approved: true, passes: 5, voters: 12, luckRate: 0.05, pValue: 0.003 })).toBeNull();
  });

  it('demotes a trader that is not making money after its trial', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(-0.1), ageMs: TRIAL_MS['1d']! + DAY, validation: good }, -10,
      { approved: true, passes: 5, voters: 12, luckRate: 0.05, pValue: 0.003 });
    expect(r).toMatch(/not making money/);
  });
});

describe('promotionVerdict', () => {
  const approved = { approved: true, passes: 5, voters: 12, luckRate: 0.05, pValue: 0.003 };
  const good = { passed: true, luckPassed: false, reason: 'efficiency 0.9' };

  it('promotes a fresh candidate that validates, is not lucky, and has consensus', () => {
    expect(promotionVerdict({ validation: good, consensus: approved, demoted: false, shadow: null })).toEqual({ promote: true, reason: expect.stringMatching(/5 of 12 markets/) });
  });

  it('refuses without consensus, even if it passes on its own market', () => {
    const v = promotionVerdict({ validation: good, consensus: { ...approved, approved: false, pValue: 0.4 }, demoted: false, shadow: null });
    expect(v.promote).toBe(false);
  });

  it('makes a demoted bot prove itself with validator money before it trades again', () => {
    const young = promotionVerdict({ validation: good, consensus: approved, demoted: true, shadow: { pnl: 0.3, ageMs: DAY } });
    expect(young).toEqual({ promote: false, reason: expect.stringMatching(/trial/) });
    const losing = promotionVerdict({ validation: good, consensus: approved, demoted: true, shadow: { pnl: -0.1, ageMs: 40 * DAY } });
    expect(losing.promote).toBe(false);
    const proven = promotionVerdict({ validation: good, consensus: approved, demoted: true, shadow: { pnl: 0.3, ageMs: 40 * DAY } });
    expect(proven.promote).toBe(true);
  });
});

describe('fleet status with validators', () => {
  it('lists validators with their validator-money record and the fleet\'s consensus', () => {
    const v = { spec: spec('trend-hold', 'SOL/USD'), shadow: status(0.4), demoted: true, note: 'efficiency -0.38 < 0.5: curve fit' };
    const text = formatFleetStatus([], {
      added: 0, queued: 0, profit: 0, needed: 2.5, validators: [v],
      consensus: { 'trend-hold@1d': { approved: true, passes: 5, voters: 12, luckRate: 0.05, pValue: 0.002 } },
    });
    expect(text).toMatch(/VALIDATORS/);
    expect(text).toMatch(/trend-hold SOL\/USD 1d +\+\$0\.40  demoted: efficiency -0\.38/);
    expect(text).toMatch(/trend-hold@1d +WORTHY: 5 of 12 markets/);
  });
});
