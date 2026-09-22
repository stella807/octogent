import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle, Timeframe } from '../src/domain/types.ts';
import { DEFAULT_COSTS, FRICTIONLESS } from '../src/backtest/costs.ts';
import { PaperBroker } from '../src/live/paper-broker.ts';
import { dropFormingBar, LiveRunner } from '../src/live/runner.ts';
import { StateStore } from '../src/live/state-store.ts';
import { ExchangeBroker, LIVE_CONFIRM_ENV } from '../src/live/exchange-broker.ts';
import { DEFAULT_LIMITS, BENCHMARK_LIMITS } from '../src/risk/risk-manager.ts';
import { buyAndHold } from '../src/strategy/index.ts';
import type { Broker, Fill } from '../src/live/broker.ts';

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
  async marketBuy(_symbol: string, quote: number): Promise<Fill> {
    const qty = quote / this.price;
    this.cash -= quote;
    this.qty += qty;
    const fill: Fill = { side: 'buy', qty, price: this.price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
  }
  async marketSell(_symbol: string, qty: number): Promise<Fill> {
    this.cash += qty * this.price;
    this.qty -= qty;
    const fill: Fill = { side: 'sell', qty, price: this.price, fee: 0, time: Date.now() };
    this.orders.push(fill);
    return fill;
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

  const makeRunner = (broker: Broker, limits = BENCHMARK_LIMITS): LiveRunner =>
    new LiveRunner({
      broker,
      factory: buyAndHold,
      params: {},
      symbol: 'BTC/USDT',
      timeframe: '1h',
      limits,
      statePath,
      log: () => {},
    }, 1_000);

  it('acts on a closed bar exactly once, so a restart loop cannot double-order', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    const runner = makeRunner(broker);

    expect((await runner.step()).action).toBe('bought');
    expect((await runner.step()).action).toBe('already-processed');
    expect(broker.orders).toHaveLength(1);
  });

  it('persists the last processed bar so a fresh process does not re-trade it', async () => {
    const candles = series([100, 100, 100], Date.now() - 10 * HOUR);
    const broker = new FakeBroker(1_000, candles, 100);
    await makeRunner(broker).step();

    // A brand-new runner, as if the process had crashed and restarted.
    expect((await makeRunner(broker).step()).action).toBe('already-processed');
    expect(broker.orders).toHaveLength(1);
  });

  it('will not trade a bar that is still forming', async () => {
    const now = Date.now();
    const broker = new FakeBroker(1_000, series([100], now), 100);
    expect((await makeRunner(broker).step()).action).toBe('warming-up');
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
    const halted = await runner.step();
    expect(halted.action).toBe('flattened-by-risk');
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
    const outcome = await restarted.step();
    expect(outcome.action).toBe('halted');
    expect(outcome.detail).toMatch(/kill switch active/);
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
    const state = { ...(await store.load()), killed: true, killReason: 'testing', lastBarTime: 42 };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    await rm(dir, { recursive: true, force: true });
  });
});
