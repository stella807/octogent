import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '../src/domain/types.ts';
import { FRICTIONLESS } from '../src/backtest/costs.ts';
import { PaperBroker, readPaperAccount } from '../src/live/paper-broker.ts';
import { paperStatus } from '../src/live/status.ts';
import { EMPTY_STATE } from '../src/live/state-store.ts';
import { expansionProgress, minEquityFor, planCoreFleet, planExpansion, planFleet, planReserve, type BotFunds } from '../src/live/fleet.ts';

const DAY = 86_400_000;
const flat = async (): Promise<Candle[]> => [{ time: 0, open: 100, high: 100, low: 100, close: 100, volume: 1 }];
const rising = (price: number) => async (): Promise<Candle[]> =>
  [{ time: DAY, open: price, high: price, low: price, close: price, volume: 1 }];

describe('PaperBroker.withdraw', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'qb-withdraw-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('moves cash out, records it, and survives a restart', async () => {
    const accountPath = join(dir, 'paper-account.json');
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: flat, accountPath });
    expect(await broker.withdraw(10)).toBe(10);
    const saved = await readPaperAccount(accountPath);
    expect(saved?.cash).toBe(15);
    expect(saved?.withdrawn).toBe(10);
    const restarted = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: flat, accountPath });
    expect((await restarted.balance('BTC/USD')).cash).toBe(15);
  });

  it('never takes more than the cash on hand', async () => {
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: flat });
    await broker.marketBuy('BTC/USD', 20);
    expect(await broker.withdraw(10)).toBeCloseTo(5, 9);
  });

  it('keeps concurrent saves from clobbering each other', async () => {
    const accountPath = join(dir, 'paper-account.json');
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: flat, accountPath });
    await Promise.all([broker.withdraw(1), broker.withdraw(2), broker.marketBuy('BTC/USD', 5)]);
    const saved = JSON.parse(await readFile(accountPath, 'utf8')) as { cash: number; withdrawn: number };
    expect(saved.withdrawn).toBe(3);
    expect(saved.cash).toBeCloseTo(17, 9);
  });

  it('still credits the donor with the profit it gave away', async () => {
    const accountPath = join(dir, 'paper-account.json');
    let feed = flat;
    const broker = new PaperBroker({ startingCash: 25, costs: FRICTIONLESS, feed: () => feed(), accountPath });
    await broker.marketBuy('BTC/USD', 25);
    feed = rising(200);
    await broker.marketSell('BTC/USD', (await broker.balance('BTC/USD')).qty);
    await broker.withdraw(25);
    const account = await readPaperAccount(accountPath);
    const s = paperStatus(account!, { ...EMPTY_STATE }, {});
    expect(s.equity).toBeCloseTo(25, 9);
    expect(s.pnl).toBeCloseTo(25, 9);
  });
});

describe('planExpansion', () => {
  const bot = (name: string, over: Partial<BotFunds> = {}): BotFunds =>
    ({ name, startingCash: 25, cash: 25, equity: 25, realized: 0, withdrawn: 0, ...over });

  it('funds nothing while the fleet has not made a new bot\'s worth of profit', () => {
    const bots = [bot('a', { cash: 45, equity: 45, realized: 20 }), bot('b')];
    expect(planExpansion(bots, { principal: 50, added: 0, cost: 25 })).toBeNull();
  });

  it('funds a bot from realized profit held in cash, largest donor first', () => {
    const bots = [
      bot('a', { cash: 40, equity: 40, realized: 15 }),
      bot('b', { cash: 45, equity: 45, realized: 20 }),
    ];
    expect(planExpansion(bots, { principal: 50, added: 0, cost: 25 })).toEqual({ b: 20, a: 5 });
  });

  it('will not spend paper gains on open positions, however large', () => {
    const bots = [bot('a', { cash: 0, equity: 500, realized: 0 }), bot('b')];
    expect(planExpansion(bots, { principal: 50, added: 0, cost: 25 })).toBeNull();
  });

  it('will not spend one bot\'s realized profit while the fleet as a whole is down', () => {
    const bots = [bot('a', { cash: 55, equity: 55, realized: 30 }), bot('b', { cash: 0, equity: 0, realized: -25 })];
    expect(planExpansion(bots, { principal: 50, added: 0, cost: 25 })).toBeNull();
  });

  it('counts bots already added against the profit, so the same money is never spent twice', () => {
    // a realized $40 and gave $25 of it to start bot c. Fleet profit is $40, but $25 of that
    // is c's capital already, so the next bot needs $50 in total and there is only $40.
    const bots = [
      bot('a', { cash: 40, equity: 40, realized: 40, withdrawn: 25 }),
      bot('b'),
      bot('c'),
    ];
    expect(planExpansion(bots, { principal: 50, added: 1, cost: 25 })).toBeNull();
    const richer = [bot('a', { cash: 60, equity: 60, realized: 60, withdrawn: 25 }), bot('b'), bot('c')];
    expect(planExpansion(richer, { principal: 50, added: 1, cost: 25 })).toEqual({ a: 25 });
  });

  it('never draws a donor below its own starting cash', () => {
    const bots = [bot('a', { cash: 30, equity: 60, realized: 30 }), bot('b', { cash: 50, equity: 50, realized: 25 })];
    const plan = planExpansion(bots, { principal: 50, added: 0, cost: 25 });
    expect(plan).toEqual({ b: 25 });
  });
});

describe('expansionProgress', () => {
  it('says how much more profit the next bot needs', () => {
    expect(expansionProgress({ principal: 250, fleetEquity: 260, added: 0, cost: 25 })).toEqual({ profit: 10, needed: 15 });
    expect(expansionProgress({ principal: 250, fleetEquity: 240, added: 0, cost: 25 })).toEqual({ profit: -10, needed: 35 });
  });
});

describe('planReserve', () => {
  const full = planFleet(Array.from({ length: 32 }, (_, i) => `C${i}/USD`));
  const reserve = planReserve(full, planCoreFleet());

  it('queues every bot not already running, minus ones whose trades would fall under the $1 minimum', () => {
    const core = new Set(planCoreFleet().map((b) => b.name));
    expect(reserve.some((b) => core.has(b.name))).toBe(false);
    expect(reserve.some((b) => b.strategy === 'dca-safety')).toBe(false);
    const tooSmall = full.filter((b) => !core.has(b.name) && minEquityFor(b) > b.equity).length;
    expect(tooSmall).toBeGreaterThanOrEqual(2);
    expect(reserve.length).toBe(full.length - core.size - tooSmall);
  });

  it('adds the best-evidenced bots first and the fast ones last', () => {
    expect(reserve[0]?.group).toBe('daily strategies');
    expect(reserve[reserve.length - 1]?.group).toBe('fast (1-minute)');
  });
});
