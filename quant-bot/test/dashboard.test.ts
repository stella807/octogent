import { describe, expect, it } from 'vitest';
import { assembleDashboard, snapshotCoin } from '../src/dashboard/build.ts';
import { generateCandles } from '../src/data/synthetic.ts';
import { DEFAULT_SWARM } from '../src/swarm/swarm.ts';

const FAST = { ...DEFAULT_SWARM, paths: 50 };

describe('dashboard snapshot', () => {
  it('reports price, forecast and track record for a coin with enough history', () => {
    const candles = generateCandles({ bars: 900, seed: 3 });
    const snap = snapshotCoin('SYN/USD', candles, undefined, null, FAST);
    expect(snap?.last).toBe(candles[candles.length - 1]?.close);
    expect(snap?.spark).toHaveLength(90);
    expect(snap?.forecast?.pUp).toBeGreaterThanOrEqual(0);
    expect(snap?.forecast?.pUp).toBeLessThanOrEqual(1);
    expect(snap?.track?.n).toBeGreaterThan(30);
    expect(['skill', 'none', 'worse']).toContain(snap?.track?.verdict);
  });

  it('shows a young coin without inventing a forecast or a track record', () => {
    const snap = snapshotCoin('NEW/USD', generateCandles({ bars: 120, seed: 4 }), undefined, null, FAST);
    expect(snap?.last).toBeGreaterThan(0);
    expect(snap?.forecast).toBeNull();
    expect(snap?.track).toBeNull();
  });

  it('counts skill against what chance alone would produce', () => {
    const coins = [1, 2, 3].map((s) => snapshotCoin(`C${s}/USD`, generateCandles({ bars: 900, seed: s }), undefined, null, FAST)!);
    const d = assembleDashboard({
      generatedAt: new Date(0), exchange: 'coinbase', strategy: 'donchian-breakout', coins, screenRows: [], luck: null, paper: null,
    });
    expect(d.summary.forecastable).toBe(3);
    expect(d.summary.skilledByChance).toBeCloseTo(3 * 0.0228, 1);
    expect(d.generatedAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('dashboard page', () => {
  it('embeds the data so the page opens from disk, and cannot be broken out of its script tag', async () => {
    const { renderDashboardPage } = await import('../src/dashboard/build.ts');
    const template = '<title>Market Eye</title><script type="application/json">__DASHBOARD_DATA__</script>';
    const d = assembleDashboard({
      generatedAt: new Date(0), exchange: 'coinbase', strategy: '</script><b>x', coins: [], screenRows: [], luck: null, paper: null,
    });
    const page = renderDashboardPage(template, d, true);
    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).not.toContain('</script><b>');
    const json = page.slice(page.indexOf('>', page.indexOf('application/json')) + 1, page.lastIndexOf('</script>'));
    expect(JSON.parse(json).strategy).toBe('</script><b>x');
    expect(renderDashboardPage(template, d, false).startsWith('<title>')).toBe(true);
  });
});
