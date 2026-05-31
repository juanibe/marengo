/**
 * Reverse proxy core (#3 + #4).
 *
 * - Forwards an incoming request to the matching origin (by Host header).
 * - Strips hop-by-hop headers per RFC 9110 §7.6.1 in both directions, and
 *   drops any extra header names listed in the request's Connection header.
 * - Adds Via and the X-Forwarded-* trio so the origin knows what's behind us.
 * - Streams the body end-to-end — nothing is buffered.
 * - One undici Pool per upstream is cached at module scope so sockets reuse.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { type Dispatcher, Pool } from "undici";
import type { Config } from "./config/schema.ts";

type MutableHeaders = Record<string, string | string[]>;

// ---------------------------------------------------------------------------
// Header surgery
// ---------------------------------------------------------------------------

/** Hop-by-hop headers (RFC 9110 §7.6.1 / RFC 7230 §6.1) — dropped at every hop. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Return a copy of `headers` with hop-by-hop headers removed, including any
 * extension hop-by-hop names listed in the request's `Connection` header.
 */
export function stripHopByHop<H extends Record<string, string | string[] | undefined>>(
  headers: H,
): MutableHeaders {
  const extra = new Set<string>();
  const connection = headers["connection"];
  const connectionValues =
    typeof connection === "string" ? [connection] : Array.isArray(connection) ? connection : [];
  for (const value of connectionValues) {
    for (const name of value.split(",")) extra.add(name.trim().toLowerCase());
  }

  const out: MutableHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || extra.has(lower)) continue;
    out[name] = value;
  }
  return out;
}

/** Append a `1.1 <name>` segment to the `Via` chain (mutates). */
export function addVia(headers: MutableHeaders, name = "marengo"): void {
  const existing = headers["via"] ?? headers["Via"];
  const ours = `1.1 ${name}`;
  const combined = existing
    ? `${Array.isArray(existing) ? existing.join(", ") : existing}, ${ours}`
    : ours;
  delete headers["Via"];
  headers["via"] = combined;
}

/** Set X-Forwarded-For / X-Forwarded-Proto / X-Forwarded-Host from the incoming request (mutates). */
export function addForwarded(headers: MutableHeaders, req: IncomingMessage): void {
  const remote = req.socket.remoteAddress ?? "";
  const existing = headers["x-forwarded-for"];
  const xff = existing
    ? `${Array.isArray(existing) ? existing.join(", ") : existing}, ${remote}`
    : remote;
  headers["x-forwarded-for"] = xff;

  // Marengo terminates plain HTTP in v0.1; users in front of TLS terminators
  // typically already set X-Forwarded-Proto upstream of us.
  if (!headers["x-forwarded-proto"]) headers["x-forwarded-proto"] = "http";

  if (req.headers.host && !headers["x-forwarded-host"]) {
    headers["x-forwarded-host"] = req.headers.host;
  }
}

// ---------------------------------------------------------------------------
// Origin selection
// ---------------------------------------------------------------------------

export function findOrigin(config: Config, hostHeader: string | undefined) {
  if (!hostHeader) return undefined;
  const host = hostHeader.split(":")[0]?.toLowerCase();
  return config.origins.find((o) => o.host.toLowerCase() === host);
}

// ---------------------------------------------------------------------------
// Connection pools (one undici Pool per upstream)
// ---------------------------------------------------------------------------

const pools = new Map<string, Pool>();

function getPool(upstream: string): Pool {
  let p = pools.get(upstream);
  if (!p) {
    p = new Pool(upstream);
    pools.set(upstream, p);
  }
  return p;
}

/** Close every pool and forget them — call this at shutdown (and between tests). */
export async function closeAllPools(): Promise<void> {
  const toClose = [...pools.values()];
  pools.clear();
  await Promise.all(toClose.map((p) => p.close()));
}

// ---------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

/**
 * Result of asking the origin for a response, with all proxy-side header
 * surgery already applied. The caller decides what to do with the body —
 * the pipeline either buffers it (to store) or pipes it through.
 */
export type OriginFetchResult =
  | { kind: "no-origin" }
  | {
      kind: "response";
      statusCode: number;
      headers: MutableHeaders;
      body: Readable;
    };

/**
 * Forward the incoming request to the matching origin and return its response.
 *
 * Unlike `proxyToOrigin`, this does NOT write to the client — it just returns
 * the (already-cleaned) upstream response so the caller can decide whether to
 * buffer-and-store, pipe-through, or both. Used by the cache pipeline (#12).
 */
export async function fetchFromOrigin(
  req: IncomingMessage,
  config: Config,
): Promise<OriginFetchResult> {
  const origin = findOrigin(config, req.headers.host);
  if (!origin) return { kind: "no-origin" };

  const headers = stripHopByHop(req.headers as IncomingHttpHeaders);
  addVia(headers);
  addForwarded(headers, req);

  const method = (req.method ?? "GET").toUpperCase();
  const pool = getPool(origin.upstream);

  const upstream = await pool.request({
    method: method as Dispatcher.HttpMethod,
    path: req.url ?? "/",
    headers,
    body: METHODS_WITHOUT_BODY.has(method) ? undefined : req,
  });

  const responseHeaders = stripHopByHop(
    upstream.headers as Record<string, string | string[] | undefined>,
  );
  addVia(responseHeaders);

  return {
    kind: "response",
    statusCode: upstream.statusCode,
    headers: responseHeaders,
    body: upstream.body as unknown as Readable,
  };
}

/**
 * The cache-less pass-through path: fetch from the origin and pipe the
 * response straight back to the client. Used directly by `createProxyServer`
 * and indirectly by the pipeline for non-cacheable methods.
 */
export async function proxyToOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
): Promise<void> {
  const result = await fetchFromOrigin(req, config);
  if (result.kind === "no-origin") {
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request\n");
    return;
  }
  res.writeHead(result.statusCode, result.headers);
  result.body.pipe(res);
}
