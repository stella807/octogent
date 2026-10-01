import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addForecast, brier, formatForecasts, loadForecasts, resolveForecast, saveForecasts, scoreForecasts, type Forecast,
} from '../src/research/forecast-log.ts';

const base = { id: 'a', question: 'Does Tulsa win?', outcome: 'Tulsa wins', p: 0.52, market: 0.465, marketSource: 'Polymarket', eventTime: '2026-10-02T01:00:00Z' };

describe('brier', () => {
  it('is the squared error between the probability and what happened', () => {
    expect(brier(0.5, 1)).toBe(0.25);
    expect(brier(1, 1)).toBe(0);
    expect(brier(0.8, 0)).toBeCloseTo(0.64, 12);
  });
});

describe('addForecast', () => {
  it('stores the probability and the market price side by side, unresolved', () => {
    const list = addForecast([], base, '2026-10-01T17:00:00Z');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'a', p: 0.52, market: 0.465, result: null, loggedAt: '2026-10-01T17:00:00Z' });
  });

  it('refuses a duplicate id, an impossible probability, and a missing field', () => {
    const list = addForecast([], base, 'x');
    expect(() => addForecast(list, base, 'x')).toThrow(/already/);
    expect(() => addForecast([], { ...base, id: 'b', p: 1.2 }, 'x')).toThrow(/between 0 and 1/);
    expect(() => addForecast([], { ...base, id: 'b', market: 0 }, 'x')).toThrow(/between 0 and 1/);
    expect(() => addForecast([], { ...base, id: 'b', question: '' }, 'x')).toThrow(/question/);
  });

  it('does not change the list it was given', () => {
    const empty: Forecast[] = [];
    addForecast(empty, base, 'x');
    expect(empty).toHaveLength(0);
  });
});

describe('resolveForecast', () => {
  it('records what happened once, and refuses to rewrite it', () => {
    const list = addForecast([], base, 'x');
    const done = resolveForecast(list, 'a', true, '2026-10-02T05:00:00Z');
    expect(done[0]).toMatchObject({ result: 1, resolvedAt: '2026-10-02T05:00:00Z' });
    expect(() => resolveForecast(done, 'a', false, 'y')).toThrow(/already resolved/);
    expect(() => resolveForecast(list, 'zzz', true, 'y')).toThrow(/no forecast/);
  });
});

describe('scoreForecasts', () => {
  it('compares my Brier score with the market\'s on the resolved forecasts only', () => {
    let list = addForecast([], base, 'x');
    list = addForecast(list, { ...base, id: 'b', p: 0.64, market: 0.655, outcome: 'Chiefs win' }, 'x');
    list = resolveForecast(list, 'a', true, 'y');
    const s = scoreForecasts(list);
    expect(s.resolved).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.mine).toBeCloseTo((1 - 0.52) ** 2, 12);
    expect(s.market).toBeCloseTo((1 - 0.465) ** 2, 12);
    expect(s.mineBeatMarket).toBe(1);
  });

  it('says nothing about skill without resolved forecasts', () => {
    const s = scoreForecasts(addForecast([], base, 'x'));
    expect(s.resolved).toBe(0);
    expect(s.mine).toBeNull();
  });
});

describe('formatForecasts', () => {
  it('warns that a handful of forecasts cannot show skill', () => {
    const list = resolveForecast(addForecast([], base, 'x'), 'a', true, 'y');
    const text = formatForecasts(list);
    expect(text).toMatch(/Tulsa wins/);
    expect(text).toMatch(/too few|cannot show skill|luck/i);
  });
});

describe('persistence', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qb-forecast-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('round-trips through disk and starts empty', async () => {
    const path = join(dir, 'forecasts.json');
    expect(await loadForecasts(path)).toEqual([]);
    const list = addForecast([], base, 'x');
    await saveForecasts(path, list);
    expect(await loadForecasts(path)).toEqual(list);
  });
});
