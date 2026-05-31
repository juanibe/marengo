/**
 * Cache pipeline (#12).
 *
 * The cache-aware HTTP request handler — composes #5 (key), #6 (policy),
 * #7 (store), #8 (per-path TTL), and the proxy (#3/#4) into one decision tree:
 *
 *   GET / HEAD
 *     -> cache lookup
 *        HIT + fresh     => serve from store        (X-Cache: HIT)
 *        HIT + stale     => refetch, replace, serve (X-Cache: STALE)
 *        MISS            => fetch; maybe store      (X-Cache: MISS or PASS)
 *   other method
 *     => pass straight through to origin            (X-Cache: PASS)
 *
 * Two implementation choices worth noticing:
 *
 * 1. Storable responses are BUFFERED into memory before being served, so we
 *    can both write to the client and `store.set()` from the same bytes.
 *    Non-storable responses keep the streaming behaviour from the bare proxy.
 *
 * 2. The store remembers a `ResponseTiming` captured here — Date / Age header
 *    values plus our request/response timestamps — so #6's `currentAge` math
 *    works correctly for entries that aged in upstream caches before us.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Readable } from "node:stream";
import type { KeyableRequest } from "./cache/key.ts";
import {
  type CacheableResponse,
  evaluateFreshness,
  type FreshnessResult,
  isStorable,
  type ResponseTiming,
} from "./cache/policy.ts";
import { type CompiledRule, matchRule } from "./cache/rules.ts";
import type { Store, StoredEntry } from "./cache/store.ts";
import type { Config } from "./config/schema.ts";
import { fetchFromOrigin } from "./proxy.ts";

export interface PipelineDeps {
  config: Config;
  store: Store;
  /** Pre-compiled per-host rule matchers, keyed by lowercased Host header. */
  compiledOrigins: Map<string, CompiledRule[]>;
}

// ---------------------------------------------------------------------------
// The handler + the server factory
// ---------------------------------------------------------------------------

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PipelineDeps,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();

  // Non-cacheable methods stream straight through.
  if (method !== "GET" && method !== "HEAD") {
    setCacheStatus(res, "PASS");
    await passThroughToOrigin(req, res, deps);
    return;
  }

  const keyable = toKeyableRequest(req);
  const ttlFromRules = lookupTtl(deps.compiledOrigins, keyable);

  const hit = deps.store.get(keyable);
  if (hit) {
    const freshness = evaluateFreshness(
      asCacheableResponse(hit),
      hit.timing,
      Date.now(),
      ttlFromRules ?? 0,
    );
    if (freshness.fresh) {
      serveFromCache(res, hit, freshness);
      return;
    }
    // STALE — fall through to refetch (will replace the stale entry on store).
  }

  await fetchAndMaybeStore(req, res, deps, keyable, hit !== null);
}

/** Build an HTTP server whose request handler is the cache pipeline. */
export function createCacheServer(deps: PipelineDeps): Server {
  return createHttpServer((req, res) => {
    void handleRequest(req, res, deps).catch((err) => {
      // Structured logging lands in #11; for now stderr is fine.
      console.error("[marengo] request failed:", err);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("Bad Gateway\n");
    });
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function passThroughToOrigin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PipelineDeps,
): Promise<void> {
  const result = await fetchFromOrigin(req, deps.config);
  if (result.kind === "no-origin") {
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request\n");
    return;
  }
  res.writeHead(result.statusCode, result.headers);
  result.body.pipe(res);
}

async function fetchAndMaybeStore(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PipelineDeps,
  keyable: KeyableRequest,
  wasStale: boolean,
): Promise<void> {
  const requestTime = Date.now();
  const result = await fetchFromOrigin(req, deps.config);
  const responseTime = Date.now();

  if (result.kind === "no-origin") {
    setCacheStatus(res, "PASS");
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request\n");
    return;
  }

  const cacheableHeaders = recordToWhatwg(result.headers);
  const decision = isStorable(keyable, {
    status: result.statusCode,
    headers: cacheableHeaders,
  });

  if (!decision.storable) {
    // Origin said no — stream through without buffering.
    setCacheStatus(res, wasStale ? "STALE" : "PASS");
    res.writeHead(result.statusCode, result.headers);
    result.body.pipe(res);
    return;
  }

  // Storable: buffer the body so we can both store and serve.
  const body = await readAll(result.body);
  const timing: ResponseTiming = {
    dateValue: parseHttpDate(result.headers["date"]),
    ageValue: parseAgeHeader(result.headers["age"]),
    requestTime,
    responseTime,
  };

  deps.store.set(keyable, { status: result.statusCode, headers: cacheableHeaders, body }, timing);

  setCacheStatus(res, wasStale ? "STALE" : "MISS");
  res.writeHead(result.statusCode, result.headers);
  res.end(body);
}

function serveFromCache(res: ServerResponse, entry: StoredEntry, freshness: FreshnessResult): void {
  setCacheStatus(res, "HIT");
  res.setHeader("age", Math.floor(freshness.ageSeconds).toString());
  res.writeHead(entry.status, headersToObject(entry.headers));
  res.end(entry.body);
}

// ---- adapters between node:http and WHATWG types --------------------------

function toKeyableRequest(req: IncomingMessage): KeyableRequest {
  // We terminate plain HTTP in v0.1, so scheme is `http`. When fronted by a
  // TLS terminator, the original scheme arrives in X-Forwarded-Proto and could
  // be used here — left for later.
  const host = req.headers.host ?? "unknown";
  return {
    method: (req.method ?? "GET").toUpperCase(),
    url: `http://${host}${req.url ?? "/"}`,
    headers: nodeHeadersToWhatwg(req.headers),
  };
}

function nodeHeadersToWhatwg(h: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(h)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.append(name, v);
    else out.set(name, value);
  }
  return out;
}

function recordToWhatwg(h: Record<string, string | string[]>): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(h)) {
    if (Array.isArray(value)) for (const v of value) out.append(name, v);
    else out.set(name, value);
  }
  return out;
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

function asCacheableResponse(entry: StoredEntry): CacheableResponse {
  return { status: entry.status, headers: entry.headers };
}

function lookupTtl(
  compiledOrigins: Map<string, CompiledRule[]>,
  keyable: KeyableRequest,
): number | undefined {
  const url = new URL(keyable.url);
  const rules = compiledOrigins.get(url.hostname.toLowerCase());
  if (!rules) return undefined;
  return matchRule(rules, url.pathname)?.ttl;
}

function setCacheStatus(res: ServerResponse, status: "HIT" | "MISS" | "STALE" | "PASS"): void {
  res.setHeader("x-cache", status);
}

async function readAll(stream: Readable): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function parseHttpDate(value: string | string[] | undefined): number | null {
  const s = Array.isArray(value) ? value[0] : value;
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

function parseAgeHeader(value: string | string[] | undefined): number {
  const s = Array.isArray(value) ? value[0] : value;
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
