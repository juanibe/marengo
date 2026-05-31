/**
 * Admin endpoint handlers (#9).
 *
 * Three small endpoints, kept as standalone functions so they can be unit-
 * tested by passing a fake `Store`. The routing layer in `./server.ts` glues
 * them onto an HTTP server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "../cache/store.ts";

export interface AdminRoutesDeps {
  store: Store;
}

export type AdminHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminRoutesDeps,
) => void | Promise<void>;

export const health: AdminHandler = (_req, res, _deps) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok\n");
};

export const stats: AdminHandler = (_req, res, deps) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(deps.store.stats()));
};

export const purge: AdminHandler = async (req, res, deps) => {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    return badRequest(res, "could not read request body");
  }

  let parsed: unknown;
  try {
    parsed = body.length === 0 ? null : JSON.parse(body);
  } catch {
    return badRequest(res, "body is not valid JSON");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("pattern" in parsed) ||
    typeof (parsed as { pattern: unknown }).pattern !== "string"
  ) {
    return badRequest(res, "body must be JSON with a string `pattern` field");
  }

  const pattern = (parsed as { pattern: string }).pattern;
  if (pattern.length === 0) {
    return badRequest(res, "`pattern` must not be empty");
  }

  const removed = deps.store.purge(pattern);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ removed }));
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function badRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
