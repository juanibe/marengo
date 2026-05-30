import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../../src/config/load.ts";
import { parseDurationSeconds, parseListenAddress } from "../../src/config/schema.ts";

describe("parseDurationSeconds", () => {
  it.each([
    ["60s", 60],
    ["5m", 300],
    ["1h", 3600],
    ["1d", 86400],
    ["2w", 1209600],
    ["500ms", 0.5],
  ])("%s -> %i", (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });

  it.each(["", "abc", "60xy", "1.5s", "-10s", "60", "ms"])("rejects %s", (input) => {
    expect(parseDurationSeconds(input)).toBeNull();
  });
});

describe("parseListenAddress", () => {
  it("parses :port (bind all interfaces)", () => {
    expect(parseListenAddress(":8080")).toEqual({ port: 8080 });
  });

  it("parses host:port", () => {
    expect(parseListenAddress("127.0.0.1:9090")).toEqual({ host: "127.0.0.1", port: 9090 });
  });

  it("parses bracketed IPv6", () => {
    expect(parseListenAddress("[::1]:9091")).toEqual({ host: "::1", port: 9091 });
  });

  it.each([
    "",
    "8080",
    ":",
    ":0",
    ":99999",
    "host:",
    "host:abc",
    "[::1]",
  ])("rejects %s", (input) => {
    expect(parseListenAddress(input)).toBeNull();
  });
});

describe("ConfigSchema (parseConfig)", () => {
  const minimal = {
    listen: { proxy: ":8080" },
    origins: [{ host: "blog.example.com", upstream: "http://localhost:3000" }],
  };

  it("parses a minimal config and applies defaults", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.listen.proxy).toEqual({ port: 8080 });
    expect(cfg.listen.admin).toEqual({ host: "127.0.0.1", port: 9090 });
    expect(cfg.listen.metrics).toEqual({ host: "127.0.0.1", port: 9091 });
    expect(cfg.cache.max_size_mb).toBe(512);
    expect(cfg.logging).toEqual({ level: "info", format: "json" });
    expect(cfg.origins[0]?.rules).toEqual([]);
  });

  it("parses durations inside origin rules to seconds", () => {
    const cfg = parseConfig({
      ...minimal,
      origins: [
        {
          host: "x",
          upstream: "http://x",
          rules: [
            { path: "/api/*", ttl: "60s" },
            { path: "/assets/*", ttl: "7d" },
            { path: "/*", ttl: "1h" },
          ],
        },
      ],
    });
    expect(cfg.origins[0]?.rules.map((r) => r.ttl)).toEqual([60, 604800, 3600]);
  });

  it("rejects a missing origins array", () => {
    expect(() => parseConfig({ listen: { proxy: ":8080" } })).toThrow(ConfigError);
  });

  it("rejects an empty origins array with a helpful message", () => {
    expect(() => parseConfig({ ...minimal, origins: [] })).toThrow(/at least one origin/);
  });

  it("rejects a bad duration with the offending value in the message", () => {
    expect(() =>
      parseConfig({
        ...minimal,
        origins: [{ host: "x", upstream: "http://x", rules: [{ path: "/", ttl: "60xy" }] }],
      }),
    ).toThrow(/60xy/);
  });

  it("rejects a bad upstream URL", () => {
    expect(() =>
      parseConfig({ ...minimal, origins: [{ host: "x", upstream: "not-a-url" }] }),
    ).toThrow(/upstream/);
  });

  it("rejects a bad listen address", () => {
    expect(() => parseConfig({ ...minimal, listen: { proxy: "8080" } })).toThrow(/address/);
  });

  it("rejects non-positive max_size_mb", () => {
    expect(() => parseConfig({ ...minimal, cache: { max_size_mb: 0 } })).toThrow(ConfigError);
  });

  it("rejects an invalid log level", () => {
    expect(() => parseConfig({ ...minimal, logging: { level: "loud" } })).toThrow(ConfigError);
  });
});
