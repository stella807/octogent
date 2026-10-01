import { describe, expect, it } from 'vitest';
import { alignNetflow } from '../src/data/arkham.ts';
import { coinMetricsAsset, exchangeNetflow, fetchExchangeNetflow, parseFlows } from '../src/data/coinmetrics.ts';

const DAY = 86_400_000;
const row = (day: string, inflow: string, outflow: string) =>
  ({ asset: 'btc', time: `${day}T00:00:00.000000000Z`, FlowInExUSD: inflow, FlowOutExUSD: outflow });

describe('parseFlows', () => {
  it('reads dollar strings into per-day inflow and outflow', () => {
    const flows = parseFlows({ data: [row('2024-01-01', '1000000.5', '400000')] });
    expect(flows).toEqual([{ day: Date.UTC(2024, 0, 1), inflow: 1_000_000.5, outflow: 400_000 }]);
  });

  it('skips days where either side is missing instead of treating it as zero', () => {
    const flows = parseFlows({
      data: [row('2024-01-01', '5', '3'), { asset: 'btc', time: '2024-01-02T00:00:00.000000000Z', FlowInExUSD: '9' }],
    });
    expect(flows.map((f) => f.day)).toEqual([Date.UTC(2024, 0, 1)]);
  });

  it('rejects an unexpected body naming what arrived', () => {
    expect(() => parseFlows({ error: { message: 'nope' } })).toThrow(/nope/);
    expect(() => parseFlows('html')).toThrow(/unexpected/);
    expect(() => parseFlows({ data: [row('2024-01-01', 'abc', '3')] })).toThrow(/FlowInExUSD/);
  });
});

describe('exchangeNetflow', () => {
  it('is inflow minus outflow: positive means coins moved onto exchanges', () => {
    const { flows, covered } = exchangeNetflow([
      { day: 0, inflow: 10, outflow: 4 },
      { day: DAY, inflow: 2, outflow: 7 },
    ]);
    expect(flows.get(0)).toBe(6);
    expect(flows.get(DAY)).toBe(-5);
    expect(covered).toEqual({ from: 0, to: 2 * DAY });
  });

  it('feeds the same prior-day alignment the Arkham signal uses', () => {
    const { flows, covered } = exchangeNetflow([{ day: 0, inflow: 10, outflow: 4 }, { day: DAY, inflow: 1, outflow: 1 }]);
    const candles = [0, DAY, 2 * DAY, 3 * DAY].map((time) => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    // A bar sees yesterday's flow only; before the data and after it, nothing is known.
    expect(alignNetflow(candles, flows, covered)).toEqual([null, 6, 0, null]);
  });
});

describe('fetchExchangeNetflow', () => {
  it('follows next-page links and joins the pages', async () => {
    const pages: Record<string, unknown> = {
      first: { data: [row('2024-01-01', '5', '3')], next_page_url: 'second' },
      second: { data: [row('2024-01-02', '8', '1')] },
    };
    const urls: string[] = [];
    const fetcher = async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, json: async () => pages[url.includes('second') ? 'second' : 'first'] };
    };
    const result = await fetchExchangeNetflow('btc', { fetcher, startTime: '2024-01-01', baseUrl: 'first' });
    expect([...result.flows.keys()]).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2)]);
    expect(urls).toHaveLength(2);
  });

  it('fails on an HTTP error rather than returning an empty signal', async () => {
    const fetcher = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(fetchExchangeNetflow('btc', { fetcher, startTime: '2024-01-01' })).rejects.toThrow(/429/);
  });
});

describe('coinMetricsAsset', () => {
  it('maps a trading pair to the free tier assets that publish exchange flows, and refuses the rest', () => {
    expect(coinMetricsAsset('BTC/USD')).toBe('btc');
    expect(coinMetricsAsset('ETH/USD')).toBe('eth');
    expect(() => coinMetricsAsset('DOGE/USD')).toThrow(/only BTC and ETH/);
  });
});
