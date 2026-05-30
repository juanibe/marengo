import { beforeEach, describe, expect, it } from "vitest";
import type { KeyableRequest } from "../../src/cache/key.ts";
import type { ResponseTiming } from "../../src/cache/policy.ts";
import { MemoryStore, type StorableResponse } from "../../src/cache/store.ts";

const MB = 1024 * 1024;
const T = 1_700_000_000_000;

const req = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): KeyableRequest => ({ method, url, headers: new Headers(headers) });

const res = (status: number, headers: Record<string, string>, body: string): StorableResponse => ({
  status,
  headers: new Headers(headers),
  body: new TextEncoder().encode(body),
});

const timing = (): ResponseTiming => ({
  dateValue: T,
  ageValue: 0,
  requestTime: T,
  responseTime: T,
});

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore(10 * MB);
});

describe("MemoryStore — basic set/get", () => {
  it("returns null on a miss", () => {
    expect(store.get(req("GET", "http://blog.test/"))).toBeNull();
  });

  it("retrieves a stored response", () => {
    const r = req("GET", "http://blog.test/");
    store.set(r, res(200, {}, "hello"), timing());
    const hit = store.get(r);
    expect(hit?.status).toBe(200);
    expect(new TextDecoder().decode(hit?.body)).toBe("hello");
  });

  it("distinguishes different methods", () => {
    store.set(req("GET", "http://blog.test/"), res(200, {}, "g"), timing());
    expect(store.get(req("HEAD", "http://blog.test/"))).toBeNull();
  });

  it("distinguishes different URLs", () => {
    store.set(req("GET", "http://blog.test/a"), res(200, {}, "a"), timing());
    expect(store.get(req("GET", "http://blog.test/b"))).toBeNull();
  });

  it("replaces an entry for the same key (no duplicate)", () => {
    const r = req("GET", "http://blog.test/");
    store.set(r, res(200, {}, "first"), timing());
    store.set(r, res(200, {}, "second"), timing());
    expect(store.stats().entries).toBe(1);
    expect(new TextDecoder().decode(store.get(r)?.body)).toBe("second");
  });
});

describe("MemoryStore — Vary variant lookup", () => {
  it("stores gzip and brotli variants under one URL and matches each correctly", () => {
    const gzipReq = req("GET", "http://blog.test/page", { "accept-encoding": "gzip" });
    const brReq = req("GET", "http://blog.test/page", { "accept-encoding": "br" });
    const varied = (enc: string) => res(200, { vary: "Accept-Encoding" }, `body-${enc}`);

    store.set(gzipReq, varied("gzip"), timing());
    store.set(brReq, varied("br"), timing());

    expect(new TextDecoder().decode(store.get(gzipReq)?.body)).toBe("body-gzip");
    expect(new TextDecoder().decode(store.get(brReq)?.body)).toBe("body-br");
    expect(store.stats().primaryKeys).toBe(1);
    expect(store.stats().entries).toBe(2);
  });

  it("returns null when no stored variant matches the request's Vary headers", () => {
    const stored = req("GET", "http://blog.test/page", { "accept-encoding": "gzip" });
    store.set(stored, res(200, { vary: "Accept-Encoding" }, "g"), timing());
    const otherClient = req("GET", "http://blog.test/page", { "accept-encoding": "br" });
    expect(store.get(otherClient)).toBeNull();
  });
});

describe("MemoryStore — delete and purge", () => {
  it("delete(primaryKey) removes all variants for that URL and returns the count", () => {
    const a = req("GET", "http://blog.test/page", { "accept-encoding": "gzip" });
    const b = req("GET", "http://blog.test/page", { "accept-encoding": "br" });
    store.set(a, res(200, { vary: "Accept-Encoding" }, "a"), timing());
    store.set(b, res(200, { vary: "Accept-Encoding" }, "b"), timing());

    const removed = store.delete("GET http://blog.test/page");
    expect(removed).toBe(2);
    expect(store.get(a)).toBeNull();
    expect(store.get(b)).toBeNull();
  });

  it("delete returns 0 for an unknown primary key", () => {
    expect(store.delete("GET http://nope/")).toBe(0);
  });

  it("purge by exact primary key matches delete", () => {
    store.set(req("GET", "http://blog.test/a"), res(200, {}, "a"), timing());
    expect(store.purge("GET http://blog.test/a")).toBe(1);
  });

  it("purge by prefix removes every matching primary key", () => {
    store.set(req("GET", "http://blog.test/api/posts"), res(200, {}, "1"), timing());
    store.set(req("GET", "http://blog.test/api/users"), res(200, {}, "2"), timing());
    store.set(req("GET", "http://blog.test/assets/logo"), res(200, {}, "3"), timing());

    const removed = store.purge("GET http://blog.test/api/*");
    expect(removed).toBe(2);
    expect(store.stats().primaryKeys).toBe(1);
  });
});

describe("MemoryStore — stats", () => {
  it("starts empty", () => {
    expect(store.stats()).toMatchObject({
      entries: 0,
      primaryKeys: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      hitRatio: 0,
    });
  });

  it("counts hits, misses, and computes hitRatio", () => {
    const r = req("GET", "http://blog.test/");
    store.set(r, res(200, {}, "x"), timing());
    store.get(r); // hit
    store.get(r); // hit
    store.get(req("GET", "http://nope/")); // miss

    const s = store.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.hitRatio).toBeCloseTo(2 / 3);
  });

  it("tracks byte usage as entries come and go", () => {
    const r = req("GET", "http://blog.test/");
    store.set(r, res(200, { "content-type": "text/plain" }, "hello"), timing());
    expect(store.stats().bytes).toBeGreaterThan(0);
    store.delete("GET http://blog.test/");
    expect(store.stats().bytes).toBe(0);
  });
});

describe("MemoryStore — LRU eviction by bytes", () => {
  // With empty headers, an entry's size == body byte length, so we can budget
  // by hand: each entryOf(n) costs exactly n bytes.
  const entryOf = (n: number): StorableResponse => res(200, {}, "x".repeat(n));

  it("evicts the oldest entry once the budget is exceeded", () => {
    const small = new MemoryStore(100);
    const a = req("GET", "http://t/a");
    const b = req("GET", "http://t/b");
    const c = req("GET", "http://t/c");

    small.set(a, entryOf(40), timing()); // 40 bytes
    small.set(b, entryOf(40), timing()); // 80 bytes  (no eviction)
    small.set(c, entryOf(40), timing()); // 120 -> evict oldest (a)

    expect(small.get(a)).toBeNull();
    expect(small.get(b)).not.toBeNull();
    expect(small.get(c)).not.toBeNull();
    expect(small.stats().evictions).toBe(1);
    expect(small.stats().bytes).toBeLessThanOrEqual(100);
  });

  it("`touch` in get() moves an entry to most-recent (LRU, not FIFO)", () => {
    const small = new MemoryStore(100);
    const a = req("GET", "http://t/a");
    const b = req("GET", "http://t/b");
    const c = req("GET", "http://t/c");

    small.set(a, entryOf(40), timing()); // order: a
    small.set(b, entryOf(40), timing()); // order: a, b
    small.get(a); // touch -> order: b, a   (a is now most-recent)
    small.set(c, entryOf(40), timing()); // 120 -> evict oldest, which is now b

    expect(small.get(a)).not.toBeNull(); // touched, kept
    expect(small.get(b)).toBeNull(); // the actual victim
    expect(small.get(c)).not.toBeNull();
  });

  it("refuses an entry larger than the whole budget (no churn)", () => {
    const tiny = new MemoryStore(50);
    const r = req("GET", "http://t/big");
    tiny.set(r, entryOf(100), timing());

    expect(tiny.get(r)).toBeNull();
    expect(tiny.stats().entries).toBe(0);
    expect(tiny.stats().bytes).toBe(0);
    expect(tiny.stats().evictions).toBe(0);
  });

  it("evicts as many entries as needed to fit a new one", () => {
    const small = new MemoryStore(100);
    small.set(req("GET", "http://t/a"), entryOf(40), timing());
    small.set(req("GET", "http://t/b"), entryOf(40), timing());
    small.set(req("GET", "http://t/c"), entryOf(90), timing()); // 80+90=170 -> evict a, b -> 90 <= 100

    const s = small.stats();
    expect(s.entries).toBe(1);
    expect(s.evictions).toBe(2);
    expect(s.bytes).toBeLessThanOrEqual(100);
  });
});
