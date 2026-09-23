// Elements are built as nodes, never as HTML strings, so a company name or a
// message body can never become markup.

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** Replaces a node's children, flattening arrays — `Node.append` stringifies them. */
export function replace(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

export function field(label, control, error) {
  return el(
    "div",
    { class: error ? "field field--error" : "field" },
    el("label", { for: control.id || undefined }, label),
    control,
    error ? el("div", { class: "field__error" }, error) : null,
  );
}

export function checkGroup(name, options, selected = []) {
  return el(
    "div",
    { class: "check-grid" },
    options.map((option) =>
      el(
        "label",
        {},
        el("input", {
          type: "checkbox",
          name,
          value: option.value,
          checked: selected.includes(option.value),
        }),
        option.label,
      ),
    ),
  );
}

export function checkedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

export function select(name, options, value, extra = {}) {
  return el(
    "select",
    { name, ...extra },
    options.map((option) =>
      el("option", { value: option.value, selected: option.value === value }, option.label),
    ),
  );
}

let toastTimer = null;
export function toast(message, kind = "info") {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.className = kind === "error" ? "toast toast--error" : "toast";
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 4200);
}

/** Paints server-side field errors back onto the form that produced them. */
export function showFieldErrors(form, fields = {}) {
  for (const node of form.querySelectorAll(".field__error")) node.remove();
  for (const node of form.querySelectorAll(".field--error")) node.classList.remove("field--error");
  for (const [name, message] of Object.entries(fields)) {
    const input = form.querySelector(`[name="${name}"]`);
    const wrapper = input?.closest(".field");
    if (!wrapper) continue;
    wrapper.classList.add("field--error");
    wrapper.append(el("div", { class: "field__error" }, message));
  }
}

export function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value !== "string") continue;
    if (key in values) continue; // checkbox groups are read with checkedValues
    values[key] = value;
  }
  return values;
}
