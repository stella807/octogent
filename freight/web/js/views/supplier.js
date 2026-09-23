// Supplier surfaces: the capability profile matching reads, the opportunity
// board, and the quotes in flight.

import { ApiError, api } from "../api.js";
import { badge, empty, matchFactors, matchMeter, rateBandNote } from "../components.js";
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
import { date, dateTime, lane, miles, titleCase, usd } from "../format.js";

export async function renderSupplierProfile({ state }) {
  const profile = await api.supplierProfile();
  const reference = state.reference;

  const laneList = el(
    "div",
    { class: "list" },
    profile.lanes.map((item) => laneRow(reference, item)),
  );

  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const lanes = [...laneList.querySelectorAll("[data-lane]")].map((row) => ({
          origin: row.querySelector("[name=laneOrigin]").value,
          destination: row.querySelector("[name=laneDestination]").value,
        }));
        try {
          await api.saveSupplierProfile({
            equipment: checkedValues(form, "equipment"),
            cargoTypes: checkedValues(form, "cargoTypes"),
            capabilities: checkedValues(form, "capabilities"),
            serviceRegions: checkedValues(form, "serviceRegions"),
            lanes,
            blackoutDates: values.blackoutDates
              ? values.blackoutDates.split(/[,\s]+/).filter(Boolean)
              : [],
            maxWeightLbs: Number(values.maxWeightLbs || 0),
            ratePerMile: values.ratePerMile === "" ? "" : Number(values.ratePerMile),
            notes: values.notes,
          });
          toast("Profile saved — matching uses it immediately");
        } catch (error) {
          if (error instanceof ApiError) {
            showFieldErrors(form, error.fields);
            toast(error.message, "error");
            return;
          }
          toast("Could not save the profile", "error");
        }
      },
    },
    el(
      "fieldset",
      {},
      el("legend", {}, "Equipment"),
      checkGroup(
        "equipment",
        reference.equipment.map((value) => ({ value, label: titleCase(value) })),
        profile.equipment,
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Cargo you handle"),
      checkGroup(
        "cargoTypes",
        reference.cargoTypes.map((value) => ({ value, label: titleCase(value) })),
        profile.cargoTypes,
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Capabilities"),
      checkGroup(
        "capabilities",
        reference.specialRequirements.map((value) => ({ value, label: titleCase(value) })),
        profile.capabilities,
      ),
      el(
        "p",
        { class: "tiny muted" },
        "A shipment requiring a capability you have not declared will not reach you.",
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Regions served"),
      checkGroup(
        "serviceRegions",
        reference.regions.map((region) => ({ value: region.key, label: region.name })),
        profile.serviceRegions,
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Lanes you run"),
      laneList,
      el(
        "button",
        {
          type: "button",
          class: "btn--small",
          onClick: () =>
            laneList.append(laneRow(reference, { origin: "US-FL", destination: "US-PR" })),
        },
        "Add a lane",
      ),
    ),
    el(
      "div",
      { class: "field-row" },
      field(
        "Max weight (lb)",
        el("input", {
          name: "maxWeightLbs",
          type: "number",
          min: "0",
          value: String(profile.maxWeightLbs),
        }),
      ),
      field(
        "Published rate per mile (USD)",
        el("input", {
          name: "ratePerMile",
          type: "number",
          step: "0.05",
          min: "0",
          value:
            profile.ratePerMileCents === null ? "" : (profile.ratePerMileCents / 100).toFixed(2),
        }),
      ),
      field(
        "Blackout dates",
        el("input", {
          name: "blackoutDates",
          placeholder: "2026-10-05, 2026-10-06",
          value: profile.blackoutDates.join(", "),
        }),
      ),
    ),
    field("Notes shown to shippers", el("textarea", { name: "notes", value: profile.notes })),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Save profile"),
    ),
  );

  return el(
    "section",
    {},
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el("h1", {}, "Your capabilities"),
        el(
          "p",
          {},
          "This profile is what the matching engine reads. Blank fields lower your score honestly, they do not hide it.",
        ),
      ),
      el("span", { class: "small muted" }, `Updated ${dateTime(profile.updatedAt)}`),
    ),
    el("div", { class: "card" }, form),
  );
}

function laneRow(reference, value) {
  const options = reference.regions.map((region) => ({ value: region.key, label: region.name }));
  const row = el(
    "div",
    { class: "field-row", dataset: { lane: "1" } },
    field("From", select("laneOrigin", options, value.origin)),
    field("To", select("laneDestination", options, value.destination)),
    el(
      "div",
      { class: "field" },
      el("label", {}, " "),
      el(
        "button",
        { type: "button", class: "btn--small btn--danger", onClick: () => row.remove() },
        "Remove",
      ),
    ),
  );
  return row;
}

export async function renderOpportunities({ state, navigate }) {
  const reference = state.reference;
  const results = el("div", { class: "list" });

  const filters = el(
    "form",
    {
      class: "filters",
      onSubmit: (event) => {
        event.preventDefault();
        load();
      },
    },
    field(
      "Origin",
      select("originRegion", [{ value: "", label: "Any" }, ...regionOptions(reference)], ""),
    ),
    field(
      "Destination",
      select("destinationRegion", [{ value: "", label: "Any" }, ...regionOptions(reference)], ""),
    ),
    field(
      "Equipment",
      select("equipment", [{ value: "", label: "Any" }, ...enumOptions(reference.equipment)], ""),
    ),
    field(
      "Cargo",
      select("cargoType", [{ value: "", label: "Any" }, ...enumOptions(reference.cargoTypes)], ""),
    ),
    field("Pickup from", el("input", { name: "pickupFrom", type: "date" })),
    field("Pickup to", el("input", { name: "pickupTo", type: "date" })),
    field("Max miles", el("input", { name: "maxMiles", type: "number", min: "0" })),
    el(
      "div",
      { class: "field" },
      el("label", {}, " "),
      el("button", { class: "btn--primary", type: "submit" }, "Apply"),
    ),
  );

  async function load() {
    const query = new URLSearchParams(
      Object.entries(formValues(filters)).filter(([, value]) => value !== ""),
    ).toString();
    try {
      const opportunities = await api.opportunities(query);
      replace(
        results,
        opportunities.length === 0
          ? empty("Nothing matches those filters right now.")
          : opportunities.map((opportunity) => opportunityCard(opportunity, navigate)),
      );
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Could not load opportunities", "error");
    }
  }

  await load();

  return el(
    "section",
    {},
    el(
      "div",
      { class: "page-head" },
      el(
        "div",
        {},
        el("h1", {}, "Opportunities"),
        el("p", {}, "Loads you are eligible for, ranked by fit with your profile."),
      ),
    ),
    el("div", { class: "card" }, filters),
    results,
  );
}

function opportunityCard(opportunity, navigate) {
  const { shipment, match, rateBand } = opportunity;
  return el(
    "article",
    { class: "row-card" },
    el(
      "div",
      { class: "row-card__top" },
      el("span", { class: "lane" }, lane(shipment), el("span", {}, ` · ${shipment.reference}`)),
      matchMeter(match),
    ),
    el(
      "div",
      { class: "row-card__meta" },
      el("span", {}, `Pickup ${date(shipment.pickupFrom)} – ${date(shipment.pickupTo)}`),
      el("span", {}, titleCase(shipment.equipment)),
      el("span", {}, `${shipment.palletCount} pallets · ${shipment.weightLbs.toLocaleString()} lb`),
      el("span", {}, miles(opportunity.estimatedMiles)),
      el("span", {}, `${opportunity.quoteCount} quote(s) in`),
      shipment.targetPriceCents
        ? el("span", {}, `Shipper target ${usd(shipment.targetPriceCents)}`)
        : null,
    ),
    rateBandNote(rateBand),
    matchFactors(match),
    el(
      "div",
      { class: "row-card__actions" },
      opportunity.myQuote
        ? el(
            "span",
            {},
            "Your quote: ",
            usd(opportunity.myQuote.priceCents),
            " ",
            badge(opportunity.myQuote.status),
          )
        : null,
      el(
        "button",
        { class: "btn--primary btn--small", onClick: () => navigate(`#/shipments/${shipment.id}`) },
        opportunity.myQuote ? "Open negotiation" : "Quote this load",
      ),
    ),
  );
}

export async function renderMyQuotes({ navigate }) {
  const quotes = await api.myQuotes();
  if (quotes.length === 0) {
    return el(
      "section",
      {},
      el("h1", {}, "Your quotes"),
      empty("No quotes yet. Start from the opportunity board."),
    );
  }
  return el(
    "section",
    {},
    el(
      "div",
      { class: "page-head" },
      el("div", {}, el("h1", {}, "Your quotes"), el("p", {}, `${quotes.length} total`)),
    ),
    el(
      "div",
      { class: "card card--flush" },
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
            el("th", { class: "numeric" }, "Price"),
            el("th", { class: "numeric" }, "Transit"),
            el("th", {}, "Status"),
            el("th", {}, "Waiting on"),
            el("th", {}, ""),
          ),
        ),
        el(
          "tbody",
          {},
          quotes.map((quote) =>
            el(
              "tr",
              {},
              el(
                "td",
                {},
                quote.shipment ? el("div", { class: "lane" }, lane(quote.shipment)) : "—",
                quote.shipment
                  ? el(
                      "div",
                      { class: "tiny muted" },
                      `${quote.shipment.reference} · pickup ${date(quote.shipment.pickupFrom)}`,
                    )
                  : null,
              ),
              el("td", { class: "numeric" }, usd(quote.priceCents)),
              el("td", { class: "numeric" }, `${quote.transitDays} d`),
              el("td", {}, badge(quote.status)),
              el("td", {}, quote.awaiting ? titleCase(quote.awaiting) : "—"),
              el(
                "td",
                {},
                quote.shipment
                  ? el(
                      "button",
                      {
                        class: "btn--small",
                        onClick: () => navigate(`#/shipments/${quote.shipment.id}`),
                      },
                      "Open",
                    )
                  : null,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

const regionOptions = (reference) =>
  reference.regions.map((region) => ({ value: region.key, label: region.name }));
const enumOptions = (values) => values.map((value) => ({ value, label: titleCase(value) }));
