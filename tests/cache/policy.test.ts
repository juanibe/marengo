import { describe, expect, it } from "vitest";
import type { KeyableRequest } from "../../src/cache/key.ts";
import {
  type CacheableResponse,
  currentAge,
  evaluateFreshness,
  freshnessLifetime,
  isStorable,
  parseCacheControl,
  type ResponseTiming,
} from "../../src/cache/policy.ts";

const request = (method: string, headers: Record<string, string> = {}): KeyableRequest => ({
  method,
  url: "http://blog.test/",
  headers: new Headers(headers),
});

const response = (status: number, headers: Record<string, string> = {}): CacheableResponse => ({
  status,
  headers: new Headers(headers),
});

describe("parseCacheControl", () => {
  it("returns an empty map when absent", () => {
    expect(parseCacheControl(null).size).toBe(0);
  });

  it("parses flags and valued directives, lowercasing names", () => {
    const cc = parseCacheControl("Public, max-age=60, s-maxage=30");
    expect(cc.get("public")).toBe(true);
    expect(cc.get("max-age")).toBe("60");
    expect(cc.get("s-maxage")).toBe("30");
  });

  it("strips quotes around values", () => {
    expect(parseCacheControl('max-age="3600"').get("max-age")).toBe("3600");
  });
});

describe("isStorable", () => {
  it("stores a plain GET 200", () => {
    expect(isStorable(request("GET"), response(200)).storable).toBe(true);
  });

  it("stores a HEAD 200", () => {
    expect(isStorable(request("HEAD"), response(200)).storable).toBe(true);
  });

  it("stores a 404 — caching 'not found' is legitimate", () => {
    expect(isStorable(request("GET"), response(404)).storable).toBe(true);
  });

  it("refuses non-cacheable methods", () => {
    expect(isStorable(request("POST"), response(200)).storable).toBe(false);
  });

  it("refuses non-cacheable status codes", () => {
    expect(isStorable(request("GET"), response(500)).storable).toBe(false);
  });

  it("refuses no-store", () => {
    const result = isStorable(request("GET"), response(200, { "cache-control": "no-store" }));
    expect(result.storable).toBe(false);
  });

  it("refuses private for a shared cache", () => {
    const result = isStorable(request("GET"), response(200, { "cache-control": "private" }));
    expect(result.storable).toBe(false);
  });

  it("refuses an authorized request by default", () => {
    const result = isStorable(request("GET", { authorization: "Bearer x" }), response(200));
    expect(result.storable).toBe(false);
  });

  it("allows an authorized request when the response is public", () => {
    const result = isStorable(
      request("GET", { authorization: "Bearer x" }),
      response(200, { "cache-control": "public" }),
    );
    expect(result.storable).toBe(true);
  });

  it("allows an authorized request when the response sets s-maxage", () => {
    const result = isStorable(
      request("GET", { authorization: "Bearer x" }),
      response(200, { "cache-control": "s-maxage=60" }),
    );
    expect(result.storable).toBe(true);
  });

  it("refuses Vary: *", () => {
    expect(isStorable(request("GET"), response(200, { vary: "*" })).storable).toBe(false);
  });

  it("explains its decision via reason", () => {
    expect(isStorable(request("POST"), response(200)).reason).toMatch(/method/i);
  });
});

describe("freshnessLifetime", () => {
  it("prefers s-maxage over max-age (shared cache)", () => {
    expect(
      freshnessLifetime(response(200, { "cache-control": "s-maxage=30, max-age=60" }), 3600),
    ).toBe(30);
  });

  it("uses max-age when there is no s-maxage", () => {
    expect(freshnessLifetime(response(200, { "cache-control": "max-age=60" }), 3600)).toBe(60);
  });

  it("falls back to Expires - Date", () => {
    const date = new Date(1_700_000_000_000);
    const expires = new Date(1_700_000_000_000 + 100_000);
    expect(
      freshnessLifetime(
        response(200, { date: date.toUTCString(), expires: expires.toUTCString() }),
        3600,
      ),
    ).toBe(100);
  });

  it("falls back to the configured TTL when nothing is specified", () => {
    expect(freshnessLifetime(response(200), 3600)).toBe(3600);
  });
});

describe("currentAge", () => {
  const T = 1_700_000_000_000;
  const timing = (over: Partial<ResponseTiming> = {}): ResponseTiming => ({
    dateValue: T,
    ageValue: 0,
    requestTime: T,
    responseTime: T,
    ...over,
  });

  it("is zero for a just-received response with no prior age", () => {
    expect(currentAge(timing(), T)).toBe(0);
  });

  it("counts time resident in our cache", () => {
    expect(currentAge(timing(), T + 10_000)).toBe(10);
  });

  it("respects the upstream Age header", () => {
    expect(currentAge(timing({ ageValue: 100 }), T)).toBe(100);
  });

  it("derives apparent age from the Date header", () => {
    expect(currentAge(timing({ dateValue: T - 50_000 }), T)).toBe(50);
  });

  it("adds the request->response network delay to the Age header", () => {
    expect(currentAge(timing({ requestTime: T - 2_000, ageValue: 10 }), T)).toBe(12);
  });
});

describe("evaluateFreshness", () => {
  const T = 1_700_000_000_000;
  const timing: ResponseTiming = { dateValue: T, ageValue: 0, requestTime: T, responseTime: T };

  it("is fresh while age < lifetime", () => {
    const r = evaluateFreshness(
      response(200, { "cache-control": "max-age=60" }),
      timing,
      T + 10_000,
      3600,
    );
    expect(r).toEqual({ fresh: true, ageSeconds: 10, lifetimeSeconds: 60 });
  });

  it("is stale once age >= lifetime", () => {
    const r = evaluateFreshness(
      response(200, { "cache-control": "max-age=60" }),
      timing,
      T + 70_000,
      3600,
    );
    expect(r.fresh).toBe(false);
  });

  it("uses the configured TTL when the origin gives no freshness info", () => {
    const r = evaluateFreshness(response(200), timing, T + 10_000, 3600);
    expect(r).toEqual({ fresh: true, ageSeconds: 10, lifetimeSeconds: 3600 });
  });
});
