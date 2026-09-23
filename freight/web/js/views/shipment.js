// One shipment, seen by whoever opened it: the shipper gets the match list and
// every quote, a supplier gets their own negotiation and thread.

import { ApiError, api } from "../api.js";
import {
  badge,
  empty,
  exclusionList,
  matchFactors,
  matchMeter,
  messageThread,
  rateBandNote,
  shipmentSummary,
  timeline,
  verificationBadge,
} from "../components.js";
import { el, field, formValues, showFieldErrors, toast } from "../dom.js";
import { date, dateTime, lane, titleCase, usd } from "../format.js";

const NEXT_STATUS = { awarded: "picked_up", picked_up: "in_transit", in_transit: "delivered" };

export async function renderShipment({ state, params, navigate, refresh }) {
  const view = await api.shipment(params.id);
  const { shipment } = view;
  const isShipper = state.company?.id === shipment.shipperCompanyId;
  const myQuote = isShipper ? null : (view.quotes[0] ?? null);
  // One host per page for the form a button opens, so only one is ever open.
  const formHost = el("div", {});

  return el(
    "section",
    {},
    header(view, { isShipper, refresh, formHost }),
    formHost,
    el(
      "div",
      { class: "grid grid--two" },
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Shipment"),
        shipmentSummary(shipment, view.estimatedMiles),
        el("p", { class: "small muted" }, shipment.cargoDescription),
        rateBandNote(view.rateBand),
      ),
      el("div", { class: "card" }, el("h2", {}, "Activity"), timeline(view.events)),
    ),
    isShipper
      ? quotesSection(view, refresh, formHost)
      : myQuoteSection(view, myQuote, refresh, formHost),
    isShipper ? matchesSection(view) : null,
    messagesSection(view, { state, isShipper }),
  );
}

function header(view, { isShipper, refresh, formHost }) {
  const { shipment } = view;
  const actions = [];

  if (!isShipper && NEXT_STATUS[shipment.status] && shipment.awardedQuoteId) {
    const next = NEXT_STATUS[shipment.status];
    actions.push(
      el(
        "button",
        {
          class: "btn--primary",
          onClick: async () => {
            await guard(
              () => api.setShipmentStatus(shipment.id, { status: next }),
              `Marked ${titleCase(next)}`,
            );
            refresh();
          },
        },
        `Mark ${titleCase(next)}`,
      ),
    );
  }
  if (isShipper && (shipment.status === "posted" || shipment.status === "awarded")) {
    actions.push(
      el(
        "button",
        {
          class: "btn--danger",
          onClick: () =>
            openForm(formHost, {
              title: "Cancel this shipment",
              fields: [
                field(
                  "Reason (shown in the activity log)",
                  el("input", { name: "note", required: true }),
                ),
              ],
              submitLabel: "Cancel shipment",
              onSubmit: async (values) => {
                await guard(
                  () =>
                    api.setShipmentStatus(shipment.id, { status: "cancelled", note: values.note }),
                  "Shipment cancelled",
                );
                refresh();
              },
            }),
        },
        "Cancel shipment",
      ),
    );
  }

  return el(
    "div",
    { class: "page-head" },
    el(
      "div",
      {},
      el("h1", {}, lane(shipment)),
      el(
        "p",
        {},
        `${shipment.reference} · posted ${dateTime(shipment.createdAt)} · `,
        el("span", {}, view.shipperCompany.name),
        " ",
        verificationBadge(view.shipperCompany.verificationStatus),
      ),
    ),
    el("div", { class: "row-card__actions" }, badge(shipment.status), actions),
  );
}

function quotesSection(view, refresh, formHost) {
  const { shipment, quotes } = view;
  if (quotes.length === 0) {
    return el(
      "div",
      { class: "card" },
      el("h2", {}, "Quotes"),
      empty("No quotes yet. Suppliers see this load on their board."),
    );
  }

  const rows = quotes.map((quote) => {
    const latest = quote.offers.at(-1);
    const waitingOnShipper = quote.status === "pending";
    const actions = [];
    if (
      shipment.status === "posted" &&
      (quote.status === "pending" || quote.status === "countered")
    ) {
      if (waitingOnShipper) {
        actions.push(
          el(
            "button",
            {
              class: "btn--primary btn--small",
              onClick: async () => {
                await guard(() => api.acceptQuote(quote.id), `Awarded to ${quote.supplierName}`);
                refresh();
              },
            },
            "Accept & award",
          ),
          el(
            "button",
            { class: "btn--small", onClick: () => openCounter(quote, refresh, formHost) },
            "Counter",
          ),
          el(
            "button",
            {
              class: "btn--small btn--danger",
              onClick: async () => {
                await guard(() => api.declineQuote(quote.id, {}), "Quote declined");
                refresh();
              },
            },
            "Decline",
          ),
        );
      } else {
        actions.push(el("span", { class: "tiny muted" }, "Waiting on the supplier"));
      }
    }

    return el(
      "tr",
      {},
      el(
        "td",
        {},
        el("div", {}, quote.supplierName, " ", verificationBadge(quote.supplierVerification)),
        el(
          "div",
          { class: "tiny muted" },
          `${quote.offers.length} offer(s) · valid to ${dateTime(quote.validUntil)}`,
        ),
        latest?.note ? el("div", { class: "tiny muted" }, `“${latest.note}”`) : null,
      ),
      el("td", { class: "numeric" }, usd(quote.priceCents)),
      el("td", { class: "numeric" }, `${quote.transitDays} d`),
      el("td", {}, titleCase(quote.equipment)),
      el("td", {}, badge(quote.status)),
      el("td", {}, el("div", { class: "row-card__actions" }, actions)),
    );
  });

  const cheapest = Math.min(...quotes.map((quote) => quote.priceCents));
  const fastest = Math.min(...quotes.map((quote) => quote.transitDays));

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, `Quotes (${quotes.length})`),
      el("span", { class: "small muted" }, `Lowest ${usd(cheapest)} · fastest ${fastest} day(s)`),
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
          el("th", {}, "Supplier"),
          el("th", { class: "numeric" }, "Price"),
          el("th", { class: "numeric" }, "Transit"),
          el("th", {}, "Equipment"),
          el("th", {}, "Status"),
          el("th", {}, ""),
        ),
      ),
      el("tbody", {}, rows),
    ),
  );
}

function myQuoteSection(view, quote, refresh, formHost) {
  const { shipment } = view;
  if (!quote) {
    return shipment.status === "posted"
      ? el("div", { class: "card" }, el("h2", {}, "Your quote"), quoteForm(shipment, view, refresh))
      : el("div", { class: "card" }, el("h2", {}, "Your quote"), empty("This shipment is closed."));
  }

  const waitingOnMe = quote.status === "countered";
  const actions = [];
  if (
    shipment.status === "posted" &&
    (quote.status === "pending" || quote.status === "countered")
  ) {
    if (waitingOnMe) {
      actions.push(
        el(
          "button",
          {
            class: "btn--primary btn--small",
            onClick: async () => {
              await guard(() => api.acceptQuote(quote.id), "Accepted — the shipment is yours");
              refresh();
            },
          },
          "Accept counter",
        ),
        el(
          "button",
          { class: "btn--small", onClick: () => openCounter(quote, refresh, formHost) },
          "Counter back",
        ),
      );
    } else {
      actions.push(el("span", { class: "tiny muted" }, "Waiting on the shipper"));
    }
    actions.push(
      el(
        "button",
        {
          class: "btn--small btn--danger",
          onClick: async () => {
            await guard(() => api.declineQuote(quote.id, {}), "Quote withdrawn");
            refresh();
          },
        },
        "Withdraw",
      ),
    );
  }

  return el(
    "div",
    { class: "card" },
    el("div", { class: "card__head" }, el("h2", {}, "Your quote"), badge(quote.status)),
    el(
      "dl",
      { class: "meta-grid" },
      el("div", {}, el("dt", {}, "Current price"), el("dd", {}, usd(quote.priceCents))),
      el("div", {}, el("dt", {}, "Transit"), el("dd", {}, `${quote.transitDays} days`)),
      el("div", {}, el("dt", {}, "Valid until"), el("dd", {}, dateTime(quote.validUntil))),
      el("div", {}, el("dt", {}, "Terms"), el("dd", {}, quote.terms || "—")),
    ),
    el(
      "ul",
      { class: "timeline" },
      quote.offers.map((offer) =>
        el(
          "li",
          {},
          el("time", {}, dateTime(offer.createdAt)),
          el(
            "span",
            {},
            el("strong", {}, titleCase(offer.actor)),
            ` offered ${usd(offer.priceCents)} · ${offer.transitDays} d`,
            offer.note ? ` — ${offer.note}` : "",
          ),
        ),
      ),
    ),
    el("div", { class: "row-card__actions" }, actions),
  );
}

function quoteForm(shipment, view, refresh) {
  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        try {
          await api.submitQuote(shipment.id, {
            ...values,
            transitDays: Number(values.transitDays),
            validDays: Number(values.validDays || 3),
          });
          toast("Quote submitted");
          refresh();
        } catch (error) {
          if (error instanceof ApiError) {
            showFieldErrors(form, error.fields);
            toast(error.message, "error");
            return;
          }
          toast("Could not submit the quote", "error");
        }
      },
    },
    rateBandNote(view.rateBand),
    el(
      "div",
      { class: "field-row" },
      field(
        "All-in price (USD)",
        el("input", { name: "price", type: "number", min: "50", step: "25", required: true }),
      ),
      field(
        "Transit days",
        el("input", { name: "transitDays", type: "number", min: "1", max: "60", required: true }),
      ),
      field(
        "Offer valid (days)",
        el("input", { name: "validDays", type: "number", min: "1", max: "30", value: "3" }),
      ),
    ),
    field(
      "Equipment",
      el("input", { name: "equipment", value: shipment.equipment, readonly: true }),
    ),
    field(
      "Terms",
      el("textarea", { name: "terms", placeholder: "Net 30. Detention after 2 free hours." }),
    ),
    field(
      "Note to the shipper",
      el("textarea", { name: "note", placeholder: "Space on Thursday's sailing." }),
    ),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Submit quote"),
    ),
  );
  return form;
}

function openCounter(quote, refresh, formHost) {
  openForm(formHost, {
    title: `Counter ${quote.supplierName ?? "this quote"} — currently ${usd(quote.priceCents)} over ${quote.transitDays} day(s)`,
    fields: [
      el(
        "div",
        { class: "field-row" },
        field(
          "Your price (USD)",
          el("input", {
            name: "price",
            type: "number",
            min: "50",
            step: "25",
            value: String(Math.round(quote.priceCents / 100)),
            required: true,
          }),
        ),
        field(
          "Transit days",
          el("input", {
            name: "transitDays",
            type: "number",
            min: "1",
            max: "60",
            value: String(quote.transitDays),
            required: true,
          }),
        ),
      ),
      field("Note", el("input", { name: "note", placeholder: "We can meet you at this rate." })),
    ],
    submitLabel: "Send counter",
    onSubmit: async (values) => {
      await guard(
        () =>
          api.counterQuote(quote.id, {
            price: Number(values.price),
            transitDays: Number(values.transitDays),
            note: values.note ?? "",
          }),
        "Counter sent",
      );
      refresh();
    },
  });
}

/** Renders a one-off form into the page's single form host, replacing whatever was there. */
function openForm(host, { title, fields, submitLabel, onSubmit }) {
  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        form.querySelector("button[type=submit]").disabled = true;
        await onSubmit(values);
      },
    },
    ...fields,
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, submitLabel),
      el("button", { type: "button", onClick: () => host.replaceChildren() }, "Never mind"),
    ),
  );
  host.replaceChildren(el("div", { class: "card" }, el("h2", {}, title), form));
  form.querySelector("input")?.focus();
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function matchesSection(view) {
  const matches = view.matches ?? [];
  if (matches.length === 0) {
    return el(
      "div",
      { class: "card" },
      el("h2", {}, "Matching suppliers"),
      empty("No suppliers have published a profile that covers this lane yet."),
    );
  }
  const eligible = matches.filter((match) => match.eligible);
  const excluded = matches.filter((match) => !match.eligible);

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, "Matching suppliers"),
      el(
        "span",
        { class: "small muted" },
        `${eligible.length} eligible · ${excluded.length} excluded`,
      ),
    ),
    el(
      "p",
      { class: "small muted" },
      "The score ranks and explains; it never picks. Every factor below is shown with its weight and the evidence behind it.",
    ),
    el(
      "div",
      { class: "list" },
      eligible.map((match) =>
        el(
          "article",
          { class: "row-card" },
          el(
            "div",
            { class: "row-card__top" },
            el(
              "span",
              { class: "lane" },
              match.companyName,
              " ",
              verificationBadge(match.verificationStatus),
            ),
            matchMeter(match),
          ),
          matchFactors(match),
        ),
      ),
      excluded.map((match) =>
        el(
          "article",
          { class: "row-card" },
          el(
            "div",
            { class: "row-card__top" },
            el("span", { class: "lane muted" }, match.companyName),
            badge("excluded", "danger"),
          ),
          exclusionList(match),
        ),
      ),
    ),
  );
}

function messagesSection(view, { state, isShipper }) {
  const { shipment } = view;
  const container = el("div", { class: "card" }, el("h2", {}, "Messages"));

  const counterparties = isShipper
    ? [
        ...new Map([
          ...view.quotes.map((quote) => [quote.supplierCompanyId, quote.supplierName]),
          ...(view.threads ?? []).map((thread) => [thread.supplierCompanyId, thread.supplierName]),
        ]).entries(),
      ].map(([id, name]) => ({ id, name }))
    : [{ id: state.company?.id, name: view.shipperCompany.name }];

  if (counterparties.length === 0 || !counterparties[0].id) {
    container.append(empty("A thread opens as soon as a supplier quotes or asks a question."));
    return container;
  }

  const body = el("div", {});
  const picker = el(
    "select",
    {
      onChange: (event) => load(event.target.value),
    },
    counterparties.map((party) => el("option", { value: party.id }, party.name)),
  );

  async function load(supplierId) {
    const thread = await api.thread(shipment.id, supplierId);
    const form = el(
      "form",
      {
        class: "form-actions",
        onSubmit: async (event) => {
          event.preventDefault();
          const input = form.querySelector("input[name=body]");
          if (!input.value.trim()) return;
          await guard(
            () => api.sendMessage(shipment.id, supplierId, { body: input.value }),
            "Sent",
          );
          load(supplierId);
        },
      },
      el("input", { name: "body", placeholder: "Write a message…", autocomplete: "off" }),
      el("button", { class: "btn--primary", type: "submit" }, "Send"),
    );
    body.replaceChildren(messageThread(thread.messages, state.company?.id), form);
  }

  if (isShipper && counterparties.length > 1)
    container.append(el("div", { class: "field" }, el("label", {}, "Thread with"), picker));
  container.append(body);
  load(counterparties[0].id);
  return container;
}

async function guard(work, successMessage) {
  try {
    const result = await work();
    toast(successMessage);
    return result;
  } catch (error) {
    toast(error instanceof ApiError ? error.message : "Something went wrong", "error");
    return null;
  }
}

export { date };
