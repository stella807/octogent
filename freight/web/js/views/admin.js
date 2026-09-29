// Platform administration: verification decisions and the totals behind them.

import { ApiError, api } from "../api.js";
import { badge, empty } from "../components.js";
import { el, formValues, toast } from "../dom.js";
import { dateTime, titleCase, usd } from "../format.js";

export async function renderAdmin({ refresh }) {
  const [companies, stats, ledger] = await Promise.all([
    api.adminCompanies(),
    api.adminStats(),
    api.get("/api/commission"),
  ]);

  const statCards = el(
    "div",
    { class: "grid grid--stats" },
    stat("Shippers", stats.companies.shippers),
    stat("Suppliers", stats.companies.suppliers),
    stat("Awaiting verification", stats.companies.pendingVerification),
    stat("Open quotes", stats.quotes.open),
    stat("Awarded", stats.quotes.accepted),
    stat("Awarded value", usd(stats.awardedValueCents)),
  );

  const statusCounts = Object.entries(stats.shipments);
  const shipmentBreakdown =
    statusCounts.length === 0
      ? empty("No shipments yet.")
      : el(
          "div",
          { class: "row-card__meta" },
          statusCounts.map(([status, count]) => el("span", {}, badge(status), ` ${count}`)),
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
        el("h1", {}, "Platform"),
        el("p", {}, "Verification is a human decision, recorded with a note the company can read."),
      ),
    ),
    statCards,
    el("div", { class: "card" }, el("h2", {}, "Shipments by status"), shipmentBreakdown),
    commissionCard(ledger, refresh),
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
            el("th", {}, "Company"),
            el("th", {}, "Type"),
            el("th", {}, "Authority"),
            el("th", {}, "Status"),
            el("th", {}, "Decision"),
          ),
        ),
        el(
          "tbody",
          {},
          companies.map((company) =>
            el(
              "tr",
              {},
              el(
                "td",
                {},
                el("div", {}, company.name),
                el(
                  "div",
                  { class: "tiny muted" },
                  `${company.place.city}, ${company.place.region} · joined ${dateTime(company.createdAt)}`,
                ),
                company.verificationNotes
                  ? el("div", { class: "tiny muted" }, `Note: ${company.verificationNotes}`)
                  : null,
              ),
              el("td", {}, titleCase(company.kind)),
              el(
                "td",
                { class: "tiny" },
                company.mcNumber ? el("div", {}, `MC ${company.mcNumber}`) : null,
                company.dotNumber ? el("div", {}, `DOT ${company.dotNumber}`) : null,
                !company.mcNumber && !company.dotNumber
                  ? el("span", { class: "muted" }, "None provided")
                  : null,
              ),
              el("td", {}, badge(company.verificationStatus)),
              el("td", {}, decisionForm(company, refresh)),
            ),
          ),
        ),
      ),
    ),
    el(
      "p",
      { class: "small muted" },
      "Authority numbers are recorded as entered. Checking them against FMCSA, and verifying insurance certificates, needs an external integration — see the README.",
    ),
  );
}

/** The note is part of the decision, so it is typed in the same place the decision is made. */
/**
 * The commission the platform records on booked capacity. Changing the rate
 * only affects future bookings — each stored the rate it was made under.
 */
function commissionCard(ledger, refresh) {
  const form = el(
    "form",
    {
      class: "form-actions",
      onSubmit: async (event) => {
        event.preventDefault();
        const percent = Number(formValues(form).percent);
        try {
          await api.put("/api/admin/commission", { rateBps: Math.round(percent * 100) });
          toast(`Commission set to ${percent}% for new bookings`);
          refresh();
        } catch (error) {
          toast(error instanceof ApiError ? error.message : "Could not set the rate", "error");
        }
      },
    },
    el("label", { for: "commission-rate" }, "Rate %"),
    el("input", {
      id: "commission-rate",
      name: "percent",
      type: "number",
      min: "0",
      max: "30",
      step: "0.25",
      value: (ledger.currentRateBps / 100).toFixed(2),
    }),
    el("button", { class: "btn--primary btn--small", type: "submit" }, "Set rate"),
  );

  const rows = ledger.bySupplier.map((entry) =>
    el(
      "tr",
      {},
      el("td", {}, entry.name),
      el("td", { class: "numeric" }, usd(entry.grossCents)),
      el("td", { class: "numeric" }, usd(entry.commissionCents)),
    ),
  );

  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "card__head" },
      el("h2", {}, "Commission"),
      el("span", { class: "small muted" }, `${ledger.totals.bookings} live booking(s)`),
    ),
    el(
      "div",
      { class: "grid grid--stats" },
      stat("Booked value", usd(ledger.totals.grossCents)),
      stat("Commission recorded", usd(ledger.totals.commissionCents)),
      stat("Current rate", `${(ledger.currentRateBps / 100).toFixed(2)}%`),
      stat("Cancelled value", usd(ledger.totals.cancelledCents)),
    ),
    form,
    rows.length > 0
      ? el(
          "table",
          {},
          el(
            "thead",
            {},
            el(
              "tr",
              {},
              el("th", {}, "Carrier"),
              el("th", { class: "numeric" }, "Booked"),
              el("th", { class: "numeric" }, "Commission"),
            ),
          ),
          el("tbody", {}, rows),
        )
      : empty("No capacity booked yet."),
    el(
      "p",
      { class: "small muted" },
      "Commission is recorded against each booking at the rate in force when it was made. No money moves through this platform: settling these amounts needs a payment processor, and taking a cut of freight moves is what makes a platform a broker in most jurisdictions — see the README.",
    ),
  );
}

function decisionForm(company, refresh) {
  const record = async (status) => {
    try {
      await api.setVerification(company.id, { status, notes: formValues(form).notes ?? "" });
      toast(`${company.name} ${status}`);
      refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Could not record the decision", "error");
    }
  };

  const form = el(
    "form",
    { onSubmit: (event) => event.preventDefault() },
    el("input", {
      name: "notes",
      placeholder: "Note for this decision",
      value: company.verificationNotes,
      "aria-label": `Verification note for ${company.name}`,
    }),
    el(
      "div",
      { class: "row-card__actions" },
      el(
        "button",
        {
          type: "button",
          class: "btn--small btn--primary",
          disabled: company.verificationStatus === "verified",
          onClick: () => record("verified"),
        },
        "Verify",
      ),
      el(
        "button",
        {
          type: "button",
          class: "btn--small btn--danger",
          disabled: company.verificationStatus === "rejected",
          onClick: () => record("rejected"),
        },
        "Reject",
      ),
    ),
  );
  return form;
}

function stat(label, value) {
  return el(
    "div",
    { class: "stat" },
    el("div", { class: "stat__label" }, label),
    el("div", { class: "stat__value" }, value),
  );
}
