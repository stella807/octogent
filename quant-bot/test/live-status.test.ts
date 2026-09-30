import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_STATE, EMPTY_SYMBOL_STATE } from '../src/live/state-store.ts';
import { formatLiveStatus, liveBaselinePath, liveStatus } from '../src/live/status.ts';
import { readLiveBaseline, recordLiveBaseline } from '../src/live/baseline.ts';
import { readAccount, type AccountReader } from '../src/live/exchange-broker.ts';

const reader = (total: Record<string, number>, tickers: Record<string, number>): AccountReader => ({
  fetchBalance: async () => ({ total }),
  fetchTicker: async (symbol: string) => {
    const last = tickers[symbol];
    if (last === undefined) throw new Error(`no market ${symbol}`);
    return { last };
  },
});

describe('readAccount', () => {
  it('prices every coin held in the quote currency and counts cash at par', async () => {
    const snap = await readAccount(reader({ USD: 20, BTC: 0.001, CRO: 0 }, { 'BTC/USD': 60_000 }), 'USD');
    expect(snap.balances).toEqual({ USD: 20, BTC: 0.001 });
    expect(snap.prices).toEqual({ USD: 1, BTC: 60_000 });
  });

  it('counts USDC at par on a USD account instead of failing to price it', async () => {
    const snap = await readAccount(reader({ USD: 1, USDC: 4 }, {}), 'USD');
    expect(snap.prices['USDC']).toBe(1);
  });

  it('says the key was rejected instead of passing through a bare 401', async () => {
    class AuthenticationError extends Error {}
    const rejecting: AccountReader = {
      fetchBalance: async () => { throw new AuthenticationError('401 Unauthorized'); },
      fetchTicker: async () => ({}),
    };
    await expect(readAccount(rejecting, 'USD')).rejects.toThrow(/rejected the API key/);
  });

  it('marks a coin with no market as unpriced rather than zero', async () => {
    const snap = await readAccount(reader({ USD: 5, DELISTED: 100 }, {}), 'USD');
    expect(snap.prices['DELISTED']).toBeNull();
  });
});

describe('live status', () => {
  const baseline = { startingEquity: 25, quote: 'USD', startedAt: '2026-09-30T00:00:00.000Z' };

  it('reports real equity and profit against the recorded starting balance', () => {
    const state = {
      ...EMPTY_STATE,
      symbols: { 'CRO/USD': { ...EMPTY_SYMBOL_STATE, entryPrice: 0.1, stopPrice: 0.09 } },
    };
    const s = liveStatus({ USD: 20, CRO: 60 }, { USD: 1, CRO: 0.11 }, 'USD', state, baseline);
    expect(s.cash).toBe(20);
    expect(s.equity).toBeCloseTo(26.6, 9);
    expect(s.pnl).toBeCloseTo(1.6, 9);
    expect(s.pnlPct).toBeCloseTo(6.4, 9);
    const cro = s.holdings.find((h) => h.asset === 'CRO');
    expect(cro?.botManaged).toBe(true);
    expect(cro?.unrealized).toBeCloseTo(0.6, 9);
    expect(formatLiveStatus(s)).toMatch(/REAL ACCOUNT/);
  });

  it('shows no profit figure when the bot has never recorded a starting balance', () => {
    const s = liveStatus({ USD: 25 }, { USD: 1 }, 'USD', { ...EMPTY_STATE }, null);
    expect(s.pnl).toBeNull();
    expect(formatLiveStatus(s)).toMatch(/no starting balance recorded/i);
  });

  it('flags coins it could not price instead of counting them as zero', () => {
    const s = liveStatus({ USD: 5, ODD: 3 }, { USD: 1, ODD: null }, 'USD', { ...EMPTY_STATE }, baseline);
    expect(s.partial).toBe(true);
    expect(s.equity).toBe(5);
    expect(formatLiveStatus(s)).toMatch(/could not be priced/);
  });

  it('keeps the baseline next to the live runner state', () => {
    expect(liveBaselinePath('.quant-bot/live-state.json')).toBe(join('.quant-bot', 'live-baseline.json'));
  });
});

describe('live baseline file', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qb-baseline-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('records the first start only, so a restart cannot reset profit to zero', async () => {
    const path = join(dir, 'live-baseline.json');
    const first = await recordLiveBaseline(path, 25, 'USD', new Date('2026-09-30T00:00:00Z'));
    const again = await recordLiveBaseline(path, 19, 'USD', new Date('2026-10-01T00:00:00Z'));
    expect(first.startingEquity).toBe(25);
    expect(again.startingEquity).toBe(25);
    expect((await readLiveBaseline(path))?.startedAt).toBe('2026-09-30T00:00:00.000Z');
  });

  it('reads a missing file as no baseline', async () => {
    expect(await readLiveBaseline(join(dir, 'nope.json'))).toBeNull();
  });
});
