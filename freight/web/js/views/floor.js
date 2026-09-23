// The command floor: one live read of the book, in the shape the work moves.
//
// Everything on this page is a number the API computed from the database. The
// page polls, it does not stream, and it says so in the status line rather than
// implying a socket it does not have.

import { api } from "../api.js";
import { compactUsd, countBar, cumulativeChart, svgEl } from "../charts.js";
import { empty } from "../components.js";
import { el, replace } from "../dom.js";
import { dateTime, titleCase, usd } from "../format.js";

const shortDate = (value) =>
  new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });

const clockTime = (value) =>
  new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** A whole book awarded inside one day should read as times, not the same date twice. */
function axisLabeller(points) {
  const first = points[0]?.at ?? "";
  const last = points.at(-1)?.at ?? "";
  const sameDay = first.slice(0, 10) === last.slice(0, 10);
  return (point) => (sameDay ? clockTime(point.at) : shortDate(point.at));
}

const POLL_MS = 5000;
const ORBIT = { width: 900, height: 340, cx: 450, cy: 170, rx: 330, ry: 118 };

const EVENT_LABELS = {
  posted: "Posted",
  awarded: "Awarded",
  "quote:submitted": "Quote submitted",
  "quote:countered": "Countered",
  "quote:declined": "Declined",
  "quote:withdrawn": "Withdrawn",
  "status:picked_up": "Picked up",
  "status:in_transit": "In transit",
  "status:delivered": "Delivered",
  "status:cancelled": "Cancelled",
};

const EVENT_TONE = { "status:delivered": "ok", "status:cancelled": "danger", awarded: "brand" };

export async function renderFloor() {
  const section = el("section", { class: "floor" });
  const status = el("span", { class: "floor__status" });
  const body = el("div", {});
  let held = false; // paused while someone is reading the chart
  let stopped = false;

  section.append(
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el("h1", {}, "Command floor"),
        el(
          "p",
          {},
          "Six stations, one book. Every count is a live query — nothing here is sampled or smoothed.",
        ),
      ),
      status,
    ),
    body,
  );

  const paint = (floor) => {
    replace(
      body,
      metricsRow(floor),
      orbitCard(floor),
      stationRail(floor),
      curveCard(floor, {
        onHold: (value) => {
          held = value;
        },
      }),
      activityCard(floor),
    );
    replace(
      status,
      el(
        "span",
        { class: "floor__live" },
        el("span", { class: "floor__dot", "aria-hidden": "true" }),
        "Live",
      ),
      el(
        "span",
        { class: "tiny muted" },
        ` ${titleCase(floor.scope)} view · updated ${new Date(floor.generatedAt).toLocaleTimeString()} · polls every ${POLL_MS / 1000}s`,
      ),
    );
  };

  paint(await api.get("/api/floor"));

  const tick = async () => {
    if (stopped || held || document.hidden) return;
    // Hold the previous render at reduced opacity rather than flashing a skeleton.
    section.classList.add("is-refreshing");
    try {
      paint(await api.get("/api/floor"));
    } catch {
      // A failed poll leaves the last good render on screen; the next tick retries.
    } finally {
      section.classList.remove("is-refreshing");
    }
  };

  const timer = setInterval(tick, POLL_MS);
  section.teardown = () => {
    stopped = true;
    clearInterval(timer);
  };
  return section;
}

/** The open book is the one number this page leads with, so it is the hero, in the orbit's centre. */
function metricsRow(floor) {
  const tiles = floor.metrics
    .filter((metric) => metric.key !== "open")
    .map((metric) =>
      el(
        "div",
        { class: "stat" },
        el("div", { class: "stat__label" }, metric.label),
        el(
          "div",
          { class: metric.tone ? `stat__value stat__value--${metric.tone}` : "stat__value" },
          metric.value,
        ),
        el(
          "div",
          { class: "tiny muted" },
          metric.tone === "warning"
            ? el("span", { class: "stat__flag", "aria-hidden": "true" }, "! ")
            : null,
          metric.detail,
        ),
      ),
    );
  return el("div", { class: "grid grid--stats" }, tiles);
}

function orbitCard(floor) {
  const open = floor.metrics.find((metric) => metric.key === "open");
  const nodes = floor.stations.map((station, index) => {
    const angle = (-90 + index * 60) * (Math.PI / 180);
    return {
      station,
      x: ORBIT.cx + ORBIT.rx * Math.cos(angle),
      y: ORBIT.cy + ORBIT.ry * Math.sin(angle),
    };
  });

  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const ring = svgEl("g", {
    class: reducedMotion ? "orbit__ring" : "orbit__ring orbit__ring--spinning",
  });
  for (const scale of [1, 0.74, 0.48]) {
    ring.append(
      svgEl("ellipse", {
        class: "orbit__track",
        cx: ORBIT.cx,
        cy: ORBIT.cy,
        rx: ORBIT.rx * scale,
        ry: ORBIT.ry * scale,
      }),
    );
  }

  const handoffs = nodes.map((node, index) => {
    const next = nodes[(index + 1) % nodes.length];
    const live = node.station.count > 0;
    return svgEl("path", {
      class: live ? "orbit__handoff orbit__handoff--live" : "orbit__handoff",
      d: `M${node.x},${node.y} Q${ORBIT.cx},${ORBIT.cy} ${next.x},${next.y}`,
    });
  });

  const stations = nodes.map(({ station, x, y }) =>
    svgEl(
      "g",
      {
        class: station.state === "live" ? "orbit__station orbit__station--live" : "orbit__station",
      },
      svgEl("circle", { class: "orbit__node", cx: x, cy: y, r: 27 }),
      svgEl("text", { class: "orbit__count", x, y: y + 6, "text-anchor": "middle" }, station.count),
      svgEl(
        "text",
        { class: "orbit__index", x, y: y - 38, "text-anchor": "middle" },
        String(station.index).padStart(2, "0"),
      ),
      svgEl(
        "text",
        { class: "orbit__label", x, y: y + 48, "text-anchor": "middle" },
        station.label.toUpperCase(),
      ),
    ),
  );

  const svg = svgEl(
    "svg",
    {
      class: "orbit",
      viewBox: `0 0 ${ORBIT.width} ${ORBIT.height}`,
      "aria-hidden": "true",
      preserveAspectRatio: "xMidYMid meet",
    },
    ring,
    handoffs,
    svgEl("circle", { class: "orbit__core", cx: ORBIT.cx, cy: ORBIT.cy, r: 62 }),
    svgEl(
      "text",
      { class: "orbit__hero", x: ORBIT.cx, y: ORBIT.cy + 6, "text-anchor": "middle" },
      open?.value ?? "0",
    ),
    svgEl(
      "text",
      { class: "orbit__hero-label", x: ORBIT.cx, y: ORBIT.cy + 30, "text-anchor": "middle" },
      "OPEN LOADS",
    ),
    stations,
  );

  return el(
    "div",
    { class: "card card--orbit" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, "The orbit"),
      el("span", { class: "small muted" }, open?.detail ?? ""),
    ),
    svg,
    el(
      "p",
      { class: "tiny muted" },
      "A station lights up when work is sitting in it. The table below carries the same numbers.",
    ),
  );
}

/** The readable twin of the orbit: same six numbers, as text and bars. */
function stationRail(floor) {
  const max = Math.max(1, ...floor.stations.map((station) => station.count));
  return el(
    "div",
    { class: "rail" },
    floor.stations.map((station) =>
      el(
        "article",
        { class: station.state === "live" ? "rail__station rail__station--live" : "rail__station" },
        el(
          "div",
          { class: "rail__top" },
          el("span", { class: "rail__index" }, String(station.index).padStart(2, "0")),
          el("span", { class: "rail__label" }, station.label),
          el("span", { class: "rail__state tiny" }, station.state === "live" ? "LIVE" : "IDLE"),
        ),
        el("div", { class: "rail__count" }, station.count),
        countBar(station.count, max),
        el("div", { class: "tiny muted" }, station.detail),
        el(
          "div",
          { class: "tiny muted" },
          station.lastAt ? `last ${dateTime(station.lastAt)}` : "no activity yet",
        ),
      ),
    ),
  );
}

function curveCard(floor, { onHold }) {
  const points = floor.awardedCurve;
  const readout = el("div", { class: "readout tiny muted" });

  const describe = (index) => {
    const point = index === null ? points.at(-1) : points[index];
    if (!point) {
      replace(readout, "No awards yet — the curve starts at the first one.");
      return;
    }
    replace(
      readout,
      el("strong", {}, point.reference),
      ` · awarded ${dateTime(point.at)} · this load ${usd(point.priceCents)} · cumulative `,
      el("strong", {}, usd(point.cumulativeCents)),
      index === null ? " (latest)" : "",
    );
  };

  const card = el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el(
        "h2",
        {},
        floor.scope === "supplier" ? "Cumulative value won" : "Cumulative value awarded",
      ),
      el("span", { class: "small muted" }, `${points.length} award(s)`),
    ),
    points.length === 0
      ? empty("No awards yet. The curve draws itself from the first one.")
      : cumulativeChart({
          points,
          readValue: (point) => point.cumulativeCents,
          readLabel: axisLabeller(points),
          onSelect: describe,
        }),
    readout,
    points.length > 0
      ? el(
          "details",
          { class: "table-twin" },
          el("summary", {}, "Table view"),
          el(
            "table",
            {},
            el(
              "thead",
              {},
              el(
                "tr",
                {},
                el("th", {}, "Awarded"),
                el("th", {}, "Shipment"),
                el("th", { class: "numeric" }, "This load"),
                el("th", { class: "numeric" }, "Cumulative"),
              ),
            ),
            el(
              "tbody",
              {},
              points.map((point) =>
                el(
                  "tr",
                  {},
                  el("td", {}, dateTime(point.at)),
                  el("td", {}, point.reference),
                  el("td", { class: "numeric" }, usd(point.priceCents)),
                  el("td", { class: "numeric" }, usd(point.cumulativeCents)),
                ),
              ),
            ),
          ),
        )
      : null,
  );

  // Polling that redraws under the reader's cursor is worse than a stale number.
  card.addEventListener("pointerenter", () => onHold(true));
  card.addEventListener("pointerleave", () => onHold(false));
  card.addEventListener("focusin", () => onHold(true));
  card.addEventListener("focusout", () => onHold(false));

  if (points.length > 0) describe(null);
  return card;
}

/** Like the shared badge, but it prints the label as written — event names are already prose. */
function tapeBadge(label, tone) {
  return el("span", { class: tone ? `badge badge--${tone}` : "badge" }, label);
}

function activityCard(floor) {
  if (floor.events.length === 0) {
    return el(
      "div",
      { class: "card" },
      el("h2", {}, "Tape"),
      empty("Nothing has happened on this book yet."),
    );
  }
  return el(
    "div",
    { class: "card card--flush" },
    el(
      "div",
      { class: "card__head card__head--padded" },
      el("h2", {}, "Tape"),
      el("span", { class: "small muted" }, `last ${floor.events.length} events`),
    ),
    el(
      "div",
      { class: "tape-scroll" },
      el(
        "table",
        { class: "tape" },
        el(
          "thead",
          {},
          el(
            "tr",
            {},
            el("th", {}, "Time"),
            el("th", {}, "Event"),
            el("th", {}, "Shipment"),
            el("th", {}, "Who"),
            el("th", {}, "Detail"),
          ),
        ),
        el(
          "tbody",
          {},
          floor.events.map((event) =>
            el(
              "tr",
              {},
              el("td", { class: "numeric tape__time" }, dateTime(event.createdAt)),
              el(
                "td",
                {},
                tapeBadge(
                  EVENT_LABELS[event.type] ?? titleCase(event.type.replace(":", " ")),
                  EVENT_TONE[event.type],
                ),
              ),
              el("td", { class: "tape__ref" }, event.reference),
              el(
                "td",
                { class: "tiny" },
                event.actorCompanyName ?? "—",
                event.actorName ? el("div", { class: "muted" }, event.actorName) : null,
              ),
              el("td", { class: "tiny muted" }, event.detail || "—"),
            ),
          ),
        ),
      ),
    ),
  );
}

export { compactUsd };
