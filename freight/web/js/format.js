// Display helpers. Anything the server computed (miles, bands, scores) is shown
// as the server described it — the UI never invents a number.

export const usd = (cents) =>
  cents === null || cents === undefined
    ? "—"
    : (cents / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

export const titleCase = (value) =>
  String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

export const date = (value) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

export const dateTime = (value) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

export const place = (value) => `${value.city}, ${value.region}`;

export const lane = (shipment) => `${place(shipment.origin)} → ${place(shipment.destination)}`;

export const miles = (value) =>
  value === null || value === undefined ? "distance unknown" : `~${value.toLocaleString()} mi`;

export const STATUS_TONE = {
  posted: "brand",
  awarded: "ok",
  picked_up: "ok",
  in_transit: "ok",
  delivered: "ok",
  cancelled: "danger",
  pending: "warn",
  countered: "warn",
  accepted: "ok",
  declined: "",
  withdrawn: "",
  expired: "",
  verified: "ok",
  unverified: "",
  rejected: "danger",
};
