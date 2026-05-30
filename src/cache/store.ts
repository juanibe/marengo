/**
 * Cache store (#7).
 *
 * Holds stored responses and runs the two-step variant lookup from #5:
 *   (a) primary key  -> the set of variants for this URL
 *   (b) for each variant, compare its stored secondary key against one
 *       recomputed from the incoming request's headers
 *
 * Storability (#6) and freshness (#6) are NOT decided here — the caller checks
 * `isStorable` before calling `set`, and `evaluateFreshness` after `get`.
 * The store just remembers what it was told to and finds matches.
 *
 * The `Store` interface is what later lets a disk tier (#21) drop in without
 * touching request handling: same shape, different backing.
 *
 * Eviction is LRU by bytes: a JS `Map` already iterates in insertion order, and
 * `delete + set` re-inserts at the most-recent end — so the touch in `get`
 * maintains LRU order, and eviction simply drops from the front until we're
 * back under `maxBytes`. Entries larger than the whole budget are refused
 * outright (they would just evict everything else and then themselves).
 */

import { type KeyableRequest, parseVary, primaryKey, secondaryKey } from "./key.ts";
import type { ResponseTiming } from "./policy.ts";

/** A response, in the minimal shape the cache needs. Body as bytes. */
export interface StorableResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** What `get` returns — the response plus the timing the caller needs for freshness. */
export interface StoredEntry {
  status: number;
  headers: Headers;
  body: Uint8Array;
  timing: ResponseTiming;
}

export interface StoreStats {
  /** Total stored variants. */
  entries: number;
  /** Distinct primary keys (one URL may hold many variants). */
  primaryKeys: number;
  /** Approximate bytes currently held (headers + body). */
  bytes: number;
  /** Configured byte budget. */
  maxBytes: number;
  hits: number;
  misses: number;
  /** Variants dropped by LRU eviction over the lifetime of the store. */
  evictions: number;
  /** 0..1 — `hits / (hits + misses)`, or 0 if no lookups yet. */
  hitRatio: number;
}

export interface Store {
  get(req: KeyableRequest): StoredEntry | null;
  set(req: KeyableRequest, res: StorableResponse, timing: ResponseTiming): void;
  /** Remove every variant for this primary key. Returns the count removed. */
  delete(primaryKey: string): number;
  /**
   * Remove every primary key matching the pattern. Pattern is either an
   * exact primary-key string, or a prefix ending in `*` (e.g. `"GET https://blog.test/*"`).
   * Returns the total variant count removed.
   */
  purge(pattern: string): number;
  stats(): StoreStats;
}

/** Internal full record; `get` returns a slimmer `StoredEntry` view of this. */
interface Variant {
  primary: string;
  vary: string[];
  secondary: string;
  status: number;
  headers: Headers;
  body: Uint8Array;
  timing: ResponseTiming;
  /** Approximate bytes (headers + body) — used for LRU eviction. */
  size: number;
}

// Primary keys never end with a space and secondary keys never start with one,
// so a single space between them is an unambiguous flat-key separator.
const FLAT_KEY_SEPARATOR = " ";

function flatKey(primary: string, secondary: string): string {
  return `${primary}${FLAT_KEY_SEPARATOR}${secondary}`;
}

/** Rough size of a Headers map (name + ": " + value, per field). */
function headersByteSize(headers: Headers): number {
  let bytes = 0;
  for (const [name, value] of headers) bytes += name.length + 2 + value.length;
  return bytes;
}

export class MemoryStore implements Store {
  readonly maxBytes: number;
  private readonly entries = new Map<string, Variant>();
  private readonly byPrimary = new Map<string, Set<string>>();
  private currentBytes = 0;
  private hitsCount = 0;
  private missesCount = 0;
  private evictionsCount = 0;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(req: KeyableRequest): StoredEntry | null {
    const primary = primaryKey(req);
    const candidates = this.byPrimary.get(primary);
    if (!candidates) {
      this.missesCount++;
      return null;
    }
    for (const fk of candidates) {
      const v = this.entries.get(fk);
      if (!v) continue;
      if (secondaryKey(v.vary, req.headers) === v.secondary) {
        this.hitsCount++;
        // Touch for LRU: re-insert at the most-recent end.
        this.entries.delete(fk);
        this.entries.set(fk, v);
        return v;
      }
    }
    this.missesCount++;
    return null;
  }

  set(req: KeyableRequest, res: StorableResponse, timing: ResponseTiming): void {
    const primary = primaryKey(req);
    const vary = parseVary(res.headers.get("vary"));
    const secondary = secondaryKey(vary, req.headers);
    const fk = flatKey(primary, secondary);
    const size = headersByteSize(res.headers) + res.body.byteLength;

    // A single entry larger than the whole budget would just evict everything
    // and then itself — pointless churn. Refuse it up front.
    if (size > this.maxBytes) return;

    // Replacing an existing same-variant: subtract the old bytes first.
    const existing = this.entries.get(fk);
    if (existing) {
      this.currentBytes -= existing.size;
      this.entries.delete(fk);
    }

    const variant: Variant = {
      primary,
      vary,
      secondary,
      status: res.status,
      headers: res.headers,
      body: res.body,
      timing,
      size,
    };
    this.entries.set(fk, variant);
    this.currentBytes += size;

    let bucket = this.byPrimary.get(primary);
    if (!bucket) {
      bucket = new Set<string>();
      this.byPrimary.set(primary, bucket);
    }
    bucket.add(fk);

    this.evict();
  }

  delete(primary: string): number {
    const bucket = this.byPrimary.get(primary);
    if (!bucket) return 0;
    const flatKeys = [...bucket];
    for (const fk of flatKeys) this.removeFlatKey(fk);
    return flatKeys.length;
  }

  purge(pattern: string): number {
    const isPrefix = pattern.endsWith("*");
    const prefix = isPrefix ? pattern.slice(0, -1) : pattern;
    const matches: string[] = [];
    for (const primary of this.byPrimary.keys()) {
      if (isPrefix ? primary.startsWith(prefix) : primary === pattern) {
        matches.push(primary);
      }
    }
    let count = 0;
    for (const primary of matches) count += this.delete(primary);
    return count;
  }

  stats(): StoreStats {
    const total = this.hitsCount + this.missesCount;
    return {
      entries: this.entries.size,
      primaryKeys: this.byPrimary.size,
      bytes: this.currentBytes,
      maxBytes: this.maxBytes,
      hits: this.hitsCount,
      misses: this.missesCount,
      evictions: this.evictionsCount,
      hitRatio: total === 0 ? 0 : this.hitsCount / total,
    };
  }

  /** Drop entries from the front (oldest) until under budget. */
  private evict(): void {
    while (this.currentBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break; // safety; shouldn't trigger if bytes > 0
      this.removeFlatKey(oldest);
      this.evictionsCount++;
    }
  }

  /** Remove a single variant by flat key, keeping byte and index bookkeeping in sync. */
  private removeFlatKey(fk: string): void {
    const v = this.entries.get(fk);
    if (!v) return;
    this.entries.delete(fk);
    this.currentBytes -= v.size;
    const bucket = this.byPrimary.get(v.primary);
    if (bucket) {
      bucket.delete(fk);
      if (bucket.size === 0) this.byPrimary.delete(v.primary);
    }
  }
}
