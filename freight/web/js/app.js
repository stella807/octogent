// Shell and router. It wires views to state and does nothing else: every rule
// this UI appears to enforce is enforced again on the server.

import { ApiError, api } from "./api.js";
import { clear, el, replace, toast } from "./dom.js";
import { renderAdmin } from "./views/admin.js";
import { renderAuth } from "./views/auth.js";
import { renderFloor } from "./views/floor.js";
import { renderShipment } from "./views/shipment.js";
import { renderNewShipment, renderShipmentList } from "./views/shipper.js";
import { renderMyQuotes, renderOpportunities, renderSupplierProfile } from "./views/supplier.js";

const state = { user: null, company: null, reference: null };

const ROUTES = [
  { pattern: /^#\/floor$/, roles: ["shipper", "supplier", "admin"], view: renderFloor },
  { pattern: /^#\/shipments\/new$/, roles: ["shipper"], view: renderNewShipment },
  {
    pattern: /^#\/shipments\/([^/]+)$/,
    roles: ["shipper", "supplier", "admin"],
    view: renderShipment,
    params: ["id"],
  },
  { pattern: /^#\/shipments$/, roles: ["shipper", "supplier", "admin"], view: renderShipmentList },
  { pattern: /^#\/opportunities$/, roles: ["supplier"], view: renderOpportunities },
  { pattern: /^#\/quotes$/, roles: ["supplier"], view: renderMyQuotes },
  { pattern: /^#\/profile$/, roles: ["supplier"], view: renderSupplierProfile },
  { pattern: /^#\/admin$/, roles: ["admin"], view: renderAdmin },
];

const NAV = {
  shipper: [
    { href: "#/floor", label: "Command floor" },
    { href: "#/shipments", label: "Shipments" },
    { href: "#/shipments/new", label: "Post a shipment" },
  ],
  supplier: [
    { href: "#/floor", label: "Command floor" },
    { href: "#/opportunities", label: "Opportunities" },
    { href: "#/quotes", label: "My quotes" },
    { href: "#/shipments", label: "My shipments" },
    { href: "#/profile", label: "Capabilities" },
  ],
  admin: [
    { href: "#/floor", label: "Command floor" },
    { href: "#/admin", label: "Platform" },
    { href: "#/shipments", label: "All shipments" },
  ],
};

const HOME = { shipper: "#/floor", supplier: "#/floor", admin: "#/floor" };

const root = document.getElementById("root");
const bar = document.getElementById("app-bar");

// A view that starts a timer (the floor polls) hangs a teardown on its node;
// the router stops the old one before the new view replaces it.
let activeTeardown = null;

function swap(node) {
  activeTeardown?.();
  activeTeardown = typeof node?.teardown === "function" ? node.teardown : null;
  clear(root).append(node);
}

function navigate(hash) {
  if (window.location.hash === hash) render();
  else window.location.hash = hash;
}

function refresh() {
  render();
}

async function boot() {
  state.reference = await api.reference();
  // The CSRF cookie is set beside the session cookie, so its absence means
  // signed out — worth checking to keep a 401 out of the console on first load.
  if (document.cookie.includes("fm_csrf=")) {
    try {
      const session = await api.me();
      state.user = session.user;
      state.company = session.company;
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
    }
  }
  window.addEventListener("hashchange", render);
  render();
}

function signedIn(user) {
  state.user = user;
  api
    .me()
    .then((session) => {
      state.company = session.company;
      window.location.hash = HOME[user.role] ?? "#/shipments";
      render();
    })
    .catch(() => render());
}

async function render() {
  if (!state.user) {
    bar.hidden = true;
    swap(renderAuth({ reference: state.reference, onSignedIn: signedIn }));
    return;
  }

  bar.hidden = false;
  drawNav();

  const hash = window.location.hash || HOME[state.user.role] || "#/shipments";
  const match = ROUTES.map((route) => ({ route, result: route.pattern.exec(hash) })).find(
    (candidate) => candidate.result,
  );

  if (!match || !match.route.roles.includes(state.user.role)) {
    window.location.hash = HOME[state.user.role] ?? "#/shipments";
    return;
  }

  const params = {};
  (match.route.params ?? []).forEach((name, index) => {
    params[name] = decodeURIComponent(match.result[index + 1]);
  });

  swap(el("p", { class: "muted" }, "Loading…"));
  try {
    swap(await match.route.view({ state, params, navigate, refresh }));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      state.user = null;
      state.company = null;
      render();
      return;
    }
    swap(
      el(
        "div",
        { class: "card" },
        el("h2", {}, "Could not load this page"),
        el("p", { class: "muted" }, error instanceof ApiError ? error.message : String(error)),
        el("button", { onClick: refresh }, "Try again"),
      ),
    );
  }
}

function drawNav() {
  const nav = document.getElementById("nav");
  const hash = window.location.hash;
  replace(
    nav,
    (NAV[state.user.role] ?? []).map((item) =>
      el(
        "button",
        {
          type: "button",
          "aria-current": hash === item.href ? "page" : null,
          onClick: () => navigate(item.href),
        },
        item.label,
      ),
    ),
  );

  const account = document.getElementById("account");
  replace(
    account,
    el("span", {}, state.company ? `${state.company.name} · ${state.user.name}` : state.user.name),
    el(
      "button",
      {
        type: "button",
        class: "btn--small",
        onClick: async () => {
          await api.logout();
          state.user = null;
          state.company = null;
          window.location.hash = "";
          render();
        },
      },
      "Sign out",
    ),
  );
}

boot().catch((error) => {
  toast("The app failed to start", "error");
  console.error(error);
});
