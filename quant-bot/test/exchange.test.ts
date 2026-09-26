import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCandles } from "../src/data/exchange.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2024, 0, 11, 12); // midday, so the 2024-01-11 bar is still forming
const calls: { since: number | undefined; limit: number | undefined }[] = [];

vi.mock("ccxt", () => ({
  // Present but not a class, as ccxt looks to a misspelled exchange id.
  nope: undefined,
  fakex: class {
    async fetchOHLCV(_symbol: string, _tf: string, since?: number, limit?: number) {
      calls.push({ since, limit });
      const rows: number[][] = [];
      // Serves daily bars from 2024-01-01 through the forming bar, 3 per page,
      // so every multi-day request has to paginate.
      for (let t = since ?? Date.UTC(2024, 0, 1); t <= NOW && rows.length < 3; t += DAY) {
        rows.push([t, 100, 110, 90, 105, 1]);
      }
      return rows;
    }
  },
}));

let dir = "";
beforeEach(async () => {
  calls.length = 0;
  dir = await mkdtemp(join(tmpdir(), "quant-bot-cache-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const base = { exchange: "fakex", symbol: "BTC/USDT", timeframe: "1d" as const, now: () => NOW };

describe("fetchCandles", () => {
  it("paginates across the window and never returns the still-forming bar", async () => {
    const candles = await fetchCandles({ ...base, bars: 100, since: Date.UTC(2024, 0, 1) });
    expect(candles.map((c) => c.time)).toEqual(
      Array.from({ length: 10 }, (_, i) => Date.UTC(2024, 0, 1) + i * DAY),
    );
    expect(calls.length).toBeGreaterThan(1);
  });

  it("returns the most recent N closed bars when no start is given", async () => {
    const candles = await fetchCandles({ ...base, bars: 4 });
    expect(candles).toHaveLength(4);
    expect(candles.at(-1)?.time).toBe(Date.UTC(2024, 0, 10));
  });

  it("serves a repeat request from the disk cache without the network", async () => {
    const options = { ...base, bars: 100, since: Date.UTC(2024, 0, 1), cacheDir: dir };
    const first = await fetchCandles(options);
    expect(await readdir(dir)).toEqual(["fakex_BTC-USDT_1d.json"]);
    calls.length = 0;
    expect(await fetchCandles(options)).toEqual(first);
    expect(calls).toHaveLength(0);
  });

  it("rejects an exchange ccxt does not know", async () => {
    await expect(fetchCandles({ ...base, exchange: "nope", bars: 5 })).rejects.toThrow(
      /no exchange named/,
    );
  });
});
