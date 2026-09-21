import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.ts';

function capture(): { out: () => string; restore: () => void } {
  let buffer = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    buffer += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    buffer += String(chunk);
    return true;
  });
  return {
    out: () => buffer,
    restore: () => {
      spy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

let captured: ReturnType<typeof capture> | null = null;
afterEach(() => {
  captured?.restore();
  captured = null;
});

describe('cli', () => {
  it('prints usage with no command', async () => {
    captured = capture();
    expect(await main([])).toBe(0);
    expect(captured.out()).toMatch(/backtest/);
  });

  it('reports an unknown command instead of doing something surprising', async () => {
    captured = capture();
    expect(await main(['moon'])).toBe(1);
    expect(captured.out()).toMatch(/unknown command/);
  });

  it('runs a synthetic backtest and reports the loss rate', async () => {
    captured = capture();
    expect(await main(['backtest', '--synthetic', '--bars', '800', '--strategy', 'ema-crossover']))
      .toBe(0);
    const text = captured.out();
    expect(text).toMatch(/LOSS RATE/);
    expect(text).toMatch(/Max drawdown/);
    expect(text).toMatch(/VS BUY-AND-HOLD/);
  });

  it('emits machine-readable metrics with --json', async () => {
    captured = capture();
    await main(['backtest', '--synthetic', '--bars', '800', '--json']);
    const parsed = JSON.parse(captured.out()) as { metrics: { lossRatePct: number } };
    expect(parsed.metrics.lossRatePct).toBeGreaterThanOrEqual(0);
  });

  it('passes --param through to the strategy', async () => {
    captured = capture();
    await main(['backtest', '--synthetic', '--bars', '800', '--strategy', 'ema-crossover',
      '--param', 'fast=5', '--param', 'slow=40']);
    expect(captured.out()).toMatch(/"fast":5/);
    expect(captured.out()).toMatch(/"slow":40/);
  });

  it('rejects a malformed --param rather than defaulting silently', async () => {
    await expect(main(['backtest', '--synthetic', '--param', 'fast'])).rejects.toThrow(/key=value/);
  });

  it('rejects an unsupported timeframe', async () => {
    await expect(main(['backtest', '--synthetic', '--timeframe', '3s']))
      .rejects.toThrow(/unsupported timeframe/);
  });

  it('refuses the live command without the --live flag', async () => {
    await expect(main(['live', '--strategy', 'ema-crossover'])).rejects.toThrow(/--live flag/);
  });

  it('runs walkforward end to end', async () => {
    captured = capture();
    expect(await main(['walkforward', '--synthetic', '--bars', '3000', '--folds', '3'])).toBe(0);
    expect(captured.out()).toMatch(/Walk-forward efficiency/);
  });

  it('runs montecarlo end to end', async () => {
    captured = capture();
    expect(await main(['montecarlo', '--synthetic', '--bars', '2000',
      '--strategy', 'ema-crossover', '--runs', '200'])).toBe(0);
    expect(captured.out()).toMatch(/P\(ending below start\)/);
  });
});
