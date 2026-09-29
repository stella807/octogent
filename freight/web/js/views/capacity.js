// Capacity for sale.
//
// A supplier publishes a departure with space and a price; a shipper buys space
// on it at that price. Buying creates an ordinary shipment, already awarded, so
// everything downstream — the floor, the map, tracking — carries on unchanged.

import { ApiError, api } from "../api.js";
import { badge, empty, verificationBadge } from "../components.js";
import {
  checkGroup,
  checkedValues,
  el,
  field,
  formValues,
  replace,
  select,
  showFieldErrors,
  toast,
} from "../dom.js";
import { date, titleCase, usd } from "../format.js";

/** Mirrors `priceFor` in the domain. The server is still the authority — this
 *  only fills in the figure before the form is submitted. */
const previewPrice = (route, pallets) =>
  Math.max(route.pricePerPalletCents * (Number(pallets) || 0), route.minimumChargeCents);

export async function renderCapacity({ state, navigate }) {
  const isSupplier = state.company?.kind === "supplier";
  const [routes, bookings, ledger] = await Promise.all([
    api.get("/api/routes"),
    api.get("/api/bookings"),
    api.get("/api/commission"),
  ]);

  return el(
    "section",
    { class: "capacity" },
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el("h1", {}, isSupplier ? "Sell capacity" : "Buy capacity"),
        el(
          "p",
          {},
          isSupplier
            ? "Publish a departure with space on it. A shipper can buy that space at your price, without a round of bidding."
            : "Space already scheduled on a lane, at a published price. Booking it awards the load immediately.",
        ),
      ),
      isSupplier ? commissionNote(ledger) : null,
    ),
    isSupplier ? publishCard(state, navigate) : null,
    routeBoard(routes, { isSupplier, navigate }),
    bookingTable(bookings, { isSupplier, navigate }),
  );
}

function commissionNote(ledger) {
  return el(
    "div",
    { class: "notice" },
    el("strong", {}, `Platform commission ${(ledger.currentRateBps / 100).toFixed(2)}%. `),
    `Recorded on capacity you sell — ${usd(ledger.totals.commissionCents)} so far on ${usd(ledger.totals.grossCents)} booked. `,
    el(
      "span",
      { class: "muted" },
      "Recorded, not charged: no money moves through this platform yet.",
    ),
  );
}

function publishCard(state, navigate) {
  const reference = state.reference;
  const regionOptions = reference.regions.map((region) => ({
    value: region.key.split("-")[1],
    label: region.name,
  }));
  const countryOptions = [
    { value: "US", label: "United States" },
    { value: "DO", label: "Dominican Republic" },
  ];

  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        try {
          const route = await api.post("/api/routes", {
            ...values,
            capacityPallets: Number(values.capacityPallets),
            capacityWeightLbs: Number(values.capacityWeightLbs),
            cargoTypes: checkedValues(form, "cargoTypes"),
            capabilities: checkedValues(form, "capabilities"),
          });
          toast(`Published ${route.reference}`);
          navigate(`#/capacity/${route.id}`);
        } catch (error) {
          if (error instanceof ApiError) {
            showFieldErrors(form, error.fields);
            toast(error.message, "error");
            return;
          }
          toast("Could not publish the departure", "error");
        }
      },
    },
    el(
      "fieldset",
      {},
      el("legend", {}, "Lane"),
      el(
        "div",
        { class: "field-row" },
        field("Origin city", el("input", { name: "originCity", required: true, value: "Miami" })),
        field("Origin region", select("originRegion", regionOptions, "FL")),
        field("Origin country", select("originCountry", countryOptions, "US")),
      ),
      el(
        "div",
        { class: "field-row" },
        field(
          "Destination city",
          el("input", { name: "destinationCity", required: true, value: "San Juan" }),
        ),
        field("Destination region", select("destinationRegion", regionOptions, "PR")),
        field("Destination country", select("destinationCountry", countryOptions, "US")),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Departure"),
      el(
        "div",
        { class: "field-row" },
        field("Departs", el("input", { name: "departsOn", type: "date", required: true })),
        field("Arrives by", el("input", { name: "arrivesBy", type: "date", required: true })),
        field("Booking closes", el("input", { name: "bookingCutoff", type: "date" })),
      ),
      field(
        "Equipment",
        select(
          "equipment",
          reference.equipment.map((value) => ({ value, label: titleCase(value) })),
          "dry_van",
        ),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Space and price"),
      el(
        "div",
        { class: "field-row" },
        field(
          "Pallet spaces",
          el("input", {
            name: "capacityPallets",
            type: "number",
            min: "1",
            required: true,
            value: "20",
          }),
        ),
        field(
          "Weight limit (lb)",
          el("input", {
            name: "capacityWeightLbs",
            type: "number",
            min: "1",
            required: true,
            value: "44000",
          }),
        ),
        field(
          "Price per pallet (USD)",
          el("input", {
            name: "pricePerPallet",
            type: "number",
            min: "10",
            step: "5",
            required: true,
          }),
        ),
        field(
          "Minimum charge (USD)",
          el("input", { name: "minimumCharge", type: "number", min: "0", step: "25" }),
        ),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "What this service accepts"),
      el(
        "div",
        { class: "field" },
        el("label", {}, "Cargo types"),
        checkGroup(
          "cargoTypes",
          reference.cargoTypes.map((value) => ({ value, label: titleCase(value) })),
        ),
      ),
      el(
        "div",
        { class: "field" },
        el("label", {}, "Capabilities offered"),
        checkGroup(
          "capabilities",
          reference.specialRequirements.map((value) => ({ value, label: titleCase(value) })),
        ),
      ),
      el(
        "p",
        { class: "tiny muted" },
        "Leaving cargo types empty means this departure accepts anything you are willing to carry.",
      ),
    ),
    field(
      "Notes shown to shippers",
      el("textarea", {
        name: "notes",
        placeholder: "Twice-weekly sailing, own drayage both ends.",
      }),
    ),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Publish departure"),
    ),
  );

  return el("details", { class: "card publish" }, el("summary", {}, "Publish a departure"), form);
}

function routeBoard(routes, { isSupplier, navigate }) {
  if (routes.length === 0) {
    return el(
      "div",
      { class: "card" },
      el("h2", {}, isSupplier ? "Your departures" : "Departures for sale"),
      empty(isSupplier ? "Nothing published yet." : "No capacity on sale right now."),
    );
  }
  return el(
    "div",
    { class: "card card--flush" },
    el(
      "div",
      { class: "card__head card__head--padded" },
      el("h2", {}, isSupplier ? "Your departures" : "Departures for sale"),
      el("span", { class: "small muted" }, `${routes.length} departure(s)`),
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
          el("th", {}, "Departs"),
          el("th", {}, isSupplier ? "" : "Carrier"),
          el("th", { class: "numeric" }, "Space left"),
          el("th", { class: "numeric" }, "Per pallet"),
          el("th", {}, "Status"),
          el("th", {}, ""),
        ),
      ),
      el(
        "tbody",
        {},
        routes.map((route) =>
          el(
            "tr",
            {},
            el(
              "td",
              {},
              el(
                "div",
                { class: "lane-name" },
                `${route.origin.city}, ${route.origin.region} → ${route.destination.city}, ${route.destination.region}`,
              ),
              el(
                "div",
                { class: "tiny muted" },
                `${route.reference} · ${titleCase(route.equipment)}`,
              ),
            ),
            el(
              "td",
              { class: "tiny" },
              el("div", {}, date(route.departsOn)),
              el("div", { class: "muted" }, `arrives ${date(route.arrivesBy)}`),
            ),
            el(
              "td",
              { class: "tiny" },
              isSupplier
                ? ""
                : el(
                    "span",
                    {},
                    route.supplierName,
                    " ",
                    verificationBadge(route.supplierVerification),
                  ),
            ),
            el(
              "td",
              { class: "numeric" },
              el("div", {}, `${route.remaining.pallets} / ${route.capacityPallets}`),
              el(
                "div",
                { class: "tiny muted" },
                `${route.remaining.weightLbs.toLocaleString()} lb`,
              ),
            ),
            el("td", { class: "numeric" }, usd(route.pricePerPalletCents)),
            el(
              "td",
              {},
              badge(route.sellable ? "on sale" : route.status, route.sellable ? "ok" : ""),
            ),
            el(
              "td",
              {},
              el(
                "button",
                { class: "btn--small", onClick: () => navigate(`#/capacity/${route.id}`) },
                isSupplier ? "Manage" : "Book space",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function bookingTable(bookings, { isSupplier, navigate }) {
  if (bookings.length === 0) return null;
  return el(
    "div",
    { class: "card card--flush" },
    el(
      "div",
      { class: "card__head card__head--padded" },
      el("h2", {}, isSupplier ? "Space you have sold" : "Your bookings"),
      el("span", { class: "small muted" }, `${bookings.length} booking(s)`),
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
          el("th", {}, "Booking"),
          el("th", {}, "Lane"),
          el("th", {}, "Departs"),
          el("th", { class: "numeric" }, "Pallets"),
          el("th", { class: "numeric" }, isSupplier ? "Sold for" : "Price"),
          isSupplier ? el("th", { class: "numeric" }, "Commission") : null,
          el("th", {}, "Load"),
          el("th", {}, ""),
        ),
      ),
      el(
        "tbody",
        {},
        bookings.map((booking) =>
          el(
            "tr",
            {},
            el(
              "td",
              {},
              el("div", {}, booking.reference),
              el(
                "div",
                { class: "tiny muted" },
                isSupplier ? booking.shipperName : booking.supplierName,
              ),
            ),
            el("td", { class: "tiny" }, booking.lane),
            el("td", { class: "tiny" }, date(booking.departsOn)),
            el("td", { class: "numeric" }, booking.pallets),
            el("td", { class: "numeric" }, usd(booking.priceCents)),
            isSupplier
              ? el(
                  "td",
                  { class: "numeric" },
                  el("div", {}, usd(booking.commissionCents)),
                  el(
                    "div",
                    { class: "tiny muted" },
                    `${(booking.commissionBps / 100).toFixed(2)}%`,
                  ),
                )
              : null,
            el(
              "td",
              {},
              booking.shipmentStatus ? badge(booking.shipmentStatus) : badge(booking.status),
            ),
            el(
              "td",
              {},
              el(
                "button",
                {
                  class: "btn--small",
                  onClick: () => navigate(`#/shipments/${booking.shipmentId}`),
                },
                "Open load",
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export async function renderRoute({ state, params, navigate, refresh }) {
  const isSupplier = state.company?.kind === "supplier";
  const route = await api.get(`/api/routes/${params.id}`);

  return el(
    "section",
    { class: "capacity" },
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el(
          "h1",
          {},
          `${route.origin.city}, ${route.origin.region} → ${route.destination.city}, ${route.destination.region}`,
        ),
        el(
          "p",
          {},
          `${route.reference} · departs ${date(route.departsOn)} · arrives ${date(route.arrivesBy)} · `,
          route.supplierName,
          " ",
          verificationBadge(route.supplierVerification),
        ),
      ),
      el(
        "div",
        { class: "row-card__actions" },
        badge(route.sellable ? "on sale" : route.status, route.sellable ? "ok" : ""),
      ),
    ),
    el(
      "div",
      { class: "card" },
      el("h2", {}, "The departure"),
      el(
        "dl",
        { class: "meta-grid" },
        entry("Equipment", titleCase(route.equipment)),
        entry("Space left", `${route.remaining.pallets} of ${route.capacityPallets} pallets`),
        entry("Weight left", `${route.remaining.weightLbs.toLocaleString()} lb`),
        entry("Price per pallet", usd(route.pricePerPalletCents)),
        entry(
          "Minimum charge",
          route.minimumChargeCents > 0 ? usd(route.minimumChargeCents) : "None",
        ),
        entry("Booking closes", date(route.bookingCutoff)),
        entry(
          "Distance",
          route.estimatedMiles
            ? `~${route.estimatedMiles.toLocaleString()} mi estimated`
            : "unknown",
        ),
        entry(
          "Accepts",
          route.cargoTypes.length > 0 ? route.cargoTypes.map(titleCase).join(", ") : "Any cargo",
        ),
        entry(
          "Offers",
          route.capabilities.length > 0 ? route.capabilities.map(titleCase).join(", ") : "—",
        ),
      ),
      route.notes ? el("p", { class: "small muted" }, route.notes) : null,
    ),
    isSupplier ? manageCard(route, refresh) : bookCard(route, state, navigate),
  );
}

function entry(label, value) {
  return el("div", {}, el("dt", {}, label), el("dd", {}, value));
}

function bookCard(route, state, navigate) {
  if (!route.sellable) {
    return el(
      "div",
      { class: "card" },
      el("h2", {}, "Book space"),
      empty("This departure is not taking bookings."),
    );
  }
  const priceLine = el("div", { class: "notice" });
  const update = () => {
    const pallets = Number(form.querySelector("input[name=pallets]").value) || 0;
    replace(
      priceLine,
      el("strong", {}, usd(previewPrice(route, pallets))),
      ` for ${pallets} pallet(s) at ${usd(route.pricePerPalletCents)} each`,
      route.minimumChargeCents > 0 ? ` (minimum ${usd(route.minimumChargeCents)})` : "",
      el("span", { class: "muted" }, " — the price is confirmed by the server when you book."),
    );
  };

  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        try {
          const result = await api.post(`/api/routes/${route.id}/bookings`, {
            ...values,
            pallets: Number(values.pallets),
            weightLbs: Number(values.weightLbs),
            specialRequirements: checkedValues(form, "specialRequirements"),
          });
          toast(`Booked ${result.booking.reference} — ${usd(result.booking.priceCents)}`);
          navigate(`#/shipments/${result.shipment.id}`);
        } catch (error) {
          if (error instanceof ApiError) {
            showFieldErrors(form, error.fields);
            toast(error.message, "error");
            return;
          }
          toast("Could not book that space", "error");
        }
      },
    },
    el(
      "div",
      { class: "field-row" },
      field(
        "Pallets",
        el("input", {
          name: "pallets",
          type: "number",
          min: "1",
          max: String(route.remaining.pallets),
          value: "1",
          required: true,
          onInput: () => update(),
        }),
      ),
      field(
        "Weight (lb)",
        el("input", {
          name: "weightLbs",
          type: "number",
          min: "1",
          max: String(route.remaining.weightLbs),
          required: true,
        }),
      ),
      field(
        "Cargo type",
        select(
          "cargoType",
          (route.cargoTypes.length > 0 ? route.cargoTypes : state.reference.cargoTypes).map(
            (value) => ({
              value,
              label: titleCase(value),
            }),
          ),
          route.cargoTypes[0] ?? "general_palletized",
        ),
      ),
    ),
    field(
      "What is on the pallets",
      el("textarea", {
        name: "cargoDescription",
        required: true,
        placeholder: "8 pallets of shelf-stable groceries, stackable",
      }),
    ),
    el(
      "div",
      { class: "field" },
      el("label", {}, "Services needed"),
      checkGroup(
        "specialRequirements",
        route.capabilities.map((value) => ({ value, label: titleCase(value) })),
      ),
      route.capabilities.length === 0
        ? el("p", { class: "tiny muted" }, "This departure lists no extra services.")
        : null,
    ),
    priceLine,
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Book this space"),
    ),
  );

  update();
  return el(
    "div",
    { class: "card" },
    el("h2", {}, "Book space"),
    el(
      "p",
      { class: "small muted" },
      "Booking awards the load to this carrier immediately at the published price. It then behaves like any other shipment.",
    ),
    form,
  );
}

function manageCard(route, refresh) {
  const close = async (status, label) => {
    try {
      await api.post(`/api/routes/${route.id}/status`, { status });
      toast(label);
      refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Could not update the departure", "error");
    }
  };

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, "This departure"),
      el(
        "span",
        { class: "small muted" },
        `${route.booked.count} booking(s), ${route.booked.pallets} pallet(s) sold`,
      ),
    ),
    el(
      "div",
      { class: "row-card__actions" },
      route.status === "open"
        ? el(
            "button",
            { onClick: () => close("closed", "Departure closed to new bookings") },
            "Stop selling",
          )
        : el("button", { onClick: () => close("open", "Departure back on sale") }, "Sell again"),
      el(
        "button",
        { class: "btn--danger", onClick: () => close("cancelled", "Departure cancelled") },
        "Cancel departure",
      ),
    ),
    el(
      "p",
      { class: "tiny muted" },
      "Cancelling is refused while bookings are still live — settle those with the shipper first.",
    ),
  );
}
