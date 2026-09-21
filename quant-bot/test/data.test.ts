import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/data/csv.ts';
import { generateCandles } from '../src/data/synthetic.ts';

describe('parseCsv', () => {
  it('accepts a header row and epoch-second timestamps', () => {
    const candles = parseCsv(`timestamp,open,high,low,close,volume
1704067200,100,110,90,105,12.5
1704153600,105,115,95,110,9`);
    expect(candles).toHaveLength(2);
    expect(candles[0]?.time).toBe(1_704_067_200_000);
    expect(candles[1]?.close).toBe(110);
  });

  it('accepts millisecond and ISO timestamps', () => {
    const ms = parseCsv('1704067200000,1,2,0.5,1.5,1');
    const iso = parseCsv('2024-01-01T00:00:00Z,1,2,0.5,1.5,1');
    expect(ms[0]?.time).toBe(iso[0]?.time);
  });

  it('sorts out-of-order rows so the engine never sees them backwards', () => {
    const candles = parseCsv(`1704153600,2,3,1,2,1
1704067200,1,2,0.5,1,1`);
    expect(candles[0]?.time).toBeLessThan(candles[1]?.time ?? 0);
  });

  it('rejects a row whose high is below its open, which would fake stop fills', () => {
    expect(() => parseCsv('1704067200,100,99,90,95,1')).toThrow(/inconsistent OHLC/);
  });

  it('rejects a row whose low is above its close', () => {
    expect(() => parseCsv('1704067200,100,110,101,100,1')).toThrow(/inconsistent OHLC/);
  });

  it('rejects non-numeric prices instead of silently producing NaN', () => {
    expect(() => parseCsv('1704067200,100,110,90,abc,1')).toThrow(/not a finite number/);
  });

  it('rejects short rows', () => {
    expect(() => parseCsv('1704067200,100,110,90')).toThrow(/expected 6 columns/);
  });

  it('ignores blank lines and comments', () => {
    const candles = parseCsv(`# exported from somewhere

1704067200,100,110,90,105,1
`);
    expect(candles).toHaveLength(1);
  });
});

describe('generateCandles', () => {
  it('is reproducible for a seed', () => {
    expect(generateCandles({ bars: 50, seed: 3 })).toEqual(generateCandles({ bars: 50, seed: 3 }));
  });

  it('produces internally consistent OHLC bars', () => {
    for (const c of generateCandles({ bars: 2000, seed: 5 })) {
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
      expect(c.low).toBeLessThanOrEqual(Math.min(c.open, c.close));
      expect(c.low).toBeGreaterThan(0);
    }
  });

  it('advances time by exactly one bar interval', () => {
    const candles = generateCandles({ bars: 10, timeframe: '1h' });
    for (let i = 1; i < candles.length; i += 1) {
      expect((candles[i]?.time ?? 0) - (candles[i - 1]?.time ?? 0)).toBe(3_600_000);
    }
  });

  it('contains both up and down regimes, so strategies meet a bear market', () => {
    const candles = generateCandles({ bars: 2000, seed: 5 });
    const first = candles[0]?.close ?? 0;
    const closes = candles.map((c) => c.close);
    expect(Math.max(...closes)).toBeGreaterThan(first);
    expect(Math.min(...closes)).toBeLessThan(first);
  });
});
