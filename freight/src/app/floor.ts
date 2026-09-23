/**
 * The command floor: one live read of the whole book, scoped to whoever is
 * looking.
 *
 * Six stations mirror the real lifecycle a load moves through — intake, match,
 * quote, counter, award, settle — and every count on this page is a query
 * against the same tables the rest of the app writes. There is no separate
 * telemetry pipeline, and nothing here is sampled or smoothed: if a station
 * reads 3, three shipments are in that state right now.
 */

import { eligibilityFailures } from "../domain/matching.ts";
import type { Quote, Shipment } from "../domain/types.ts";
import type { FloorEvent, Store, SupplierRecord } from "../ports/store.ts";
import { forbidden } from "./errors.ts";
import type { Principal } from "./principal.ts";
import { canSupplierSee } from "./shipments.ts";

export type StationKey = "intake" | "match" | "quote" | "counter" | "award" | "settle";

export type Station = {
  key: StationKey;
  /** 01..06, the order work flows through. */
  index: number;
  label: string;
  count: number;
  detail: string;
  lastAt: string | null;
  state: "live" | "idle";
};

export type Metric = {
  key: string;
  label: string;
  value: string;
  detail: string;
  /** Only set where the number genuinely means a state, never for decoration. */
  tone?: "good" | "warning" | "critical";
};

export type CurvePoint = {
  at: string;
  reference: string;
  priceCents: number;
  cumulativeCents: number;
};

export type FloorView = {
  scope: "shipper" | "supplier" | "admin";
  generatedAt: string;
  stations: Station[];
  metrics: Metric[];
  awardedCurve: CurvePoint[];
  events: FloorEvent[];
};

const EVENT_LIMIT = 40;

export function floorView(store: Store, principal: Principal): FloorView {
  const scope = resolveScope(principal);
  const companyId = principal.company?.id ?? null;

  const shipments = scopedShipments(store, principal, scope, companyId);
  const quotesByShipment = new Map<string, Quote[]>(
    shipments.map((shipment) => [shipment.id, store.listQuotesForShipment(shipment.id)]),
  );
  const mine = (quote: Quote) => scope !== "supplier" || quote.supplierCompanyId === companyId;
  const quotes = shipments.flatMap((shipment) =>
    (quotesByShipment.get(shipment.id) ?? []).filter(mine),
  );

  const supplierRecord =
    scope === "supplier" && companyId ? store.getSupplierRecord(companyId) : null;

  return {
    scope,
    generatedAt: new Date().toISOString(),
    stations: buildStations(shipments, quotesByShipment, quotes, scope, companyId, supplierRecord),
    metrics: buildMetrics(shipments, quotesByShipment, quotes, scope, supplierRecord),
    awardedCurve: buildCurve(shipments, quotesByShipment, scope, companyId),
    events: store.listRecentEvents(
      scope === "admin" ? null : shipments.map((shipment) => shipment.id),
      EVENT_LIMIT,
    ),
  };
}

function resolveScope(principal: Principal): FloorView["scope"] {
  if (principal.user.role === "admin") return "admin";
  const kind = principal.company?.kind;
  if (kind === "shipper" || kind === "supplier") return kind;
  throw forbidden("This account has no company to show a floor for");
}

/**
 * A supplier's floor covers the posted book they can see plus everything they
 * have bid on — including loads that closed to them, so a lost award still
 * shows in the tape.
 */
function scopedShipments(
  store: Store,
  principal: Principal,
  scope: FloorView["scope"],
  companyId: string | null,
): Shipment[] {
  if (scope === "admin") return store.listAllShipments();
  if (!companyId) return [];
  if (scope === "shipper") return store.listShipmentsForShipper(companyId);

  const bidOn = store.listShipmentsForSupplier(companyId);
  const seen = new Set(bidOn.map((shipment) => shipment.id));
  const open = store
    .listPostedShipments()
    .filter((shipment) => !seen.has(shipment.id) && canSupplierSee(store, shipment, companyId));
  return [...bidOn, ...open];
}

function buildStations(
  shipments: Shipment[],
  quotesByShipment: Map<string, Quote[]>,
  quotes: Quote[],
  scope: FloorView["scope"],
  companyId: string | null,
  supplierRecord: SupplierRecord | null,
): Station[] {
  const posted = shipments.filter((shipment) => shipment.status === "posted");
  const inMotion = shipments.filter((shipment) =>
    ["awarded", "picked_up", "in_transit"].includes(shipment.status),
  );
  const delivered = shipments.filter((shipment) => shipment.status === "delivered");
  const pending = quotes.filter((quote) => quote.status === "pending");
  const countered = quotes.filter((quote) => quote.status === "countered");

  const match = matchStationCount(posted, scope, supplierRecord);
  const won = (shipment: Shipment) => {
    if (scope !== "supplier") return true;
    const awarded = (quotesByShipment.get(shipment.id) ?? []).find(
      (quote) => quote.id === shipment.awardedQuoteId,
    );
    return awarded?.supplierCompanyId === companyId;
  };
  const awarded = inMotion.filter(won);
  const settled = delivered.filter(won);

  return [
    station("intake", 1, "Intake", posted.length, {
      detail: scope === "supplier" ? "posted loads open to you" : "loads on the board",
      lastAt: latest(posted.map((shipment) => shipment.createdAt)),
    }),
    station("match", 2, "Match", match.count, { detail: match.detail, lastAt: null }),
    station("quote", 3, "Quote", pending.length, {
      detail: scope === "supplier" ? "your bids with the shipper" : "bids waiting on you",
      lastAt: latest(pending.map((quote) => quote.updatedAt)),
    }),
    station("counter", 4, "Counter", countered.length, {
      detail: scope === "supplier" ? "counters waiting on you" : "counters with the supplier",
      lastAt: latest(countered.map((quote) => quote.updatedAt)),
    }),
    station("award", 5, "Award", awarded.length, {
      detail: "awarded and moving",
      lastAt: latest(awarded.map((shipment) => shipment.createdAt)),
    }),
    station("settle", 6, "Settle", settled.length, {
      detail: "delivered and closed",
      lastAt: latest(
        settled.map((shipment) => shipment.closedAt).filter((at): at is string => at !== null),
      ),
    }),
  ];
}

/**
 * How much matching capacity is actually standing behind the open book.
 *
 * The supplier side deliberately calls the domain rule directly rather than the
 * opportunity use case: that one records "opportunities seen", and a dashboard
 * polling in the background would inflate the denominator of the response rate
 * matching later reads.
 */
function matchStationCount(
  posted: Shipment[],
  scope: FloorView["scope"],
  supplierRecord: SupplierRecord | null,
): { count: number; detail: string } {
  if (scope === "supplier") {
    if (!supplierRecord) return { count: 0, detail: "publish a profile to be matched" };
    const eligible = posted.filter(
      (shipment) => eligibilityFailures(shipment, supplierRecord).length === 0,
    );
    return { count: eligible.length, detail: "open loads you are eligible for" };
  }
  return { count: posted.length, detail: "open loads being ranked" };
}

function station(
  key: StationKey,
  index: number,
  label: string,
  count: number,
  extra: { detail: string; lastAt: string | null },
): Station {
  return { key, index, label, count, state: count > 0 ? "live" : "idle", ...extra };
}

function buildMetrics(
  shipments: Shipment[],
  quotesByShipment: Map<string, Quote[]>,
  quotes: Quote[],
  scope: FloorView["scope"],
  supplierRecord: SupplierRecord | null,
): Metric[] {
  const open = shipments.filter((shipment) => shipment.status === "posted").length;
  const live = quotes.filter((quote) => quote.status === "pending" || quote.status === "countered");
  const awaiting =
    scope === "supplier"
      ? quotes.filter((quote) => quote.status === "countered")
      : scope === "shipper"
        ? quotes.filter((quote) => quote.status === "pending")
        : live;

  const accepted = quotes.filter((quote) => quote.status === "accepted");
  const awardedCents = accepted.reduce((sum, quote) => sum + quote.priceCents, 0);

  const delivered = shipments.filter(
    (shipment) => shipment.status === "delivered" && shipment.deliverBy !== null,
  );
  const onTime = delivered.filter(
    (shipment) =>
      shipment.closedAt !== null &&
      shipment.closedAt.slice(0, 10) <= (shipment.deliverBy as string),
  );

  const responseHours = medianFirstQuoteHours(shipments, quotesByShipment);

  return [
    {
      key: "open",
      label: "Open loads",
      value: String(open),
      detail: scope === "supplier" ? "visible to you right now" : "posted, not yet awarded",
    },
    {
      key: "live",
      label: "Quotes in flight",
      value: String(live.length),
      detail: "pending or countered",
    },
    {
      key: "awaiting",
      label: "Awaiting your move",
      value: String(awaiting.length),
      detail: awaiting.length > 0 ? "someone is waiting on a reply" : "nothing is blocked on you",
      ...(awaiting.length > 0 ? { tone: "warning" as const } : {}),
    },
    {
      key: "awarded",
      label: scope === "supplier" ? "Won value" : "Awarded value",
      value: usdCompact(awardedCents),
      detail: `${accepted.length} awarded shipment(s)`,
    },
    {
      key: "onTime",
      label: "On time",
      value:
        delivered.length === 0 ? "—" : `${Math.round((onTime.length / delivered.length) * 100)}%`,
      detail:
        delivered.length === 0
          ? "no delivery with a deadline yet"
          : `${onTime.length} of ${delivered.length} met the deadline`,
      ...(delivered.length > 0 && onTime.length === delivered.length
        ? { tone: "good" as const }
        : {}),
    },
    {
      key: "response",
      label: "First quote in",
      value: responseHours === null ? "—" : `${responseHours.toFixed(1)}h`,
      detail:
        responseHours === null
          ? "no quoted load yet"
          : supplierRecord
            ? "median from posting to your bid"
            : "median from posting to first bid",
    },
  ];
}

/** Median, not mean: one load that sat over a weekend should not move the number. */
function medianFirstQuoteHours(
  shipments: Shipment[],
  quotesByShipment: Map<string, Quote[]>,
): number | null {
  const gaps: number[] = [];
  for (const shipment of shipments) {
    const quotes = quotesByShipment.get(shipment.id) ?? [];
    if (quotes.length === 0) continue;
    const first = Math.min(...quotes.map((quote) => Date.parse(quote.createdAt)));
    const posted = Date.parse(shipment.createdAt);
    if (Number.isNaN(first) || Number.isNaN(posted) || first < posted) continue;
    gaps.push((first - posted) / 3_600_000);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 0
    ? ((gaps[middle - 1] as number) + (gaps[middle] as number)) / 2
    : (gaps[middle] as number);
}

function buildCurve(
  shipments: Shipment[],
  quotesByShipment: Map<string, Quote[]>,
  scope: FloorView["scope"],
  companyId: string | null,
): CurvePoint[] {
  const awards: { at: string; reference: string; priceCents: number }[] = [];
  for (const shipment of shipments) {
    if (!shipment.awardedQuoteId) continue;
    const quote = (quotesByShipment.get(shipment.id) ?? []).find(
      (candidate) => candidate.id === shipment.awardedQuoteId,
    );
    if (!quote) continue;
    if (scope === "supplier" && quote.supplierCompanyId !== companyId) continue;
    awards.push({
      at: quote.updatedAt,
      reference: shipment.reference,
      priceCents: quote.priceCents,
    });
  }
  awards.sort((a, b) => a.at.localeCompare(b.at));

  let running = 0;
  return awards.map((award) => {
    running += award.priceCents;
    return { ...award, cumulativeCents: running };
  });
}

function latest(values: string[]): string | null {
  return values.length === 0 ? null : (values.reduce((a, b) => (a > b ? a : b)) as string);
}

function usdCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 10_000) return `$${Math.round(dollars / 1000)}K`;
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}
