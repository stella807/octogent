// Shipper surfaces: the load list and the posting form.

import { ApiError, api } from "../api.js";
import { badge, empty } from "../components.js";
import {
  checkGroup,
  checkedValues,
  el,
  field,
  formValues,
  select,
  showFieldErrors,
  toast,
} from "../dom.js";
import { date, lane, titleCase, usd } from "../format.js";

export async function renderShipmentList({ state, navigate }) {
  const shipments = await api.shipments();
  const isShipper = state.company?.kind === "shipper";

  const head = el(
    "div",
    { class: "page-head" },
    el(
      "div",
      {},
      el("h1", {}, isShipper ? "Your shipments" : "Shipments you are on"),
      el("p", {}, `${shipments.length} total`),
    ),
    isShipper
      ? el(
          "button",
          { class: "btn--primary", onClick: () => navigate("#/shipments/new") },
          "Post a shipment",
        )
      : null,
  );

  if (shipments.length === 0) {
    return el(
      "section",
      {},
      head,
      empty(isShipper ? "No shipments yet. Post your first load." : "No shipments yet."),
    );
  }

  return el(
    "section",
    {},
    head,
    el(
      "div",
      { class: "list" },
      shipments.map((shipment) =>
        el(
          "article",
          { class: "row-card" },
          el(
            "div",
            { class: "row-card__top" },
            el(
              "span",
              { class: "lane" },
              lane(shipment),
              el("span", {}, ` · ${shipment.reference}`),
            ),
            badge(shipment.status),
          ),
          el(
            "div",
            { class: "row-card__meta" },
            el("span", {}, `Pickup ${date(shipment.pickupFrom)} – ${date(shipment.pickupTo)}`),
            el("span", {}, titleCase(shipment.equipment)),
            el(
              "span",
              {},
              `${shipment.palletCount} pallets · ${shipment.weightLbs.toLocaleString()} lb`,
            ),
            el("span", {}, `Target ${usd(shipment.targetPriceCents)}`),
          ),
          el(
            "div",
            { class: "row-card__actions" },
            el(
              "button",
              { class: "btn--small", onClick: () => navigate(`#/shipments/${shipment.id}`) },
              "Open",
            ),
          ),
        ),
      ),
    ),
  );
}

export async function renderNewShipment({ state, navigate }) {
  const reference = state.reference;
  const suppliers = await api.suppliers();
  const regionOptions = reference.regions.map((region) => ({
    value: region.key.split("-")[1],
    label: region.name,
  }));
  const countryOptions = [
    { value: "US", label: "United States" },
    { value: "DO", label: "Dominican Republic" },
  ];

  const invitePicker = el(
    "div",
    { class: "check-grid", id: "invite-picker", hidden: true },
    suppliers.map((supplier) =>
      el(
        "label",
        {},
        el("input", { type: "checkbox", name: "invitedCompanyIds", value: supplier.id }),
        `${supplier.name} — ${supplier.serviceRegions.join(", ")} · ${supplier.verificationStatus}`,
      ),
    ),
  );

  const visibility = select(
    "visibility",
    [
      { value: "marketplace", label: "Marketplace — every eligible supplier can see it" },
      { value: "invited", label: "Invited only — suppliers I choose" },
    ],
    "marketplace",
    {
      onChange: (event) => {
        invitePicker.hidden = event.target.value !== "invited";
      },
    },
  );

  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        const payload = {
          ...values,
          palletCount: Number(values.palletCount || 0),
          weightLbs: Number(values.weightLbs || 0),
          lengthIn: Number(values.lengthIn || 0),
          widthIn: Number(values.widthIn || 0),
          heightIn: Number(values.heightIn || 0),
          specialRequirements: checkedValues(form, "specialRequirements"),
          invitedCompanyIds: checkedValues(form, "invitedCompanyIds"),
        };
        try {
          const shipment = await api.postShipment(payload);
          toast(`Posted ${shipment.reference}`);
          navigate(`#/shipments/${shipment.id}`);
        } catch (error) {
          if (error instanceof ApiError) {
            showFieldErrors(form, error.fields);
            toast(error.message, "error");
            return;
          }
          toast("Could not post the shipment", "error");
        }
      },
    },
    el(
      "fieldset",
      {},
      el("legend", {}, "Route"),
      el(
        "div",
        { class: "field-row" },
        field("Origin city", el("input", { name: "originCity", required: true })),
        field("Origin region", select("originRegion", regionOptions, "FL")),
        field("Origin country", select("originCountry", countryOptions, "US")),
      ),
      el(
        "div",
        { class: "field-row" },
        field("Destination city", el("input", { name: "destinationCity", required: true })),
        field("Destination region", select("destinationRegion", regionOptions, "PR")),
        field("Destination country", select("destinationCountry", countryOptions, "US")),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Schedule"),
      el(
        "div",
        { class: "field-row" },
        field("Pickup from", el("input", { name: "pickupFrom", type: "date", required: true })),
        field("Pickup to", el("input", { name: "pickupTo", type: "date", required: true })),
        field("Deliver by (optional)", el("input", { name: "deliverBy", type: "date" })),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Cargo"),
      el(
        "div",
        { class: "field-row" },
        field(
          "Cargo type",
          select(
            "cargoType",
            reference.cargoTypes.map((value) => ({ value, label: titleCase(value) })),
            "general_palletized",
          ),
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
      field(
        "Description",
        el("textarea", {
          name: "cargoDescription",
          required: true,
          placeholder: "8 pallets of shelf-stable groceries, stackable",
        }),
      ),
      el(
        "div",
        { class: "field-row" },
        field(
          "Pallets",
          el("input", { name: "palletCount", type: "number", min: "0", value: "0" }),
        ),
        field(
          "Weight (lb)",
          el("input", { name: "weightLbs", type: "number", min: "1", required: true }),
        ),
        field(
          "Target price (USD)",
          el("input", { name: "targetPrice", type: "number", min: "50", step: "50" }),
        ),
      ),
      el(
        "div",
        { class: "field-row" },
        field("Length (in)", el("input", { name: "lengthIn", type: "number", min: "0" })),
        field("Width (in)", el("input", { name: "widthIn", type: "number", min: "0" })),
        field("Height (in)", el("input", { name: "heightIn", type: "number", min: "0" })),
      ),
      el(
        "div",
        { class: "field" },
        el("label", {}, "Special requirements"),
        checkGroup(
          "specialRequirements",
          reference.specialRequirements.map((value) => ({ value, label: titleCase(value) })),
        ),
        el(
          "p",
          { class: "tiny muted" },
          "Suppliers who have not declared these capabilities are excluded from matching, not just ranked lower.",
        ),
      ),
    ),
    el(
      "fieldset",
      {},
      el("legend", {}, "Who can see it"),
      field("Visibility", visibility),
      invitePicker,
    ),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Post shipment"),
      el("button", { type: "button", onClick: () => navigate("#/shipments") }, "Cancel"),
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
        el("h1", {}, "Post a shipment"),
        el("p", {}, "Matching runs as soon as you post."),
      ),
    ),
    el("div", { class: "card" }, form),
  );
}
