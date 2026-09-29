// Web-Mercator projection and great-circle interpolation.
//
// The arcs this draws are great-circle paths between two coordinates — the
// shortest line over the globe, which is what makes them curve. They are not
// routed roads or published sea lanes, and the map says so on screen.

const DEGREES = 180 / Math.PI;

/** Mercator y, kept in degree-equivalent units so x and y share one scale. */
export function mercatorY(lat) {
  const clamped = Math.max(-85, Math.min(85, lat));
  return DEGREES * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

/**
 * Fits the given points into the box with one uniform scale, so the map is
 * conformal — no stretching to fill the frame.
 */
export function fitProjection(points, { width, height, padding = 0.12, minSpanDegrees = 9 }) {
  const xs = points.map((point) => point.lon);
  const ys = points.map((point) => mercatorY(point.lat));
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  // A single lane must not zoom to street level.
  const growTo = (min, max, span) => {
    const short = span - (max - min);
    if (short <= 0) return [min, max];
    return [min - short / 2, max + short / 2];
  };
  [minX, maxX] = growTo(minX, maxX, minSpanDegrees);
  [minY, maxY] = growTo(minY, maxY, minSpanDegrees * 0.6);

  const padX = (maxX - minX) * padding;
  const padY = (maxY - minY) * padding;
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;

  const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;

  return (lon, lat) => [offsetX + (lon - minX) * scale, offsetY + (maxY - mercatorY(lat)) * scale];
}

/** Points along the great circle from a to b, inclusive of both ends. */
export function greatCircle(a, b, segments = 32) {
  const toRad = Math.PI / 180;
  const [lat1, lon1, lat2, lon2] = [a.lat * toRad, a.lon * toRad, b.lat * toRad, b.lon * toRad];
  const delta =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (delta === 0) return [a, b];

  const points = [];
  for (let step = 0; step <= segments; step += 1) {
    const fraction = step / segments;
    const scaleA = Math.sin((1 - fraction) * delta) / Math.sin(delta);
    const scaleB = Math.sin(fraction * delta) / Math.sin(delta);
    const x = scaleA * Math.cos(lat1) * Math.cos(lon1) + scaleB * Math.cos(lat2) * Math.cos(lon2);
    const y = scaleA * Math.cos(lat1) * Math.sin(lon1) + scaleB * Math.cos(lat2) * Math.sin(lon2);
    const z = scaleA * Math.sin(lat1) + scaleB * Math.sin(lat2);
    points.push({
      lat: Math.atan2(z, Math.hypot(x, y)) / toRad,
      lon: Math.atan2(y, x) / toRad,
    });
  }
  return points;
}

export function pathOf(points, project) {
  return points
    .map((point, index) => {
      const [x, y] = project(point.lon, point.lat);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}
