// Thin client over the JSON API. Every unsafe request echoes the CSRF cookie
// back in a header, which is the half of double-submit the browser cannot do
// on its own.

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.status = status;
    this.fields = fields ?? {};
  }
}

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)fm_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function request(method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-fm-csrf"] = csrfToken();

  const response = await fetch(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? `Request failed (${response.status})`,
      payload?.fields,
    );
  }
  return payload;
}

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, body),
  put: (path, body = {}) => request("PUT", path, body),

  reference: () => request("GET", "/api/reference"),
  me: () => request("GET", "/api/me"),
  register: (body) => request("POST", "/api/auth/register", body),
  login: (body) => request("POST", "/api/auth/login", body),
  logout: () => request("POST", "/api/auth/logout", {}),

  shipments: () => request("GET", "/api/shipments"),
  shipment: (id) => request("GET", `/api/shipments/${id}`),
  postShipment: (body) => request("POST", "/api/shipments", body),
  setShipmentStatus: (id, body) => request("POST", `/api/shipments/${id}/status`, body),
  suppliers: () => request("GET", "/api/suppliers"),

  supplierProfile: () => request("GET", "/api/supplier/profile"),
  saveSupplierProfile: (body) => request("PUT", "/api/supplier/profile", body),
  opportunities: (query) => request("GET", `/api/opportunities${query ? `?${query}` : ""}`),
  myQuotes: () => request("GET", "/api/quotes"),
  submitQuote: (shipmentId, body) => request("POST", `/api/shipments/${shipmentId}/quotes`, body),
  counterQuote: (quoteId, body) => request("POST", `/api/quotes/${quoteId}/counter`, body),
  acceptQuote: (quoteId) => request("POST", `/api/quotes/${quoteId}/accept`, {}),
  declineQuote: (quoteId, body) => request("POST", `/api/quotes/${quoteId}/decline`, body),

  thread: (shipmentId, supplierId) =>
    request("GET", `/api/shipments/${shipmentId}/threads/${supplierId}`),
  sendMessage: (shipmentId, supplierId, body) =>
    request("POST", `/api/shipments/${shipmentId}/threads/${supplierId}`, body),

  adminCompanies: () => request("GET", "/api/admin/companies"),
  adminStats: () => request("GET", "/api/admin/stats"),
  setVerification: (companyId, body) =>
    request("POST", `/api/admin/companies/${companyId}/verification`, body),
};
