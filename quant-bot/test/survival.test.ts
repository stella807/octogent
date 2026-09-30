import { describe, expect, it } from 'vitest';
import { demotionReason, formatFleetStatus, isControl, planCoreFleet, planFleet, planReserve, sameTrade, TRIAL_MS, type BotSpec } from '../src/live/fleet.ts';
import type { PaperStatus } from '../src/live/status.ts';

const DAY = 86_400_000;
const spec = (strategy: string, timeframe: '1d' | '1m' = '1d'): BotSpec => ({
  name: `x-${strategy}`, group: 'g', strategy, symbols: ['BTC/USD'], timeframe, equity: 2.5, feeBps: 60, maxDrawdownPct: 60,
});
const status = (pnl: number, over: Partial<PaperStatus> = {}): PaperStatus => ({
  startingCash: 2.5, cash: 2.5 + pnl, equity: 2.5 + pnl, partial: false, pnl, pnlPct: (pnl / 2.5) * 100, withdrawn: 0,
  buys: 1, sells: 1, feesPaid: 0, positions: [], realizedBySymbol: {}, killed: false, killReason: null, ...over,
});
const passed = { passed: true, luckPassed: false, reason: 'efficiency 0.67' };

describe('isControl', () => {
  it('treats the coin flip and buy-and-hold as yardsticks, not contestants', () => {
    expect(isControl('coin-flip')).toBe(true);
    expect(isControl('buy-and-hold')).toBe(true);
    expect(isControl('trend-hold')).toBe(false);
  });
});

describe('demotionReason (the old death rules, now demotion to validator)', () => {
  const young = 1 * DAY;
  const old = 31 * DAY;

  it('never demotes a control, however badly it does', () => {
    expect(demotionReason({ spec: spec('coin-flip'), status: status(-2, { killed: true, killReason: 'x' }), ageMs: old, validation: null }, null, null)).toBeNull();
  });

  it('kills a bot whose strategy no longer passes validation', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(0.5), ageMs: young, validation: { passed: false, luckPassed: false, reason: 'efficiency 0.2 < 0.5' } }, null, null);
    expect(r).toMatch(/failed validation: efficiency 0\.2/);
  });

  it('kills a bot whose kill switch tripped', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(-1.6, { killed: true, killReason: 'drawdown 61%' }), ageMs: young, validation: passed }, null, null);
    expect(r).toMatch(/kill switch/);
  });

  it('kills a bot that can no longer place the minimum order', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(-1.6), ageMs: young, validation: passed }, null, null);
    expect(r).toMatch(/too small to trade/);
  });

  it('gives a losing bot its full trial before judging it', () => {
    expect(demotionReason({ spec: spec('trend-hold'), status: status(-0.3), ageMs: young, validation: passed }, -1, null)).toBeNull();
  });

  it('after the trial, demotes a bot that lost money', () => {
    const r = demotionReason({ spec: spec('trend-hold'), status: status(-0.3), ageMs: old, validation: passed }, -2, null);
    expect(r).toMatch(/not making money after its trial.*coin flip: -2\.0%/);
  });

  it('demotes a losing bot even when it beat the coin flip: it has to make money', () => {
    expect(demotionReason({ spec: spec('trend-hold'), status: status(-0.3), ageMs: old, validation: passed }, -30, null)).toMatch(/not making money/);
  });

  it('spares a profitable bot even if the coin flip got luckier', () => {
    expect(demotionReason({ spec: spec('trend-hold'), status: status(0.2), ageMs: old, validation: passed }, 40, null)).toBeNull();
  });

  it('judges fast bots over a shorter trial than daily ones', () => {
    expect(TRIAL_MS['1m']!).toBeLessThan(TRIAL_MS['1d']!);
    const r = demotionReason({ spec: spec('tsmom', '1m'), status: status(-0.3), ageMs: 2 * DAY, validation: passed }, -1, null);
    expect(r).toMatch(/not making money/);
  });
});

describe('fleet status after demotions', () => {
  it('counts the treasury and measures profit against the budget, so dead bots\' losses still show', () => {
    const text = formatFleetStatus(
      [{ spec: spec('trend-hold'), status: status(0.5) }],
      { added: 0, queued: 5, profit: -1.2, needed: 3.7, treasury: 1.3, rejected: 2,
        dead: [{ name: 'fast-tsmom-btcusd', at: 'x', reason: 'failed validation: lost 3% out of sample', returned: 1.3 }] },
    );
    expect(text).toMatch(/ALL BOTS  \$4\.30 now \(\$3\.00 in bots \+ \$1\.30 treasury\), profit -\$1\.20/);
    expect(text).toMatch(/TREASURY  \$1\.30 returned by demoted bots/);
    expect(text).toMatch(/↓ fast-tsmom-btcusd +failed validation/);
  });
});

describe('no duplicate contestants', () => {
  it('never queues a bot that would make exactly the same trades as another', () => {
    const top = ['BTC/USD', 'ETH/USD', 'SOL/USD', ...Array.from({ length: 29 }, (_, i) => `C${i}/USD`)];
    const core = planCoreFleet(2.5);
    const reserve = planReserve(planFleet(top, 2.5), core);
    const all = [...core, ...reserve];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) expect(sameTrade(all[i]!, all[j]!)).toBe(false);
    }
  });
});
