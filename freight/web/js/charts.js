// Small SVG chart builders. No library, no canvas, and no inline style
// attributes — every colour comes from a class in floor.css, so the page keeps
// its `style-src 'self'` policy and follows the OS theme.
//
// Mark specs are fixed: 2px lines, a 10% area wash, an 8px end marker with a
// 2px surface ring, hairline solid gridlines, and labels only on the endpoint.

const SVG = "http://www.w3.org/2000/svg";

export function svgEl(tag, attributes = {}, ...children) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children.flat(3)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Rounds up to a clean axis maximum so ticks land on readable numbers. */
export function niceCeiling(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * Cumulative line + area for a single series. One series means no legend — the
 * card title says what is plotted — and one direct label, on the endpoint.
 *
 * `onSelect(index | null)` fires for hover and for keyboard arrows, so the
 * readout strip shows the same values either way.
 */
export function cumulativeChart({
  points,
  readValue,
  readLabel,
  width = 960,
  height = 230,
  onSelect,
  ticks = 4,
}) {
  // The box scales uniformly (no preserveAspectRatio="none"), so a marker stays
  // a circle; strokes carry vector-effect so 2px stays 2px at any width. The
  // bottom band is sized for the date labels, not just the plot.
  const pad = { top: 14, right: 78, bottom: 30, left: 64 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = niceCeiling(Math.max(...points.map(readValue), 1));
  const x = (index) =>
    pad.left + (points.length <= 1 ? plotWidth : (index / (points.length - 1)) * plotWidth);
  const y = (value) => pad.top + plotHeight - (value / max) * plotHeight;

  const axisFormat = axisFormatter(max);
  const gridlines = [];
  const tickLabels = [];
  for (let step = 0; step <= ticks; step += 1) {
    const value = (max / ticks) * step;
    const lineY = y(value);
    gridlines.push(
      svgEl("line", {
        class: "chart__grid",
        x1: pad.left,
        x2: width - pad.right,
        y1: lineY,
        y2: lineY,
        "vector-effect": "non-scaling-stroke",
      }),
    );
    tickLabels.push(
      svgEl(
        "text",
        { class: "chart__tick", x: pad.left - 8, y: lineY + 4, "text-anchor": "end" },
        axisFormat(value),
      ),
    );
  }

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(readValue(point))}`)
    .join(" ");
  const areaPath = points.length
    ? `${linePath} L${x(points.length - 1)},${pad.top + plotHeight} L${x(0)},${pad.top + plotHeight} Z`
    : "";

  // `hidden` is an HTML attribute and does nothing on an SVG element, so the
  // idle crosshair and cursor are parked with a class instead.
  const crosshair = svgEl("line", {
    class: "chart__crosshair is-hidden",
    x1: 0,
    x2: 0,
    y1: pad.top,
    y2: pad.top + plotHeight,
    "vector-effect": "non-scaling-stroke",
  });
  const cursor = svgEl("circle", {
    class: "chart__cursor is-hidden",
    r: 5,
    cx: 0,
    cy: 0,
    "vector-effect": "non-scaling-stroke",
  });

  // Only the two ends get a date: an axis label under every award is noise.
  const axisLabels = [];
  if (readLabel && points.length > 0) {
    const baseline = pad.top + plotHeight + 18;
    axisLabels.push(
      svgEl(
        "text",
        { class: "chart__tick", x: pad.left, y: baseline, "text-anchor": "start" },
        readLabel(points[0]),
      ),
    );
    if (points.length > 1) {
      axisLabels.push(
        svgEl(
          "text",
          { class: "chart__tick", x: x(points.length - 1), y: baseline, "text-anchor": "middle" },
          readLabel(points.at(-1)),
        ),
      );
    }
  }

  const last = points.at(-1);
  const endMarker = last
    ? svgEl("circle", {
        class: "chart__end",
        r: 4.5,
        cx: x(points.length - 1),
        cy: y(readValue(last)),
        "vector-effect": "non-scaling-stroke",
      })
    : null;
  const endLabel = last
    ? svgEl(
        "text",
        { class: "chart__end-label", x: x(points.length - 1) + 10, y: y(readValue(last)) + 4 },
        compactUsd(readValue(last)),
      )
    : null;

  const svg = svgEl(
    "svg",
    {
      class: "chart",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      tabindex: "0",
      "aria-label": `Cumulative awarded value across ${points.length} award(s)`,
    },
    gridlines,
    tickLabels,
    axisLabels,
    areaPath ? svgEl("path", { class: "chart__area", d: areaPath }) : null,
    points.length > 1
      ? svgEl("path", { class: "chart__line", d: linePath, "vector-effect": "non-scaling-stroke" })
      : null,
    crosshair,
    cursor,
    endMarker,
    endLabel,
  );

  let selected = null;
  const select = (index) => {
    selected = index;
    if (index === null || !points[index]) {
      crosshair.classList.add("is-hidden");
      cursor.classList.add("is-hidden");
      onSelect?.(null);
      return;
    }
    const pointX = x(index);
    const pointY = y(readValue(points[index]));
    crosshair.classList.remove("is-hidden");
    cursor.classList.remove("is-hidden");
    crosshair.setAttribute("x1", pointX);
    crosshair.setAttribute("x2", pointX);
    cursor.setAttribute("cx", pointX);
    cursor.setAttribute("cy", pointY);
    onSelect?.(index);
  };

  // The hit area is the whole plot width, not the 9px dot: nearest point wins.
  const nearest = (event) => {
    const box = svg.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    const position = ratio * width;
    let best = 0;
    for (let index = 1; index < points.length; index += 1) {
      if (Math.abs(x(index) - position) < Math.abs(x(best) - position)) best = index;
    }
    return best;
  };

  if (points.length > 0) {
    svg.addEventListener("pointermove", (event) => select(nearest(event)));
    svg.addEventListener("pointerleave", () => select(null));
    svg.addEventListener("focus", () => select(selected ?? points.length - 1));
    svg.addEventListener("blur", () => select(null));
    svg.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const start = selected ?? points.length - 1;
      select(Math.max(0, Math.min(points.length - 1, start + step)));
    });
  }

  return svg;
}

/**
 * A count bar, drawn as SVG so the length lives in a geometry attribute rather
 * than an inline style. One hue for every row — the row order carries the
 * sequence, so colour is not spent re-encoding the length.
 */
export function countBar(count, max, { width = 132, height = 8 } = {}) {
  const filled = max > 0 ? Math.round((count / max) * width) : 0;
  return svgEl(
    "svg",
    { class: "bar", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" },
    svgEl("rect", { class: "bar__track", x: 0, y: 0, width, height, rx: height / 2 }),
    count > 0
      ? svgEl("rect", {
          class: "bar__fill",
          x: 0,
          y: 0,
          width: Math.max(filled, 4),
          height,
          rx: height / 2,
        })
      : null,
  );
}

/**
 * Every tick on one axis wears the same format — mixing "$6,667" with "$13K"
 * on the same scale makes the reader convert in their head.
 */
function axisFormatter(maxCents) {
  if (maxCents >= 1_000_000) {
    return (cents) => {
      if (cents === 0) return "$0";
      const thousands = cents / 100_000;
      return `$${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}K`;
    };
  }
  return (cents) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
}

export function compactUsd(cents) {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 10_000) return `$${Math.round(dollars / 1000)}K`;
  return `$${Math.round(dollars).toLocaleString("en-US")}`;
}
