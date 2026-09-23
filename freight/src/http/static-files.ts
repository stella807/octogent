/** Serves the operator UI from `web/`. Path traversal is rejected, not normalised away. */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { securityHeaders } from "./http.ts";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

export async function serveStatic(
  root: string,
  urlPath: string,
  response: ServerResponse,
): Promise<boolean> {
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  if (relative.split(sep).includes("..")) {
    response.writeHead(400).end();
    return true;
  }
  const candidate = join(root, relative === "" ? "index.html" : relative);
  if (!candidate.startsWith(root)) {
    response.writeHead(400).end();
    return true;
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    response.writeHead(200, {
      ...securityHeaders(),
      "content-type": CONTENT_TYPES[extname(candidate)] ?? "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-cache",
    });
    createReadStream(candidate).pipe(response);
    return true;
  } catch {
    return false;
  }
}
