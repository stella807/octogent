// The lane map: where this book's freight is going.
//
// It draws lanes, not vehicles. The marketplace has no AIS, ELD or telematics
// feed, so nothing here moves across the water — a load in transit is a stage
// on a lane, and the map says as much rather than animating a dot it would have
// to invent.

import { api } from "../api.js";
import { svgEl } from "../charts.js";
import { empty } from "../components.js";
import { el, replace, select } from "../dom.js";
import { date, titleCase, usd } from "../format.js";
import { fitProjection, greatCircle, pathOf } from "../geo-projection.js";

const MAP = { width: 960, height: 540 };

const STAGE_FILTERS = {
  all: { label: "All stages", matches: () => true },
  open: { label: "Open", matches: (shipment) => shipment.status === "posted" },
  motion: {
    label: "In motion",
    matches: (shipment) => ["awarded", "picked_up", "in_transit"].includes(shipment.status),
  },
  delivered: { label: "Delivered", matches: (shipment) => shipment.status === "delivered" },
};

let landCache = null;
async function loadLand() {
  landCache ??= await fetch("/data/land.json").then((response) => response.json());
  return landCache;
}

export async function renderLanes({ navigate }) {
  const [map, land] = await Promise.all([api.get("/api/lanes"), loadLand()]);

  let stage = "all";
  let selectedId = null;
  const body = el("div", { class: "lanes" });

  const filters = el(
    "div",
    { class: "card filters" },
    el(
      "div",
      { class: "field" },
      el("label", { for: "lane-stage" }, "Stage"),
      select(
        "stage",
        Object.entries(STAGE_FILTERS).map(([value, entry]) => ({ value, label: entry.label })),
        stage,
        {
          id: "lane-stage",
          onChange: (event) => {
            stage = event.target.value;
            selectedId = null;
            draw();
          },
        },
      ),
    ),
    el(
      "div",
      { class: "field" },
      el("label", {}, " "),
      el(
        "span",
        { class: "small muted" },
        `${map.totals.lanes} lane(s) · ${map.totals.shipments} shipment(s)`,
      ),
    ),
  );

  function draw() {
    const lanes = map.lanes
      .map((lane) => ({ ...lane, shipments: lane.shipments.filter(STAGE_FILTERS[stage].matches) }))
      .filter((lane) => lane.shipments.length > 0);
    if (selectedId && !lanes.some((lane) => lane.id === selectedId)) selectedId = null;

    replace(
      body,
      lanes.length === 0
        ? el("div", { class: "card" }, empty("No shipments on the map for this filter."))
        : mapCard(lanes, land, {
            selectedId,
            onSelect: (id) => {
              selectedId = id === selectedId ? null : id;
              draw();
            },
          }),
      laneTable(lanes, {
        selectedId,
        onSelect: (id) => {
          selectedId = id === selectedId ? null : id;
          draw();
        },
      }),
      selectedId
        ? laneDetail(
            lanes.find((lane) => lane.id === selectedId),
            navigate,
          )
        : null,
      footnotes(map),
    );
  }

  draw();

  return el(
    "section",
    { class: "lanes-page" },
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el("h1", {}, "Lane map"),
        el(
          "p",
          {},
          "Where this book's freight is going. Lanes and stages — not vehicle positions.",
        ),
      ),
    ),
    filters,
    body,
  );
}

function mapCard(lanes, land, { selectedId, onSelect }) {
  const endpoints = new Map();
  const note = (endpoint, role, weight) => {
    const existing = endpoints.get(endpoint.key);
    endpoints.set(endpoint.key, {
      ...endpoint,
      weight: (existing?.weight ?? 0) + weight,
      isOrigin: (existing?.isOrigin ?? false) || role === "origin",
      isDestination: (existing?.isDestination ?? false) || role === "destination",
    });
  };
  for (const lane of lanes) {
    note(lane.origin, "origin", lane.shipments.length);
    note(lane.destination, "destination", lane.shipments.length);
  }

  const project = fitProjection([...endpoints.values()], { width: MAP.width, height: MAP.height });
  const readout = el("div", { class: "readout tiny muted" });

  const describe = (lane) => {
    if (!lane) {
      replace(
        readout,
        `${lanes.length} lane(s) drawn. Hover a lane, or use Tab and Enter, to read it.`,
      );
      return;
    }
    replace(
      readout,
      el("strong", {}, `${lane.origin.label} → ${lane.destination.label}`),
      ` · ${lane.shipments.length} shipment(s)`,
      lane.estimatedMiles ? ` · ~${lane.estimatedMiles.toLocaleString()} mi estimated` : "",
      lane.crossesWater ? " · ocean leg" : " · drivable",
      lane.awardedValueCents > 0 ? ` · ${usd(lane.awardedValueCents)} awarded` : "",
    );
  };

  const maxCount = Math.max(...lanes.map((lane) => lane.shipments.length));
  const lanePaths = lanes.map((lane) => {
    const d = pathOf(greatCircle(lane.origin, lane.destination, 40), project);
    const selected = lane.id === selectedId;
    // A 2px stroke is a pinpoint target, so an invisible wide path carries the
    // pointer and the focus ring; the drawn lane stays thin.
    const hit = svgEl("path", {
      class: "lane__hit",
      d,
      tabindex: "0",
      role: "button",
      "aria-label": `${lane.origin.label} to ${lane.destination.label}, ${lane.shipments.length} shipment(s)`,
    });
    const group = svgEl(
      "g",
      { class: selected ? "lane-group lane-group--selected" : "lane-group" },
      svgEl("path", {
        class: "lane",
        d,
        "stroke-width": 1.4 + (lane.shipments.length / maxCount) * 3.2,
        "vector-effect": "non-scaling-stroke",
      }),
      hit,
    );
    hit.addEventListener("pointerenter", () => describe(lane));
    hit.addEventListener("pointerleave", () => describe(null));
    hit.addEventListener("focus", () => describe(lane));
    hit.addEventListener("blur", () => describe(null));
    hit.addEventListener("click", () => onSelect(lane.id));
    hit.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect(lane.id);
    });
    return group;
  });

  const pins = [...endpoints.values()].map((endpoint) => {
    const [x, y] = project(endpoint.lon, endpoint.lat);
    return svgEl(
      "g",
      { class: "pin" },
      // A region-precision pin is a soft disc: the freight is somewhere in here,
      // not at this dot.
      endpoint.precision === "region"
        ? svgEl("circle", { class: "pin__halo", cx: x, cy: y, r: 16 })
        : null,
      svgEl("circle", {
        class: endpoint.isOrigin ? "pin__dot" : "pin__dot pin__dot--destination",
        cx: x,
        cy: y,
        r: 4.5,
        "vector-effect": "non-scaling-stroke",
      }),
    );
  });

  const labels = placeLabels([...endpoints.values()], project);
  describe(null);

  return el(
    "div",
    { class: "card card--map" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, "Lanes"),
      el("span", { class: "small muted" }, "line weight is shipment count"),
    ),
    svgEl(
      "svg",
      {
        class: "map",
        viewBox: `0 0 ${MAP.width} ${MAP.height}`,
        "aria-hidden": "true",
      },
      svgEl("rect", { class: "map__ocean", x: 0, y: 0, width: MAP.width, height: MAP.height }),
      svgEl(
        "g",
        { class: "map__land" },
        land.rings.map((ring) =>
          svgEl("path", {
            d: `${pathOf(
              ring.map(([lon, lat]) => ({ lon, lat })),
              project,
            )}Z`,
            "vector-effect": "non-scaling-stroke",
          }),
        ),
      ),
      lanePaths,
      pins,
      labels,
    ),
    readout,
  );
}

/**
 * Selective labels: busiest endpoints first, each taking the first of four
 * positions that does not sit on a label already placed. A label that has to
 * move away from its pin gets a leader line so it still reads as belonging to
 * it; one that fits nowhere is dropped, because the table carries every name.
 */
function placeLabels(endpoints, project) {
  const CANDIDATES = [
    { dx: 10, dy: -9, anchor: "start" },
    { dx: 10, dy: 16, anchor: "start" },
    { dx: -10, dy: -9, anchor: "end" },
    { dx: -10, dy: 16, anchor: "end" },
  ];
  const placed = [];
  const nodes = [];

  for (const endpoint of [...endpoints].sort((a, b) => b.weight - a.weight).slice(0, 14)) {
    const [x, y] = project(endpoint.lon, endpoint.lat);
    const text = endpoint.precision === "region" ? `${endpoint.label} (region)` : endpoint.label;
    const width = text.length * 5.9 + 8;

    const spot = CANDIDATES.find((candidate) => {
      const left = candidate.anchor === "start" ? x + candidate.dx : x + candidate.dx - width;
      const box = {
        left,
        right: left + width,
        top: y + candidate.dy - 11,
        bottom: y + candidate.dy + 4,
      };
      return !placed.some(
        (other) =>
          box.left < other.right &&
          box.right > other.left &&
          box.top < other.bottom &&
          box.bottom > other.top,
      );
    });
    if (!spot) continue;

    const labelX = x + spot.dx;
    const labelY = y + spot.dy;
    const left = spot.anchor === "start" ? labelX : labelX - width;
    placed.push({ left, right: left + width, top: labelY - 11, bottom: labelY + 4 });

    // Anything but the default position gets a hairline back to its pin.
    if (spot !== CANDIDATES[0]) {
      nodes.push(
        svgEl("line", {
          class: "map__leader",
          x1: x,
          y1: y,
          x2: labelX + (spot.anchor === "start" ? -2 : 2),
          y2: labelY - 3,
          "vector-effect": "non-scaling-stroke",
        }),
      );
    }
    nodes.push(
      svgEl(
        "text",
        {
          class: "map__label",
          x: labelX,
          y: labelY,
          "text-anchor": spot.anchor,
          "paint-order": "stroke",
        },
        text,
      ),
    );
  }
  return nodes;
}

function laneTable(lanes, { selectedId, onSelect }) {
  return el(
    "div",
    { class: "card card--flush" },
    el(
      "div",
      { class: "card__head card__head--padded" },
      el("h2", {}, "Lanes, as a table"),
      el("span", { class: "small muted" }, "the same numbers the map draws"),
    ),
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Lane"),
          el("th", { class: "numeric" }, "Shipments"),
          el("th", {}, "Stages"),
          el("th", { class: "numeric" }, "Awarded"),
          el("th", { class: "numeric" }, "Est. miles"),
          el("th", {}, "Mode"),
        ),
      ),
      el(
        "tbody",
        {},
        lanes.map((lane) =>
          el(
            "tr",
            {
              class: lane.id === selectedId ? "is-selected" : "",
              tabindex: "0",
              onClick: () => onSelect(lane.id),
              onKeydown: (event) => {
                if (event.key !== "Enter") return;
                onSelect(lane.id);
              },
            },
            el(
              "td",
              {},
              el("div", { class: "lane-name" }, `${lane.origin.label} → ${lane.destination.label}`),
              lane.origin.precision === "region" || lane.destination.precision === "region"
                ? el("div", { class: "tiny muted" }, "one end is a region, not a city")
                : null,
            ),
            el("td", { class: "numeric" }, lane.shipments.length),
            el(
              "td",
              { class: "tiny" },
              Object.entries(lane.counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => `${titleCase(status)} ${count}`)
                .join(" · "),
            ),
            el(
              "td",
              { class: "numeric" },
              lane.awardedValueCents > 0 ? usd(lane.awardedValueCents) : "—",
            ),
            el(
              "td",
              { class: "numeric" },
              lane.estimatedMiles ? lane.estimatedMiles.toLocaleString() : "—",
            ),
            el("td", { class: "tiny" }, lane.crossesWater ? "Ocean leg" : "Drivable"),
          ),
        ),
      ),
    ),
  );
}

function laneDetail(lane, navigate) {
  if (!lane) return null;
  return el(
    "div",
    { class: "card card--flush" },
    el(
      "div",
      { class: "card__head card__head--padded" },
      el("h2", {}, `${lane.origin.label} → ${lane.destination.label}`),
      el("span", { class: "small muted" }, `${lane.shipments.length} shipment(s) on this lane`),
    ),
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "Shipment"),
          el("th", {}, "Stage"),
          el("th", {}, "Pickup"),
          el("th", {}, "Equipment"),
          el("th", {}, "Counterparty"),
          el("th", { class: "numeric" }, "Awarded"),
          el("th", {}, ""),
        ),
      ),
      el(
        "tbody",
        {},
        lane.shipments.map((shipment) =>
          el(
            "tr",
            {},
            el(
              "td",
              {},
              el("div", {}, shipment.reference),
              el(
                "div",
                { class: "tiny muted" },
                `${shipment.palletCount} pallets · ${shipment.weightLbs.toLocaleString()} lb`,
              ),
            ),
            el("td", {}, titleCase(shipment.status)),
            el(
              "td",
              { class: "tiny" },
              `${date(shipment.pickupFrom)} – ${date(shipment.pickupTo)}`,
            ),
            el("td", { class: "tiny" }, titleCase(shipment.equipment)),
            el("td", { class: "tiny" }, shipment.counterpartyName ?? "—"),
            el(
              "td",
              { class: "numeric" },
              shipment.awardedCents === null ? "—" : usd(shipment.awardedCents),
            ),
            el(
              "td",
              {},
              el(
                "button",
                { class: "btn--small", onClick: () => navigate(`#/shipments/${shipment.id}`) },
                "Open",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function footnotes(map) {
  return el(
    "div",
    { class: "card" },
    el("h2", {}, "What this map is, and is not"),
    el(
      "ul",
      { class: "notes small muted" },
      el(
        "li",
        {},
        el("strong", {}, "No live positions. "),
        "A load in transit shows as a stage on its lane. Tracking a vessel or a truck needs AIS or an ELD/telematics feed, which this platform does not have.",
      ),
      el(
        "li",
        {},
        el("strong", {}, "Arcs are great-circle paths "),
        "between the two endpoints — the shortest line over the globe, not a routed road or a published sea lane.",
      ),
      el(
        "li",
        {},
        el("strong", {}, "Mileage is a great-circle estimate "),
        "between those coordinates — city-level where the gazetteer knows the city, region centroid where it does not. It is the same number the rate band and the match score use, and it is not door-to-door distance.",
      ),
      map.totals.regionPrecisionEndpoints > 0
        ? el(
            "li",
            {},
            el(
              "strong",
              {},
              `${map.totals.regionPrecisionEndpoints} endpoint(s) are region-level. `,
            ),
            "Those cities are not in the gazetteer, so the pin is the whole state or province — drawn as a soft disc and labelled.",
          )
        : null,
      map.unplaced.length > 0
        ? el(
            "li",
            {},
            el("strong", {}, `${map.unplaced.length} shipment(s) could not be placed: `),
            map.unplaced.map((entry) => `${entry.reference} (${entry.reason})`).join("; "),
          )
        : null,
      map.totals.truncated
        ? el(
            "li",
            {},
            el("strong", {}, "Showing the most recent 500 shipments. "),
            "Older ones are not drawn.",
          )
        : null,
      el(
        "li",
        {},
        "Coastlines: Natural Earth 1:50m via world-atlas, public domain, simplified to about 5 km.",
      ),
    ),
  );
}
