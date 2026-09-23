import { ApiError, api } from "../api.js";
import { checkedValues, el, field, formValues, select, showFieldErrors, toast } from "../dom.js";

export function renderAuth({ reference, onSignedIn }) {
  let mode = "signin";
  const container = el("section", { class: "auth" });

  const draw = () => {
    container.replaceChildren(
      el(
        "div",
        { class: "card" },
        el("h1", {}, "Freight Marketplace"),
        el(
          "p",
          { class: "muted" },
          "Post a shipment, compare verified transportation suppliers, negotiate, and award — in one place.",
        ),
        el(
          "div",
          { class: "auth__tabs" },
          el(
            "button",
            {
              type: "button",
              "aria-pressed": String(mode === "signin"),
              onClick: () => {
                mode = "signin";
                draw();
              },
            },
            "Sign in",
          ),
          el(
            "button",
            {
              type: "button",
              "aria-pressed": String(mode === "register"),
              onClick: () => {
                mode = "register";
                draw();
              },
            },
            "Create an account",
          ),
        ),
        mode === "signin" ? signInForm(onSignedIn) : registerForm(reference, onSignedIn),
      ),
    );
  };

  draw();
  return container;
}

function signInForm(onSignedIn) {
  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        try {
          const result = await api.login(values);
          onSignedIn(result.user);
        } catch (error) {
          handle(error, form);
        }
      },
    },
    field(
      "Work email",
      el("input", { name: "email", type: "email", autocomplete: "username", required: true }),
    ),
    field(
      "Password",
      el("input", {
        name: "password",
        type: "password",
        autocomplete: "current-password",
        required: true,
      }),
    ),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Sign in"),
    ),
  );
  return form;
}

function registerForm(reference, onSignedIn) {
  const form = el(
    "form",
    {
      onSubmit: async (event) => {
        event.preventDefault();
        const values = formValues(form);
        try {
          const result = await api.register(values);
          onSignedIn(result.user);
        } catch (error) {
          handle(error, form);
        }
      },
    },
    field(
      "Account type",
      select(
        "companyKind",
        [
          { value: "shipper", label: "Shipper — I have freight to move" },
          { value: "supplier", label: "Supplier — I move freight" },
        ],
        "shipper",
        { required: true },
      ),
    ),
    field("Company name", el("input", { name: "companyName", required: true })),
    el(
      "div",
      { class: "field-row" },
      field("Your name", el("input", { name: "name", required: true })),
      field("Phone", el("input", { name: "contactPhone", required: true })),
    ),
    el(
      "div",
      { class: "field-row" },
      field("City", el("input", { name: "companyCity", required: true })),
      field(
        "Region",
        select(
          "companyRegion",
          reference.regions.map((region) => ({
            value: region.key.split("-")[1],
            label: region.name,
          })),
          "FL",
          { required: true },
        ),
      ),
      field(
        "Country",
        select(
          "companyCountry",
          [
            { value: "US", label: "United States" },
            { value: "DO", label: "Dominican Republic" },
          ],
          "US",
        ),
      ),
    ),
    el(
      "div",
      { class: "field-row" },
      field("MC number (optional)", el("input", { name: "mcNumber" })),
      field("DOT number (optional)", el("input", { name: "dotNumber" })),
    ),
    field(
      "Work email",
      el("input", { name: "email", type: "email", autocomplete: "username", required: true }),
    ),
    field(
      "Password",
      el("input", {
        name: "password",
        type: "password",
        autocomplete: "new-password",
        minlength: 12,
        required: true,
      }),
    ),
    el(
      "p",
      { class: "small muted" },
      "New accounts start as pending verification. An admin reviews authority and insurance before the company is marked verified.",
    ),
    el(
      "div",
      { class: "form-actions" },
      el("button", { class: "btn--primary", type: "submit" }, "Create account"),
    ),
  );
  return form;
}

function handle(error, form) {
  if (error instanceof ApiError) {
    showFieldErrors(form, error.fields);
    toast(error.message, "error");
    return;
  }
  toast("Something went wrong", "error");
}

export { checkedValues };
