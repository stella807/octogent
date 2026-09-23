/**
 * HTTP entry point: wires the store to the route table and translates domain
 * errors into status codes. Business rules do not live here.
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePrincipal, signOut } from "../app/accounts.ts";
import { AppError } from "../app/errors.ts";
import { ValidationError } from "../domain/validation.ts";
import type { Store } from "../ports/store.ts";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  HttpError,
  SESSION_COOKIE,
  cookieHeader,
  parseCookies,
  readJsonBody,
  securityHeaders,
  sendJson,
} from "./http.ts";
import { matchRoute } from "./router.ts";
import { routes } from "./routes.ts";
import type { Ctx } from "./routes.ts";
import { serveStatic } from "./static-files.ts";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const SESSION_SECONDS = 14 * 24 * 3600;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type ServerOptions = {
  store: Store;
  /** Set when the app is served over TLS so cookies carry the Secure flag. */
  secureCookies: boolean;
  webRoot?: string;
};

export function createServer(options: ServerOptions): Server {
  const webRoot = options.webRoot ?? WEB_ROOT;
  return createHttpServer((request, response) => {
    handle(request, response, options, webRoot).catch((error) => {
      // A failure this deep means the error mapper itself broke.
      console.error("unhandled request failure", error);
      if (!response.headersSent) sendJson(response, 500, { error: "Internal error" });
      else response.end();
    });
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  webRoot: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

  if (!url.pathname.startsWith("/api/")) {
    const served = await serveStatic(webRoot, url.pathname, response);
    if (served) return;
    // Unknown non-API path: the UI is a single page, so hand back the shell.
    const fallback = await serveStatic(webRoot, "/index.html", response);
    if (!fallback) sendJson(response, 404, { error: "Not found" });
    return;
  }

  const cookies = parseCookies(request.headers.cookie);
  const token = cookies[SESSION_COOKIE] ?? null;
  const resolved = resolvePrincipal(options.store, token);
  const setCookies: string[] = [];

  const match = matchRoute(routes, method, url.pathname);
  if (!match.route) {
    sendJson(response, match.pathExists ? 405 : 404, {
      error: match.pathExists ? `${method} not allowed here` : "Not found",
    });
    return;
  }

  if (match.route.auth && !resolved) {
    sendJson(response, 401, { error: "Sign in to continue" });
    return;
  }

  // Double-submit CSRF: SameSite=Strict keeps the cookie off cross-site
  // requests, and the header proves the caller could read it.
  if (!SAFE_METHODS.has(method) && resolved) {
    const header = request.headers[CSRF_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || provided !== resolved.session.csrfToken) {
      sendJson(response, 403, { error: "Missing or stale CSRF token — reload the page" });
      return;
    }
  }

  try {
    const body = SAFE_METHODS.has(method) ? {} : await readJsonBody(request);
    const context: Ctx & { params: Record<string, string> } = {
      store: options.store,
      principal: resolved?.principal ?? null,
      session: resolved?.session ?? null,
      params: match.params,
      query: url.searchParams,
      body,
      signIn: (result) => {
        setCookies.push(
          cookieHeader(SESSION_COOKIE, result.token, {
            maxAgeSeconds: SESSION_SECONDS,
            httpOnly: true,
            secure: options.secureCookies,
          }),
          // Readable by the page on purpose: the client echoes it back in a header.
          cookieHeader(CSRF_COOKIE, result.csrfToken, {
            maxAgeSeconds: SESSION_SECONDS,
            httpOnly: false,
            secure: options.secureCookies,
          }),
        );
      },
      signOut: () => {
        if (token) signOut(options.store, token);
        setCookies.push(
          cookieHeader(SESSION_COOKIE, "", {
            maxAgeSeconds: 0,
            httpOnly: true,
            secure: options.secureCookies,
          }),
          cookieHeader(CSRF_COOKIE, "", {
            maxAgeSeconds: 0,
            httpOnly: false,
            secure: options.secureCookies,
          }),
        );
      },
    };

    const payload = await match.route.handler(context);
    response.setHeaders(new Headers(securityHeaders()));
    sendJson(response, method === "POST" ? 201 : 200, payload ?? { ok: true }, setCookies);
  } catch (error) {
    sendError(response, error);
  }
}

function sendError(response: ServerResponse, error: unknown): void {
  if (error instanceof ValidationError) {
    sendJson(response, 422, { error: "Check the highlighted fields", fields: error.fields });
    return;
  }
  if (error instanceof AppError) {
    sendJson(response, error.status, {
      error: error.message,
      ...(error.fields ? { fields: error.fields } : {}),
    });
    return;
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.message });
    return;
  }
  console.error("request failed", error);
  sendJson(response, 500, { error: "Internal error" });
}
