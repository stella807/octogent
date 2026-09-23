import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { laneMiles } from "../src/domain/geo.ts";
import { suggestRate } from "../src/domain/rates.ts";
import { testShipment } from "./helpers.ts";

describe("rate guidance", () => {
  it("falls back to a heuristic and labels it as one", () => {
    const band = suggestRate(testShipment(), []);
    assert.equal(band.basis, "distance_heuristic");
    assert.ok(band.lowCents < band.highCents);
  });

  it("prefers what the platform actually paid once there are enough awards", () => {
    const comparables = [400_000, 430_000, 460_000, 490_000].map((priceCents) => ({
      originRegion: "US-FL",
      destinationRegion: "US-PR",
      equipment: "dry_van" as const,
      priceCents,
    }));
    const band = suggestRate(testShipment(), comparables);
    assert.equal(band.basis, "platform_history");
    assert.equal(band.lowCents, 430_000);
    assert.equal(band.highCents, 460_000);
  });

  it("ignores comparables from a different equipment class", () => {
    const comparables = [1, 2, 3].map(() => ({
      originRegion: "US-FL",
      destinationRegion: "US-PR",
      equipment: "reefer" as const,
      priceCents: 900_000,
    }));
    assert.equal(suggestRate(testShipment(), comparables).basis, "distance_heuristic");
  });

  it("does not price an ocean lane per mile", () => {
    const ocean = suggestRate(testShipment(), []);
    assert.match(ocean.detail, /Ocean lane/);
    assert.ok(!/\/mi/.test(ocean.detail));
    assert.ok(ocean.lowCents > 250_000, "an ocean container costs more than a short drive");

    const inland = suggestRate(
      testShipment({ destination: { city: "Atlanta", region: "GA", country: "US" } }),
      [],
    );
    assert.match(inland.detail, /\/mi ×/);
  });

  it("reports the mileage estimate it used", () => {
    const band = suggestRate(testShipment(), []);
    assert.equal(band.miles, laneMiles("US-FL", "US-PR"));
  });
});
