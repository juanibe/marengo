/**
 * Cache key derivation (RFC 9111 §4).
 *
 * A cache is a key/value store: the value is a stored response, and the key
 * answers "which request does this response satisfy?". This module builds keys.
 */

/**
 * The minimal request shape we need to derive a key. Keeping it tiny (rather
 * than passing a whole Node request object) keeps this module pure and trivial
 * to unit-test.
 */
export interface KeyableRequest {
  method: string;
  /** Absolute URL: scheme://host/path?query */
  url: string;
  headers: Headers;
}

/**
 * The primary key: `method + URL`, with the case-insensitive parts normalized.
 * Most requests are fully identified by this; `Vary` (added later) refines it.
 */
export function primaryKey(req: KeyableRequest): string {
  const method = req.method.toUpperCase();
  const url = new URL(req.url);
  // scheme + host are case-insensitive, and a default port (:80 / :443) is
  // equivalent to no port — `URL.origin` normalizes all of that for us.
  // The path and query are kept exactly as-is: their case and order can be
  // semantically meaningful to the origin, so we never reorder or fold them.
  return `${method} ${url.origin}${url.pathname}${url.search}`;
}

/**
 * Parse a response's `Vary` header into a normalized list of header names.
 *
 * - absent / empty -> `[]`                       (the response does not vary)
 * - "Accept-Encoding, Accept-Language" -> `["accept-encoding", "accept-language"]`
 * - "*" -> `["*"]`  (varies on unstated dimensions; the cacheability layer in
 *   #6 treats this as "do not store")
 */
export function parseVary(varyValue: string | null): string[] {
  if (!varyValue) return [];
  return varyValue
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * The secondary key: a canonical fingerprint of the request-header values that
 * a stored response said it varies on. Two requests sharing a primary key may
 * reuse the same stored response only if their secondary keys also match.
 */
export function secondaryKey(vary: string[], headers: Headers): string {
  return [...vary]
    .map((name) => name.toLowerCase())
    .sort() // canonical order, so the Vary list's own ordering doesn't matter
    .map((name) => `${name}: ${normalizeHeaderValue(headers.get(name))}`)
    .join("\n"); // a newline can't appear in a header value, so it can't collide
}

/** Absent header -> empty marker; otherwise strip surrounding optional whitespace (OWS). */
function normalizeHeaderValue(value: string | null): string {
  return value === null ? "" : value.trim();
}
