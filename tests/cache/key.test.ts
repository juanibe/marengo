import { describe, expect, it } from "vitest";
import { type KeyableRequest, parseVary, primaryKey, secondaryKey } from "../../src/cache/key.ts";

const req = (method: string, url: string): KeyableRequest => ({
  method,
  url,
  headers: new Headers(),
});

describe("primaryKey", () => {
  it("combines method and URL", () => {
    expect(primaryKey(req("GET", "http://blog.test/posts/5"))).toBe("GET http://blog.test/posts/5");
  });

  it("uppercases the method", () => {
    expect(primaryKey(req("get", "http://blog.test/"))).toBe("GET http://blog.test/");
  });

  it("lowercases scheme and host but preserves path case", () => {
    expect(primaryKey(req("GET", "HTTP://Blog.TEST/Posts/Five"))).toBe(
      "GET http://blog.test/Posts/Five",
    );
  });

  it("treats the default port as equivalent to no port", () => {
    expect(primaryKey(req("GET", "http://blog.test:80/"))).toBe(
      primaryKey(req("GET", "http://blog.test/")),
    );
  });

  it("keeps a non-default port", () => {
    expect(primaryKey(req("GET", "http://blog.test:8080/"))).toBe("GET http://blog.test:8080/");
  });

  it("preserves query string exactly — order is significant", () => {
    expect(primaryKey(req("GET", "http://blog.test/s?a=1&b=2"))).not.toBe(
      primaryKey(req("GET", "http://blog.test/s?b=2&a=1")),
    );
  });

  it("distinguishes methods", () => {
    expect(primaryKey(req("GET", "http://blog.test/"))).not.toBe(
      primaryKey(req("HEAD", "http://blog.test/")),
    );
  });
});

describe("parseVary", () => {
  it("returns [] when the header is absent or empty", () => {
    expect(parseVary(null)).toEqual([]);
    expect(parseVary("")).toEqual([]);
  });

  it("splits, trims, and lowercases the header names", () => {
    expect(parseVary("  Accept-Encoding ,ACCEPT-Language ")).toEqual([
      "accept-encoding",
      "accept-language",
    ]);
  });

  it("captures the wildcard", () => {
    expect(parseVary("*")).toEqual(["*"]);
  });
});

describe("secondaryKey", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it("is empty when nothing varies", () => {
    expect(secondaryKey([], headers({ "accept-language": "en" }))).toBe("");
  });

  it("includes the value of each varied header", () => {
    expect(secondaryKey(["accept-language"], headers({ "accept-language": "en" }))).toBe(
      "accept-language: en",
    );
  });

  it("differs when a varied header's value differs", () => {
    const en = secondaryKey(["accept-language"], headers({ "accept-language": "en" }));
    const es = secondaryKey(["accept-language"], headers({ "accept-language": "es" }));
    expect(en).not.toBe(es);
  });

  it("is independent of the Vary list's order", () => {
    const h = headers({ "accept-encoding": "gzip", "accept-language": "en" });
    expect(secondaryKey(["accept-encoding", "accept-language"], h)).toBe(
      secondaryKey(["accept-language", "accept-encoding"], h),
    );
  });

  it("reads request headers case-insensitively", () => {
    expect(secondaryKey(["accept-language"], headers({ "Accept-Language": "en" }))).toBe(
      "accept-language: en",
    );
  });

  it("distinguishes an absent header from a present one", () => {
    const present = secondaryKey(["x-test"], headers({ "x-test": "v" }));
    const absent = secondaryKey(["x-test"], headers({}));
    expect(present).not.toBe(absent);
  });

  it("trims surrounding whitespace in values", () => {
    expect(secondaryKey(["x-test"], headers({ "x-test": "  v  " }))).toBe(
      secondaryKey(["x-test"], headers({ "x-test": "v" })),
    );
  });
});

describe("primary + secondary together", () => {
  it("gives two languages of one URL different full keys", () => {
    const vary = ["accept-language"];
    const fullKey = (lang: string) => {
      const r = req("GET", "http://blog.test/posts/5");
      r.headers.set("accept-language", lang);
      return `${primaryKey(r)}\n${secondaryKey(vary, r.headers)}`;
    };
    expect(fullKey("en")).not.toBe(fullKey("es"));
  });
});
