import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";

describe("parseArgs", () => {
  it("defaults to a single poll", () => {
    expect(parseArgs([]).command).toBe("once");
  });

  it("treats a leading flag as the default command", () => {
    const args = parseArgs(["--json"]);
    expect(args.command).toBe("once");
    expect(args.json).toBe(true);
  });

  it("reads the watch command and interval", () => {
    const args = parseArgs(["watch", "--interval", "45"]);
    expect(args.command).toBe("watch");
    expect(args.intervalMin).toBe(45);
  });

  it("refuses an interval that would hammer the boards", () => {
    expect(() => parseArgs(["watch", "--interval", "1"])).toThrow(/at least 5 minutes/);
  });

  it("refuses a negative reward floor", () => {
    expect(() => parseArgs(["once", "--min", "-5"])).toThrow(/non-negative/);
  });

  it("leaves min unset when not supplied so the watchlist wins", () => {
    expect(parseArgs(["once"]).min).toBeUndefined();
  });
});
