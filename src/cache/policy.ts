/**
 * Cache policy (RFC 9111 §3): "may we store this response, and for how long?"
 *
 * Split into two questions:
 *   1. storability — isStorable()   (this file)
 *   2. freshness   — how long it may be reused without revalidating (added next)
 */

import { type KeyableRequest, parseVary } from "./key.ts";

export interface CacheableResponse {
  status: number;
  headers: Headers;
}

export interface StorabilityResult {
  storable: boolean;
  /** Human-readable reason — makes every cache decision explainable in logs. */
  reason: string;
}

/** We only cache safe read methods; everything else passes straight through. */
const CACHEABLE_METHODS = new Set(["GET", "HEAD"]);

/**
 * Status codes a shared cache may store by default (RFC 9111 §3 + the HTTP
 * status code registry). Note: 206 (Partial Content) is cacheable per spec but
 * requires range handling we don't support in v0.1, so it's left out on purpose.
 */
const CACHEABLE_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 451, 501]);

const not = (reason: string): StorabilityResult => ({ storable: false, reason });

/**
 * Parse a `Cache-Control` header into its directives. Flags (e.g. `no-store`)
 * map to `true`; valued directives (e.g. `max-age=60`) map to their string
 * value. Reused by both storability and (next) freshness.
 */
export function parseCacheControl(value: string | null): Map<string, string | true> {
  const directives = new Map<string, string | true>();
  if (!value) return directives;
  for (const part of value.split(",")) {
    const token = part.trim();
    if (token === "") continue;
    const eq = token.indexOf("=");
    if (eq === -1) {
      directives.set(token.toLowerCase(), true);
      continue;
    }
    const name = token.slice(0, eq).trim().toLowerCase();
    let val = token.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    directives.set(name, val);
  }
  return directives;
}

/**
 * Decide whether a *shared* cache may store this response. A gate of MUST-NOT
 * rules; if every check passes the response is storable (its lifetime is
 * decided separately by freshness + the configured per-path TTL).
 */
export function isStorable(req: KeyableRequest, res: CacheableResponse): StorabilityResult {
  const method = req.method.toUpperCase();
  if (!CACHEABLE_METHODS.has(method)) return not(`method ${method} is not cacheable`);

  if (!CACHEABLE_STATUS.has(res.status)) {
    return not(`status ${res.status} is not cacheable by default`);
  }

  const cc = parseCacheControl(res.headers.get("cache-control"));

  if (cc.has("no-store")) return not("response is no-store");
  if (cc.has("private")) return not("response is private; a shared cache must not store it");

  // A request carrying credentials must not be stored by a shared cache unless
  // the origin explicitly opts in (RFC 9111 §3.5).
  if (
    req.headers.has("authorization") &&
    !cc.has("public") &&
    !cc.has("s-maxage") &&
    !cc.has("must-revalidate")
  ) {
    return not("authorized request without public / s-maxage / must-revalidate");
  }

  if (parseVary(res.headers.get("vary")).includes("*")) {
    return not("Vary: * can never be matched");
  }

  return { storable: true, reason: "storable" };
}

// ---------------------------------------------------------------------------
// Freshness (RFC 9111 §4.2): "is a stored response still reusable right now?"
// ---------------------------------------------------------------------------

/** Timing metadata the store must capture at store time so age can be computed later. */
export interface ResponseTiming {
  /** Value of the response `Date` header, ms since epoch, or null if absent. */
  dateValue: number | null;
  /** Value of the response `Age` header in seconds (0 if absent). */
  ageValue: number;
  /** When we sent the request to the origin, ms since epoch. */
  requestTime: number;
  /** When we received the response from the origin, ms since epoch. */
  responseTime: number;
}

export interface FreshnessResult {
  fresh: boolean;
  ageSeconds: number;
  lifetimeSeconds: number;
}

/** A `max-age` / `s-maxage` / `Age` value: a non-negative integer count of seconds. */
function parseDeltaSeconds(value: string | true | undefined): number | null {
  if (typeof value !== "string") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parse an HTTP date header into ms since epoch, or null if absent/invalid. */
function parseHttpDate(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * How long the response is allowed to be fresh, in seconds. Priority for a
 * shared cache: s-maxage > max-age > (Expires - Date) > the configured TTL.
 * (A spec-pure cache with no config would apply a heuristic for the last case.)
 */
export function freshnessLifetime(res: CacheableResponse, defaultTtlSeconds: number): number {
  const cc = parseCacheControl(res.headers.get("cache-control"));

  const sMaxAge = parseDeltaSeconds(cc.get("s-maxage"));
  if (sMaxAge !== null) return sMaxAge;

  const maxAge = parseDeltaSeconds(cc.get("max-age"));
  if (maxAge !== null) return maxAge;

  const expires = parseHttpDate(res.headers.get("expires"));
  const date = parseHttpDate(res.headers.get("date"));
  if (expires !== null && date !== null) return Math.max(0, (expires - date) / 1000);

  return defaultTtlSeconds;
}

/**
 * Current age of the response in seconds (RFC 9111 §4.2.3). Crucially this is
 * NOT just `now - Date`: a response also ages while sitting in upstream caches
 * (the `Age` header) and in transit, so we take the most conservative estimate.
 */
export function currentAge(timing: ResponseTiming, now: number): number {
  const { dateValue, ageValue, requestTime, responseTime } = timing;

  // How old it looks from the origin's Date stamp (guard clock skew with max 0).
  const apparentAge = dateValue === null ? 0 : Math.max(0, (responseTime - dateValue) / 1000);
  // Trust the upstream Age header, plus the time the response spent in flight.
  const responseDelay = (responseTime - requestTime) / 1000;
  const correctedAgeValue = ageValue + responseDelay;
  // Be conservative: assume it's as old as the larger estimate.
  const correctedInitialAge = Math.max(apparentAge, correctedAgeValue);
  // Plus however long it has since been resident in our cache.
  const residentTime = (now - responseTime) / 1000;

  return correctedInitialAge + residentTime;
}

/** Fresh when the current age is below the freshness lifetime. */
export function evaluateFreshness(
  res: CacheableResponse,
  timing: ResponseTiming,
  now: number,
  defaultTtlSeconds: number,
): FreshnessResult {
  const lifetimeSeconds = freshnessLifetime(res, defaultTtlSeconds);
  const ageSeconds = currentAge(timing, now);
  return { fresh: ageSeconds < lifetimeSeconds, ageSeconds, lifetimeSeconds };
}
