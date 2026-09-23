import { describe, expect, it } from "vitest";
import { analyze, parseProgramUrl, platformEligibility } from "../src/analyze.ts";

describe("parseProgramUrl", () => {
  it("recognizes a Cantina code link and its uuid", () => {
    const ref = parseProgramUrl(
      "https://cantina.xyz/code/253a4e11-c99c-49e9-83f7-d076d8804475/overview",
    );
    expect(ref.platform).toBe("cantina");
    expect(ref.id).toBe("253a4e11-c99c-49e9-83f7-d076d8804475");
  });

  it("recognizes Algora, Sherlock and CodeHawks", () => {
    expect(parseProgramUrl("https://algora.io/coollabsio/bounties").platform).toBe("algora");
    expect(parseProgramUrl("https://audits.sherlock.xyz/contests/1").platform).toBe("sherlock");
    expect(parseProgramUrl("https://codehawks.cyfrin.io/c/x").platform).toBe("codehawks");
  });

  it("falls back to unknown for junk input", () => {
    expect(parseProgramUrl("not a url").platform).toBe("unknown");
    expect(parseProgramUrl("not a url").id).toBeNull();
  });
});

describe("platformEligibility", () => {
  it("never claims AI submissions are safe on Cantina without reading the program", () => {
    expect(platformEligibility("cantina").aiSubmissionsForbidden).toBe("unknown");
    expect(platformEligibility("cantina").kycLikely).toBe(true);
  });

  it("marks Algora AI-assisted-with-disclosure as allowed", () => {
    expect(platformEligibility("algora").aiSubmissionsForbidden).toBe("no");
  });
});

describe("analyze", () => {
  it("always returns the full submission checklist", () => {
    const a = analyze("https://cantina.xyz/code/253a4e11-c99c-49e9-83f7-d076d8804475/overview");
    expect(a.checklist.length).toBeGreaterThanOrEqual(9);
    expect(a.checklist.some((c) => c.toLowerCase().includes("proof of concept"))).toBe(true);
  });

  it("carries through facts supplied by the caller", () => {
    const a = analyze("https://cantina.xyz/code/x", {
      name: "pump-fun",
      rewardPot: 500000,
      currency: "USDC",
    });
    expect(a.facts.name).toBe("pump-fun");
    expect(a.facts.rewardPot).toBe(500000);
  });
});
