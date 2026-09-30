import { describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import {
  alignNetflow,
  arkhamTokenId,
  dailyExchangeNetflow,
  fetchWhaleTransfers,
  parseTransfers,
  type WhaleTransfer,
} from '../src/data/arkham.ts';
import { trendHoldWhales } from '../src/strategy/trend-hold-whales.ts';
import { walkForward, DEFAULT_WF_OPTIONS } from '../src/backtest/walk-forward.ts';
import { shuffleSeries } from '../src/backtest/screen.ts';

const DAY = 86_400_000;
const entity = (type: string) => ({ arkhamEntity: { id: `${type}-1`, name: type, type } });

describe('parseTransfers', () => {
  it('keeps time, USD value and whether each side is an exchange', () => {
    const body = {
      transfers: [
        { blockTimestamp: '2026-09-01T12:00:00Z', historicalUSD: 2_000_000, fromAddress: entity('fund'), toAddress: entity('cex') },
        { blockTimestamp: 1756728000, historicalUSD: '1500000', fromAddress: entity('cex'), toAddress: { address: '0xabc' } },
      ],
      count: 2,
    };
    const t = parseTransfers(body);
    expect(t).toEqual([
      { time: Date.parse('2026-09-01T12:00:00Z'), usd: 2_000_000, fromExchange: false, toExchange: true },
      { time: 1756728000 * 1000, usd: 1_500_000, fromExchange: true, toExchange: false },
    ]);
  });

  it('skips a transfer it cannot read rather than guessing at it', () => {
    const t = parseTransfers({ transfers: [{ blockTimestamp: 'not a time', historicalUSD: 5 }, { historicalUSD: 5 }] });
    expect(t).toEqual([]);
  });

  it('refuses a response of an unexpected shape, naming what it got', () => {
    expect(() => parseTransfers({ message: 'unauthorized' })).toThrow(/unexpected Arkham response.*message/);
    expect(() => parseTransfers(null)).toThrow(/unexpected Arkham response/);
  });
});

describe('dailyExchangeNetflow', () => {
  const t = (day: number, usd: number, fromExchange: boolean, toExchange: boolean): WhaleTransfer =>
    ({ time: day * DAY + 3_600_000, usd, fromExchange, toExchange });

  it('nets whale money moving onto exchanges against money leaving them, per UTC day', () => {
    const flows = dailyExchangeNetflow([t(10, 5e6, false, true), t(10, 2e6, true, false), t(11, 1e6, true, false)]);
    expect(flows.get(10 * DAY)).toBe(3e6);
    expect(flows.get(11 * DAY)).toBe(-1e6);
  });

  it('ignores exchange-to-exchange shuffles and wallet-to-wallet moves', () => {
    const flows = dailyExchangeNetflow([t(10, 9e6, true, true), t(10, 9e6, false, false)]);
    expect(flows.get(10 * DAY) ?? 0).toBe(0);
  });
});

describe('alignNetflow', () => {
  const candles: Candle[] = [10, 11, 12].map((d) => ({ time: d * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1 }));

  it('gives each bar the prior day\'s flow, never the same day\'s', () => {
    const flows = new Map([[10 * DAY, 7], [11 * DAY, 9]]);
    expect(alignNetflow(candles, flows, { from: 9 * DAY, to: 12 * DAY })).toEqual([0, 7, 9]);
  });

  it('reads a covered day with no whale transfers as zero, and an uncovered day as unknown', () => {
    expect(alignNetflow(candles, new Map(), { from: 10 * DAY, to: 12 * DAY })).toEqual([null, 0, 0]);
  });
});

describe('fetchWhaleTransfers', () => {
  it('sends the key as a header, never in the URL, and pages until a short page', async () => {
    const seen: { url: string; key: string | null }[] = [];
    const page = (n: number) => ({
      transfers: Array.from({ length: n }, (_, i) => ({ blockTimestamp: 1_700_000_000 + i, historicalUSD: 2e6, toAddress: entity('cex') })),
    });
    const fake = async (url: string, init?: { headers?: Record<string, string> }) => {
      seen.push({ url, key: init?.headers?.['API-Key'] ?? null });
      return { ok: true, status: 200, json: async () => page(seen.length === 1 ? 2 : 1) };
    };
    const t = await fetchWhaleTransfers({ tokenId: 'ethereum', since: 0, until: DAY, minUsd: 1e6, apiKey: 'secret', pageSize: 2, fetchImpl: fake });
    expect(t).toHaveLength(3);
    expect(seen).toHaveLength(2);
    expect(seen.every((s) => s.key === 'secret' && !s.url.includes('secret'))).toBe(true);
    expect(seen[0]?.url).toMatch(/tokens=ethereum/);
  });

  it('stops with a clear error instead of returning a silently truncated history', async () => {
    const full = async () => ({ ok: true, status: 200, json: async () => ({ transfers: [{ blockTimestamp: 1, historicalUSD: 2e6 }] }) });
    await expect(fetchWhaleTransfers({ tokenId: 'x', since: 0, until: DAY, minUsd: 1e6, apiKey: 'k', pageSize: 1, maxPages: 3, fetchImpl: full }))
      .rejects.toThrow(/more than 3 pages.*--min-usd/);
  });

  it('says so plainly when the answer is a web page instead of data', async () => {
    const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    await expect(fetchWhaleTransfers({ tokenId: 'x', since: 0, until: DAY, minUsd: 1e6, apiKey: 'k', fetchImpl: html }))
      .rejects.toThrow(/not JSON/);
  });

  it('explains a rejected key without echoing it', async () => {
    const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(fetchWhaleTransfers({ tokenId: 'x', since: 0, until: DAY, minUsd: 1e6, apiKey: 'secret-key', fetchImpl: denied }))
      .rejects.toThrow(/HTTP 401.*ARKHAM_API_KEY/);
    await expect(fetchWhaleTransfers({ tokenId: 'x', since: 0, until: DAY, minUsd: 1e6, apiKey: 'secret-key', fetchImpl: denied }))
      .rejects.not.toThrow(/secret-key/);
  });
});

describe('arkhamTokenId', () => {
  it('maps the fleet\'s coins to Arkham token ids and refuses to guess the rest', () => {
    expect(arkhamTokenId('BTC/USD')).toBe('bitcoin');
    expect(arkhamTokenId('ETH/USD')).toBe('ethereum');
    expect(arkhamTokenId('PEPE/USD')).toBe('pepe');
    expect(() => arkhamTokenId('NOPE/USD')).toThrow(/--arkham-token/);
  });
});

describe('trend-hold-whales', () => {
  // Rising prices: plain trend-hold would be long from the first bar after warmup.
  const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
    const c = 100 * 1.01 ** i;
    return { time: i * DAY, open: c, high: c, low: c, close: c, volume: 1 };
  });
  const params = { period: 10, bandPct: 0, flowDays: 3 };

  it('holds off a new entry while whales are net sending coins to exchanges', () => {
    const selling = candles.map(() => 5e6);
    const s = trendHoldWhales.create(candles, params, { whaleNetflow: selling });
    expect(s.signalAt(30, null).target).toBe(0);
    expect(s.signalAt(30, null).reason).toMatch(/whales/);
  });

  it('enters normally when whales are taking coins off exchanges', () => {
    const accumulating = candles.map(() => -5e6);
    expect(trendHoldWhales.create(candles, params, { whaleNetflow: accumulating }).signalAt(30, null).target).toBe(1);
  });

  it('behaves exactly like trend-hold when there is no whale data', () => {
    expect(trendHoldWhales.create(candles, params).signalAt(30, null).target).toBe(1);
  });
});

describe('walk-forward with a generic context', () => {
  it('slices every context series alongside the candles', () => {
    const candles: Candle[] = Array.from({ length: 400 }, (_, i) => {
      const c = 100 + 10 * Math.sin(i / 15) + i * 0.1;
      return { time: i * DAY, open: c, high: c + 1, low: c - 1, close: c, volume: 1 };
    });
    const whaleNetflow = candles.map((_, i) => (i % 2 === 0 ? 1 : -1));
    expect(() => walkForward(candles, trendHoldWhales, { ...DEFAULT_WF_OPTIONS, context: { whaleNetflow } })).not.toThrow();
  });
});

describe('shuffleSeries', () => {
  it('keeps every value but breaks the link to its day, reproducibly', () => {
    const v = Array.from({ length: 50 }, (_, i) => i);
    const a = shuffleSeries(v, 3);
    expect([...a].sort((x, y) => x - y)).toEqual(v);
    expect(a).not.toEqual(v);
    expect(shuffleSeries(v, 3)).toEqual(a);
  });
});
