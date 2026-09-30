import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../src/domain/types.ts';
import { DEFAULT_COSTS, FRICTIONLESS } from '../src/backtest/costs.ts';
import { PaperBroker } from '../src/live/paper-broker.ts';
import { paperAccountPath, paperStatus, formatPaperStatus } from '../src/live/status.ts';
import { EMPTY_STATE, EMPTY_SYMBOL_STATE } from '../src/live/state-store.ts';
import { dropFormingBar, LiveRunner } from '../src/live/runner.ts';
import { StateStore } from '../src/live/state-store.ts';
import { ExchangeBroker, LIVE_CONFIRM_ENV, type CcxtClient } from '../src/live/exchange-broker.ts';
import { NoopNotifier, TelegramNotifier, type Notifier } from '../src/live/notifier.ts';
import { DEFAULT_LIMITS, BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';
import { buyAndHold } from '../src/strategy/index.ts';
import { OrderRejectedError, type Broker, type Fill } from '../src/live/broker.ts';

const HOUR = 3_600_000;

function series(closes: number[], startTime: number): Candle[] {
  return closes.map((close, i) => ({
    time: startTime + i * HOUR,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1,
  }));
}

describe('PaperBroker', () => {
  const feed = async (): Promise<Candle[]> => series([100, 100], 0);

  it('conserves value across a round trip at zero cost', async () => {
    const broker = new PaperBroker({ startingCash: 1_000, costs: FRICTIONLESS, feed });
    await broker.marketBuy('BTC/USDT', 500);
    const held = (await broker.balance('BTC/USDT')).qty;
    await broker.marketSell('BTC/USDT', held);
    const after = await broker.balance('BTC/USDT');
    expect(after.cash).toBeCloseTo(1_000, 6);
    expect(after.qty).toBeCloseTo(0, 12);
  });

  it('loses exactly the round-trip cost when fees and slippage apply', async () => {
    const broker = new PaperBroker({ startingCash: 1_000, costs: DEFAULT_COSTS, feed });
    await broker.marketBuy('BTC/USDT', 1_000);
    await broker.marketSell('BTC/USDT', (await broker.balance('BTC/USDT')).qty);
    const after = await broker.balance('BTC/USDT');
    expect(after.cash).toBeLessThan(1_000);
    expect(after.cash).toBeGreaterThan(960);
  });

  it('never spends more than the available cash', async () => {
    const broker = new PaperBroker({ startingCash: 100, costs: FRICTIONLESS, feed });
    await broker.marketBuy('BTC/USDT', 10_000);
    expect((await broker.balance('BTC/USDT')).cash).toBeCloseTo(0, 9);
  });

  it('refuses to sell a position it does not hold', async () => {
    const broker = new PaperBroker({ startingCash: 100, costs: FRICTIONLESS, feed });
    await expect(broker.marketSell('BTC/USDT', 1)).rejects.toThrow(/no BTC\/USDT position/);
  });

  it('reports itself as not live, which the runner announces', () => {
    expect(new PaperBroker({ startingCash: 1, costs: FRICTIONLESS, feed }).isLive).toBe(false);
  });
});

describe('PaperBroker persistence', () => {
  const feed = async (): Promise<Candle[]> => series([100, 100], 0);
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'quant-bot-paper-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('survives a restart with cash, holdings and fill history intact', async () => {
    const accountPath = join(dir, 'paper-account.json');
    const first = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed, accountPath });
    await first.marketBuy('BTC/USD', 10);

    // A new process, even one launched with a different --equity, resumes
    // the saved account rather than re-funding it.
    const restarted = new PaperBroker({ startingCash: 1_000, costs: FRICTIONLESS, feed, accountPath });
    const balance = await restarted.balance('BTC/USD');
    expect(balance.cash).toBeCloseTo(15, 9);
    expect(balance.qty).toBeCloseTo(0.1, 9);
    expect(restarted.fills).toHaveLength(1);

    await restarted.marketSell('BTC/USD', balance.qty);
    const saved = JSON.parse(await readFile(accountPath, 'utf8')) as { startingCash: number; fills: unknown[] };
    expect(saved.startingCash).toBe(25);
    expect(saved.fills).toHaveLength(2);
  });

  it('writes the opening balance before any trade, so status works immediately', async () => {
    const accountPath = join(dir, 'paper-account.json');
    await new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed, accountPath }).balance('BTC/USD');
    const saved = JSON.parse(await readFile(accountPath, 'utf8')) as { cash: number; fills: unknown[] };
    expect(saved.cash).toBe(25);
    expect(saved.fills).toHaveLength(0);
  });

  it('keeps each symbol\'s holdings separate on one shared cash balance', async () => {
    const accountPath = join(dir, 'paper-account.json');
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed, accountPath });
    await broker.marketBuy('BTC/USD', 10);
    await broker.marketBuy('ETH/USD', 5);
    expect(await broker.balance('BTC/USD')).toEqual({ cash: 10, qty: 0.1 });
    expect((await broker.balance('ETH/USD')).qty).toBeCloseTo(0.05, 9);
    expect((await broker.balance('SOL/USD')).qty).toBe(0);
    const saved = JSON.parse(await readFile(accountPath, 'utf8')) as { holdings: Record<string, number> };
    expect(Object.keys(saved.holdings).sort()).toEqual(['BTC/USD', 'ETH/USD']);
  });

  it('refuses orders under the exchange minimum, exactly as the backtester does', async () => {
    const broker = new PaperBroker({ startingCash: 25, costs: DEFAULT_COSTS, feed });
    await expect(broker.marketBuy('BTC/USD', 0.5)).rejects.toBeInstanceOf(OrderRejectedError);
    expect((await broker.balance('BTC/USD')).cash).toBe(25);
  });

  it('prices a thin market from its latest trade, not just the last two minutes', async () => {
    // Only trades 40 minutes ago: no candle at all in the last two minutes.
    const thin = async (): Promise<Candle[]> => series([80, 90], 0);
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: thin });
    expect(await broker.lastPrice('CRO/USD')).toBe(90);
    let asked = 0;
    const counting = async (_s: string, _t: Timeframe, bars: number): Promise<Candle[]> => {
      asked = bars;
      return series([1], 0);
    };
    await new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: counting }).lastPrice('CRO/USD');
    expect(asked).toBeGreaterThanOrEqual(60);
  });

  it('keeps the old in-memory behaviour when no account path is given', async () => {
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed });
    await broker.marketBuy('BTC/USD', 10);
    expect((await broker.balance('BTC/USD')).cash).toBeCloseTo(15, 9);
  });
});

describe('ExchangeBroker balances', () => {
  const original = process.env[LIVE_CONFIRM_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_CONFIRM_ENV];
    else process.env[LIVE_CONFIRM_ENV] = original;
  });

  it('reads cash in the quote currency of the symbol traded, not a fixed USDT', async () => {
    process.env[LIVE_CONFIRM_ENV] = 'yes-i-accept-the-risk';
    const unused = async (): Promise<never> => { throw new Error('not used in this test'); };
    const client: CcxtClient = {
      fetchBalance: async () => ({ free: { USD: 25, USDT: 0, BTC: 0.001 } }),
      fetchTicker: unused,
      fetchOHLCV: unused,
      createMarketBuyOrder: unused,
      createMarketSellOrder: unused,
    };
    const broker = new ExchangeBroker({ exchange: 'coinbase', apiKey: 'k', secret: 's', client });
    expect(await broker.balance('BTC/USD')).toEqual({ cash: 25, qty: 0.001 });
  });
});

describe('paper status', () => {
  const fill = (symbol: string, side: 'buy' | 'sell', qty: number, price: number): Fill =>
    ({ symbol, side, qty, price, fee: 0, time: 0 });
  const account = (cash: number, holdings: Record<string, number>, fills: Fill[] = []) =>
    ({ startingCash: 25, cash, holdings, fills });
  const stateWith = (entries: Record<string, { entryPrice: number; stopPrice?: number }>) => ({
    ...EMPTY_STATE,
    symbols: Object.fromEntries(Object.entries(entries).map(([sym, e]) =>
      [sym, { ...EMPTY_SYMBOL_STATE, entryPrice: e.entryPrice, stopPrice: e.stopPrice ?? null }])),
  });

  it('reports profit on a flat account from cash alone', () => {
    const s = paperStatus(account(27.5, {}), { ...EMPTY_STATE }, {});
    expect(s.pnl).toBeCloseTo(2.5, 9);
    expect(s.pnlPct).toBeCloseTo(10, 9);
    expect(s.positions).toHaveLength(0);
  });

  it('marks every open position to its own price', () => {
    const s = paperStatus(
      account(5, { 'BTC/USD': 0.1, 'ETH/USD': 0.05 }),
      stateWith({ 'BTC/USD': { entryPrice: 100, stopPrice: 90 }, 'ETH/USD': { entryPrice: 200 } }),
      { 'BTC/USD': 110, 'ETH/USD': 180 },
    );
    expect(s.equity).toBeCloseTo(5 + 11 + 9, 9);
    const btc = s.positions.find((p) => p.symbol === 'BTC/USD');
    const eth = s.positions.find((p) => p.symbol === 'ETH/USD');
    expect(btc?.unrealized).toBeCloseTo(1, 9);
    expect(eth?.unrealized).toBeCloseTo(-1, 9);
    expect(formatPaperStatus(s)).toMatch(/OPEN POSITIONS \(2\)/);
  });

  it('says so instead of guessing when a price is unavailable', () => {
    const s = paperStatus(account(15, { 'BTC/USD': 0.1 }), stateWith({ 'BTC/USD': { entryPrice: 100 } }), {
      'BTC/USD': null,
    });
    expect(s.partial).toBe(true);
    expect(s.positions[0]?.unrealized).toBeNull();
    expect(formatPaperStatus(s)).toMatch(/carried at entry price/);
    expect(s.equity).toBeCloseTo(15 + 0.1 * 100, 9);
    expect(s.pnl).toBeCloseTo(0, 9);
  });

  it('totals closed round trips per symbol', () => {
    const s = paperStatus(account(26, {}, [
      fill('BTC/USD', 'buy', 0.1, 100), fill('BTC/USD', 'sell', 0.1, 120),
      fill('ETH/USD', 'buy', 0.05, 200), fill('ETH/USD', 'sell', 0.05, 180),
    ]), { ...EMPTY_STATE }, {});
    expect(s.realizedBySymbol['BTC/USD']).toBeCloseTo(2, 9);
    expect(s.realizedBySymbol['ETH/USD']).toBeCloseTo(-1, 9);
  });

  it('keeps the account next to the runner state', () => {
    expect(paperAccountPath('.quant-bot/runner-state.json')).toBe(join('.quant-bot', 'paper-account.json'));
  });
});

describe('ExchangeBroker safety gate', () => {
  const original = process.env[LIVE_CONFIRM_ENV];
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_CONFIRM_ENV];
    else process.env[LIVE_CONFIRM_ENV] = original;
  });

  it('refuses to construct without the confirmation environment variable', () => {
    delete process.env[LIVE_CONFIRM_ENV];
    expect(() => ExchangeBroker.fromEnv('binance')).toThrow(/Refusing to trade live/);
  });

  it('refuses a wrong confirmation value', () => {
    process.env[LIVE_CONFIRM_ENV] = 'yes';
    expect(() => ExchangeBroker.fromEnv('binance')).toThrow(/Refusing to trade live/);
  });

  it('still refuses without credentials once confirmed', () => {
    process.env[LIVE_CONFIRM_ENV] = 'yes-i-accept-the-risk';
    delete process.env['QUANT_BOT_API_KEY'];
    delete process.env['QUANT_BOT_API_SECRET'];
    expect(() => ExchangeBroker.fromEnv('binance')).toThrow(/API credentials/);
  });
});

describe('NoopNotifier', () => {
  it('resolves without doing anything', async () => {
    await expect(NoopNotifier.notify('anything')).resolves.toBeUndefined();
  });
});

describe('TelegramNotifier', () => {
  it('POSTs the chat id and text to the Telegram API', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(init?.body as string) });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const notifier = new TelegramNotifier({ botToken: 'tok', chatId: 'chat-1', fetchImpl });
    await notifier.notify('BUY 0.001 BTC/USD at 50000');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.telegram.org/bottok/sendMessage');
    expect(calls[0]?.body).toEqual({ chat_id: 'chat-1', text: 'BUY 0.001 BTC/USD at 50000' });
  });

  it('throws when Telegram rejects the request, leaving the caller to decide what happens next', async () => {
    const fetchImpl = (async () => new Response('bad token', { status: 401 })) as typeof fetch;
    const notifier = new TelegramNotifier({ botToken: 'bad', chatId: 'chat-1', fetchImpl });
    await expect(notifier.notify('hi')).rejects.toThrow(/401/);
  });

  describe('fromEnv', () => {
    const keys = ['QUANT_BOT_TELEGRAM_BOT_TOKEN', 'QUANT_BOT_TELEGRAM_CHAT_ID'] as const;
    const originals = keys.map((k) => process.env[k]);
    afterEach(() => {
      keys.forEach((k, i) => {
        if (originals[i] === undefined) delete process.env[k];
        else process.env[k] = originals[i];
      });
    });

    it('falls back to NoopNotifier when the environment variables are unset', () => {
      delete process.env['QUANT_BOT_TELEGRAM_BOT_TOKEN'];
      delete process.env['QUANT_BOT_TELEGRAM_CHAT_ID'];
      expect(TelegramNotifier.fromEnv()).toBe(NoopNotifier);
    });

    it('builds a real TelegramNotifier once both are set', () => {
      process.env['QUANT_BOT_TELEGRAM_BOT_TOKEN'] = 'tok';
      process.env['QUANT_BOT_TELEGRAM_CHAT_ID'] = 'chat-1';
      expect(TelegramNotifier.fromEnv()).toBeInstanceOf(TelegramNotifier);
    });
  });
});

describe('dropFormingBar', () => {
  it('discards the bar that has not closed yet', () => {
    const now = 10 * HOUR;
    const candles = series([1, 2, 3], 8 * HOUR); // bars at 8h, 9h, 10h
    const closed = dropFormingBar(candles, '1h', now);
    expect(closed).toHaveLength(2);
    expect(closed[closed.length - 1]?.time).toBe(9 * HOUR);
  });

  it('keeps a bar whose interval has exactly elapsed', () => {
    expect(dropFormingBar(series([1], 0), '1h', HOUR)).toHaveLength(1);
  });
});

/** Records every order so the runner's decisions can be asserted directly. */
class FakeBroker implements Broker {
  readonly id = 'fake';
  readonly isLive = false;
  readonly orders: Fill[] = [];
  cash: number;
  qty = 0;
  candleSet: Candle[];
  price: number;

  constructor(cashStart: number, candleSet: Candle[], price: number) {
    this.cash = cashStart;
    this.candleSet = candleSet;
    this.price = price;
  }
  async balance(): Promise<{ cash: number; qty: number }> {
    return { cash: this.cash, qty: this.qty };
  }
  async lastPrice(): Promise<number> {
    return this.price;
  }
  async candles(_s: string, _t: Timeframe, _b: number): Promise<Candle[]> {
    return this.candleSet;
  }
  async marketBuy(symbol: string, quote: number): Promise<Fill> {
    const qty = quote / this.price;
    this.cash -= quote;
    this.qty += qty;
    const fill: Fill = { symbol, side: 'buy', qty, price: this.price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
  }
  async marketSell(symbol: string, qty: number): Promise<Fill> {
    this.cash += qty * this.price;
    this.qty -= qty;
    const fill: Fill = { symbol, side: 'sell', qty, price: this.price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
  }
}

/** Records every message it was asked to send; can be made to fail on demand. */
class FakeNotifier implements Notifier {
  readonly messages: string[] = [];
  shouldThrow = false;
  async notify(message: string): Promise<void> {
    if (this.shouldThrow) throw new Error('notifier unavailable');
    this.messages.push(message);
  }
}

describe('LiveRunner', () => {
  let dir: string;
  let statePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quant-bot-'));
    statePath = join(dir, 'state.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeRunner = (broker: Broker, limits = BENCHMARK_LIMITS, notifier?: Notifier): LiveRunner =>
    new LiveRunner({
      broker,
      factory: buyAndHold,
      params: {},
      symbols: ['BTC/USDT'],
      timeframe: '1h',
      limits,
      statePath,
      log: () => {},
      ...(notifier ? { notifier } : {}),
    }, 1_000);

  it('acts on a closed bar exactly once, so a restart loop cannot double-order', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const runner = makeRunner(broker);

    expect((await runner.step())[0]?.action).toBe('bought');
    expect((await runner.step())[0]?.action).toBe('already-processed');
    expect(broker.orders).toHaveLength(1);
  });

  it('persists the last processed bar so a fresh process does not re-trade it', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    await makeRunner(broker).step();

    // A brand-new runner, as if the process had crashed and restarted.
    expect((await makeRunner(broker).step())[0]?.action).toBe('already-processed');
    expect(broker.orders).toHaveLength(1);
  });

  it('will not trade a bar that is still forming', async () => {
    const now = Date.now();
    const broker = new FakeBroker(1_000, series([100], now), 100);
    expect((await makeRunner(broker).step())[0]?.action).toBe('warming-up');
    expect(broker.orders).toHaveLength(0);
  });

  it('flattens and stops when the drawdown kill switch fires', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const runner = makeRunner(broker, { ...DEFAULT_LIMITS, maxDrawdownPct: 10 });
    await runner.step();
    expect(broker.qty).toBeGreaterThan(0);

    // Price collapses; equity falls far enough to trip the switch.
    broker.price = 40;
    broker.candleSet = series([100, 100, 100, 40], Date.now() - 10 * HOUR);
    const [halted] = await runner.step();
    expect(halted?.action).toBe('flattened-by-risk');
    expect(broker.qty).toBeCloseTo(0, 9);
  });

  it('keeps the kill switch set across a restart', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const limits = { ...DEFAULT_LIMITS, maxDrawdownPct: 10 };
    const runner = makeRunner(broker, limits);
    await runner.step();
    broker.price = 40;
    broker.candleSet = series([100, 100, 100, 40], Date.now() - 10 * HOUR);
    await runner.step();

    const state = JSON.parse(await readFile(statePath, 'utf8')) as { killed: boolean };
    expect(state.killed).toBe(true);

    broker.candleSet = series([100, 100, 100, 40, 41], Date.now() - 10 * HOUR);
    const restarted = await makeRunner(broker, limits);
    const [outcome] = await restarted.step();
    expect(outcome?.action).toBe('halted');
    expect(outcome?.detail).toMatch(/kill switch active/);
  });

  it('notifies on a real trade', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const notifier = new FakeNotifier();

    expect((await makeRunner(broker, BENCHMARK_LIMITS, notifier).step())[0]?.action).toBe('bought');

    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toMatch(/^BUY /);
  });

  it('does not fail the trade when the notifier is unavailable', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const notifier = new FakeNotifier();
    notifier.shouldThrow = true;

    const [outcome] = await makeRunner(broker, BENCHMARK_LIMITS, notifier).step();

    expect(outcome?.action).toBe('bought');
    expect(broker.orders).toHaveLength(1);
  });
});

describe('StateStore', () => {
  it('returns empty state rather than throwing when the file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quant-bot-'));
    const store = new StateStore(join(dir, 'nested', 'state.json'));
    expect((await store.load()).killed).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips state through disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quant-bot-'));
    const store = new StateStore(join(dir, 'state.json'));
    const state = {
      ...(await store.load()),
      killed: true,
      killReason: 'testing',
      symbols: { 'BTC/USD': { ...EMPTY_SYMBOL_STATE, lastBarTime: 42, entryPrice: 100 } },
    };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    await rm(dir, { recursive: true, force: true });
  });
});

/** A broker holding several markets on one cash balance, with an optional minimum order. */
class MultiFakeBroker implements Broker {
  readonly id = 'fake-multi';
  readonly isLive = false;
  readonly orders: Fill[] = [];
  readonly qty = new Map<string, number>();
  readonly failing = new Set<string>();
  cash: number;
  readonly markets: Map<string, { candles: Candle[]; price: number }>;
  readonly minOrder: number;
  constructor(cash: number, markets: Map<string, { candles: Candle[]; price: number }>, minOrder = 0) {
    this.cash = cash;
    this.markets = markets;
    this.minOrder = minOrder;
  }
  async balance(symbol: string): Promise<{ cash: number; qty: number }> {
    return { cash: this.cash, qty: this.qty.get(symbol) ?? 0 };
  }
  async lastPrice(symbol: string): Promise<number> {
    return (this.markets.get(symbol) as { price: number }).price;
  }
  async candles(symbol: string): Promise<Candle[]> {
    if (this.failing.has(symbol)) throw new Error(`${symbol} delisted`);
    return (this.markets.get(symbol) as { candles: Candle[] }).candles;
  }
  async marketBuy(symbol: string, quote: number): Promise<Fill> {
    if (quote < this.minOrder) throw new OrderRejectedError(`$${quote} below minimum`);
    const price = await this.lastPrice(symbol);
    const qty = quote / price;
    this.cash -= quote;
    this.qty.set(symbol, (this.qty.get(symbol) ?? 0) + qty);
    const fill: Fill = { symbol, side: 'buy', qty, price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
  }
  async marketSell(symbol: string, qty: number): Promise<Fill> {
    const price = await this.lastPrice(symbol);
    this.cash += qty * price;
    this.qty.set(symbol, (this.qty.get(symbol) ?? 0) - qty);
    const fill: Fill = { symbol, side: 'sell', qty, price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
  }
}

describe('LiveRunner across several symbols', () => {
  let dir: string;
  let statePath: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'quant-bot-multi-'));
    statePath = join(dir, 'state.json');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const start = Date.now() - 10 * HOUR;
  const market = (price: number, bars = 3) => ({ candles: series(Array(bars).fill(price), start), price });
  const runner = (broker: Broker, symbols: string[], limits = { ...BENCHMARK_LIMITS, maxPositionPct: 50 }) =>
    new LiveRunner({
      broker, factory: buyAndHold, params: {}, symbols, timeframe: '1h', limits, statePath, log: () => {},
    }, 1_000);

  it('trades every symbol on one shared account, sizing each off total equity', async () => {
    const broker = new MultiFakeBroker(1_000, new Map([['BTC/USD', market(100)], ['ETH/USD', market(50)]]));
    const outcomes = await runner(broker, ['BTC/USD', 'ETH/USD']).step();
    expect(outcomes.map((o) => [o.symbol, o.action])).toEqual([['BTC/USD', 'bought'], ['ETH/USD', 'bought']]);
    // 50% of $1,000 each: the second is sized off total equity, not the cash left over.
    expect(broker.orders.map((o) => o.qty * o.price)).toEqual([500, 500]);
    expect(broker.cash).toBeCloseTo(0, 9);
  });

  it('applies one kill switch to the whole account: a crash in one market flattens all of them', async () => {
    const broker = new MultiFakeBroker(1_000, new Map([['BTC/USD', market(100)], ['ETH/USD', market(50)]]));
    const limits = { ...DEFAULT_LIMITS, maxPositionPct: 50, maxDrawdownPct: 10, maxDailyLossPct: 100 };
    const r = runner(broker, ['BTC/USD', 'ETH/USD'], limits);
    await r.step();

    // Only BTC falls, 30%. That alone takes the account down 15%.
    broker.markets.set('BTC/USD', { candles: series([100, 100, 100, 70], start), price: 70 });
    const outcomes = await r.step();
    expect(outcomes.map((o) => o.action)).toEqual(['flattened-by-risk', 'flattened-by-risk']);
    expect(broker.qty.get('BTC/USD')).toBeCloseTo(0, 9);
    expect(broker.qty.get('ETH/USD')).toBeCloseTo(0, 9);
    const saved = JSON.parse(await readFile(statePath, 'utf8')) as { killed: boolean };
    expect(saved.killed).toBe(true);
  });

  it('records a refused order and moves on instead of retrying it every poll', async () => {
    const broker = new MultiFakeBroker(
      1_000,
      new Map([['BTC/USD', market(100)], ['ETH/USD', market(50)]]),
      600, // Every order this runner sizes ($500) is under the minimum.
    );
    const r = runner(broker, ['BTC/USD', 'ETH/USD']);
    const first = await r.step();
    expect(first.map((o) => o.action)).toEqual(['rejected', 'rejected']);
    expect(first[0]?.detail).toMatch(/buy refused/);
    const second = await r.step();
    expect(second.map((o) => o.action)).toEqual(['already-processed', 'already-processed']);
    expect(broker.orders).toHaveLength(0);
  });

  it('keeps trading the other symbols when one market fails', async () => {
    const broker = new MultiFakeBroker(1_000, new Map([['BTC/USD', market(100)], ['DEAD/USD', market(1)]]));
    broker.failing.add('DEAD/USD');
    const outcomes = await runner(broker, ['DEAD/USD', 'BTC/USD']).step();
    expect(outcomes.map((o) => o.action)).toEqual(['unavailable', 'bought']);
    expect(outcomes[0]?.detail).toMatch(/delisted/);
  });

  it('refuses a duplicated or empty symbol list', () => {
    const broker = new MultiFakeBroker(1_000, new Map());
    expect(() => runner(broker, [])).toThrow(/at least one symbol/);
    expect(() => runner(broker, ['BTC/USD', 'BTC/USD'])).toThrow(/duplicate/);
  });
});
