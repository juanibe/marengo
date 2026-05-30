import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { addForwarded, addVia, stripHopByHop } from "../../src/proxy.ts";

describe("stripHopByHop", () => {
  it("drops the standard hop-by-hop set", () => {
    const result = stripHopByHop({
      connection: "close",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "proxy-authenticate": "basic",
      "proxy-authorization": "x",
      te: "trailers",
      trailer: "x",
      upgrade: "h2c",
      "content-type": "text/plain",
    });
    expect(result).toEqual({ "content-type": "text/plain" });
  });

  it("also drops headers named in the Connection field (extension hop-by-hop)", () => {
    const result = stripHopByHop({
      connection: "close, X-Custom-1, X-Custom-2",
      "x-custom-1": "secret",
      "x-custom-2": "secret",
      "x-keep": "preserved",
    });
    expect(result).toEqual({ "x-keep": "preserved" });
  });

  it("leaves end-to-end headers alone", () => {
    const result = stripHopByHop({
      "cache-control": "max-age=60",
      etag: '"abc"',
      vary: "Accept-Encoding",
    });
    expect(result).toEqual({
      "cache-control": "max-age=60",
      etag: '"abc"',
      vary: "Accept-Encoding",
    });
  });

  it("does not mutate the input", () => {
    const input = { connection: "close", "content-type": "text/plain" };
    stripHopByHop(input);
    expect(input).toEqual({ connection: "close", "content-type": "text/plain" });
  });
});

describe("addVia", () => {
  it("creates Via if missing", () => {
    const h: Record<string, string | string[]> = {};
    addVia(h);
    expect(h.via).toBe("1.1 marengo");
  });

  it("appends to an existing Via chain", () => {
    const h: Record<string, string | string[]> = { via: "1.1 nginx" };
    addVia(h);
    expect(h.via).toBe("1.1 nginx, 1.1 marengo");
  });

  it("uses a custom name when provided", () => {
    const h: Record<string, string | string[]> = {};
    addVia(h, "custom-name");
    expect(h.via).toBe("1.1 custom-name");
  });
});

describe("addForwarded", () => {
  const fakeReq = (host: string, remote = "203.0.113.1"): IncomingMessage =>
    ({ headers: { host }, socket: { remoteAddress: remote } }) as unknown as IncomingMessage;

  it("sets the X-Forwarded-* trio when none are present", () => {
    const h: Record<string, string | string[]> = {};
    addForwarded(h, fakeReq("blog.example.com"));
    expect(h["x-forwarded-for"]).toBe("203.0.113.1");
    expect(h["x-forwarded-host"]).toBe("blog.example.com");
    expect(h["x-forwarded-proto"]).toBe("http");
  });

  it("appends to an existing X-Forwarded-For chain", () => {
    const h: Record<string, string | string[]> = { "x-forwarded-for": "198.51.100.7" };
    addForwarded(h, fakeReq("blog.example.com", "203.0.113.1"));
    expect(h["x-forwarded-for"]).toBe("198.51.100.7, 203.0.113.1");
  });

  it("does not overwrite X-Forwarded-Proto/Host if upstream already set them", () => {
    const h: Record<string, string | string[]> = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "real.example.com",
    };
    addForwarded(h, fakeReq("blog.example.com"));
    expect(h["x-forwarded-proto"]).toBe("https");
    expect(h["x-forwarded-host"]).toBe("real.example.com");
  });
});
