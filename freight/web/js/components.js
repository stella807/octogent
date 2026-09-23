// Pieces shared by more than one view: badges, the match explanation, the
// shipment summary, timelines and message threads.

import { el } from "./dom.js";
import { STATUS_TONE, date, dateTime, lane, miles, titleCase, usd } from "./format.js";

export function badge(value, tone = STATUS_TONE[value] ?? "") {
  return el("span", { class: tone ? `badge badge--${tone}` : "badge" }, titleCase(value));
}

export function verificationBadge(status) {
  return el(
    "span",
    { class: `badge badge--${STATUS_TONE[status] ?? "warn"}`, title: `Verification: ${status}` },
    status === "verified" ? "Verified" : titleCase(status),
  );
}

export function matchMeter(match) {
  return el(
    "div",
    { class: "match" },
    el(
      "div",
      { class: "match__top" },
      el("span", { class: "match__percent" }, `${match.matchPercent}%`),
      el("span", { class: "tiny muted" }, "match"),
    ),
    el("progress", {
      value: match.matchPercent,
      max: 100,
      class: match.matchPercent < 60 ? "is-weak" : "",
    }),
  );
}

/** The whole point of the score: every factor, its weight and its evidence. */
export function matchFactors(match) {
  return el(
    "details",
    {},
    el("summary", {}, "Why this score"),
    el(
      "div",
      { class: "factors" },
      match.factors.map((factor) =>
        el(
          "div",
          { class: "factor" },
          el(
            "span",
            { class: "factor__label" },
            factor.label,
            el("span", { class: "tiny muted" }, ` ·${Math.round(factor.weight * 100)}%`),
          ),
          el("progress", {
            value: Math.round(factor.score * 100),
            max: 100,
            class: factor.neutral ? "is-weak" : "",
          }),
          el(
            "span",
            { class: "factor__detail" },
            factor.detail,
            factor.neutral ? " (no data yet)" : "",
          ),
        ),
      ),
    ),
  );
}

export function exclusionList(match) {
  return el(
    "div",
    { class: "exclusions" },
    el("strong", {}, "Not eligible: "),
    el(
      "ul",
      {},
      match.exclusions.map((reason) => el("li", {}, reason)),
    ),
  );
}

export function shipmentSummary(shipment, estimatedMiles) {
  const dimensions = shipment.dimensionsIn
    ? `${shipment.dimensionsIn.length}″ × ${shipment.dimensionsIn.width}″ × ${shipment.dimensionsIn.height}″`
    : "—";
  return el(
    "dl",
    { class: "meta-grid" },
    entry("Lane", `${lane(shipment)} (${miles(estimatedMiles)})`),
    entry("Pickup window", `${date(shipment.pickupFrom)} – ${date(shipment.pickupTo)}`),
    entry("Deliver by", date(shipment.deliverBy)),
    entry("Equipment", titleCase(shipment.equipment)),
    entry(
      "Cargo",
      `${titleCase(shipment.cargoType)} · ${shipment.palletCount} pallets · ${shipment.weightLbs.toLocaleString()} lb`,
    ),
    entry("Dimensions", dimensions),
    entry("Target price", usd(shipment.targetPriceCents)),
    entry("Visibility", titleCase(shipment.visibility)),
    entry(
      "Special requirements",
      shipment.specialRequirements.length > 0
        ? shipment.specialRequirements.map(titleCase).join(", ")
        : "None",
    ),
  );
}

function entry(label, value) {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value));
}

export function rateBandNote(band) {
  return el(
    "div",
    { class: "notice" },
    el("strong", {}, `Suggested ${usd(band.lowCents)} – ${usd(band.highCents)}. `),
    band.basis === "platform_history"
      ? "Based on awards on this lane: "
      : "Estimate, not market data — ",
    band.detail,
  );
}

export function timeline(events) {
  if (events.length === 0) return el("p", { class: "muted small" }, "No activity yet.");
  return el(
    "ul",
    { class: "timeline" },
    events.map((event) =>
      el(
        "li",
        {},
        el("time", { datetime: event.createdAt }, dateTime(event.createdAt)),
        el(
          "span",
          {},
          el("strong", {}, titleCase(event.type.replace(":", " "))),
          event.detail ? ` — ${event.detail}` : "",
        ),
      ),
    ),
  );
}

export function messageThread(messages, myCompanyId) {
  if (messages.length === 0) return el("p", { class: "muted small" }, "No messages yet.");
  return el(
    "div",
    { class: "thread" },
    messages.map((message) =>
      el(
        "div",
        { class: message.senderCompanyId === myCompanyId ? "message message--mine" : "message" },
        el(
          "div",
          { class: "message__who" },
          `${message.senderName} · ${message.senderCompanyName} · ${dateTime(message.createdAt)}`,
        ),
        el("div", {}, message.body),
      ),
    ),
  );
}

export function empty(message) {
  return el("div", { class: "empty" }, message);
}
