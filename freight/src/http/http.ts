/** Request/response plumbing: bodies, cookies, JSON, headers. No business rules. */

import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 256 * 1024;

export const SESSION_COOKIE = "fm_session";
export const CSRF_COOKIE = "fm_csrf";
export const CSRF_HEADER = "x-fm-csrf";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function cookieHeader(
  name: string,
  value: string,
  options: { maxAgeSeconds: number; httpOnly: boolean; secure: boolean },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Strict",
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
  cookies: string[] = [],
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(cookies.length > 0 ? { "set-cookie": cookies } : {}),
  });
  response.end(body);
}

/** Same-origin-only policy: this app loads nothing from a CDN, so nothing needs to be allowed. */
export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy":
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  };
}
