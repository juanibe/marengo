import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load.ts";
import { closeAllPools } from "../../src/proxy.ts";
import { createProxyServer } from "../../src/server.ts";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let originServer: Server;
let proxyServer: Server;
let originPort: number;
let proxyPort: number;
let lastOriginRequest: CapturedRequest | null;
/** Lets a test override the origin's response body for a single request. */
let originResponse: { status: number; headers: Record<string, string>; body: string };

beforeEach(async () => {
  lastOriginRequest = null;
  originResponse = {
    status: 200,
    headers: { "content-type": "text/plain", etag: '"abc"' },
    body: "hello from origin",
  };

  originServer = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastOriginRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      res.writeHead(originResponse.status, originResponse.headers);
      res.end(originResponse.body);
    });
  });
  await new Promise<void>((r) => originServer.listen(0, "127.0.0.1", r));
  originPort = (originServer.address() as AddressInfo).port;

  const config = parseConfig({
    listen: { proxy: ":0" },
    origins: [
      {
        host: "blog.example.com",
        upstream: `http://127.0.0.1:${originPort}`,
      },
    ],
  });

  proxyServer = createProxyServer(config);
  await new Promise<void>((r) => proxyServer.listen(0, "127.0.0.1", r));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await closeAllPools();
  await new Promise<void>((r) => proxyServer.close(() => r()));
  await new Promise<void>((r) => originServer.close(() => r()));
});

interface CallOptions {
  method?: string;
  path?: string;
  host: string;
  headers?: Record<string, string>;
  body?: string;
}
interface CallResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(opts: CallOptions): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: opts.host, ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

describe("proxy server — basic forwarding", () => {
  it("forwards a GET to the matching origin and returns its body", async () => {
    const res = await call({ host: "blog.example.com", path: "/posts/5" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello from origin");
    expect(lastOriginRequest?.method).toBe("GET");
    expect(lastOriginRequest?.url).toBe("/posts/5");
  });

  it("passes end-to-end response headers back to the client", async () => {
    const res = await call({ host: "blog.example.com" });
    expect(res.headers["content-type"]).toBe("text/plain");
    expect(res.headers.etag).toBe('"abc"');
  });

  it("returns 421 when no origin matches the Host header", async () => {
    const res = await call({ host: "unknown.example.com" });
    expect(res.status).toBe(421);
  });

  it("forwards a request body for non-safe methods", async () => {
    const res = await call({
      host: "blog.example.com",
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello body",
    });
    expect(res.status).toBe(200);
    expect(lastOriginRequest?.method).toBe("POST");
    expect(lastOriginRequest?.body).toBe("hello body");
  });
});

describe("proxy server — header surgery", () => {
  it("strips hop-by-hop headers on the way to the origin", async () => {
    await call({
      host: "blog.example.com",
      headers: {
        "keep-alive": "timeout=5",
        // (transfer-encoding and connection are managed by node:http itself;
        // we test the user-controllable extension hop-by-hop instead)
      },
    });
    const h = lastOriginRequest!.headers;
    expect(h["keep-alive"]).toBeUndefined();
  });

  it("strips Connection-listed extension hop-by-hop headers", async () => {
    await call({
      host: "blog.example.com",
      headers: {
        connection: "keep-alive, X-Custom",
        "x-custom": "should-be-stripped",
        "x-keep": "preserved",
      },
    });
    const h = lastOriginRequest!.headers;
    expect(h["x-custom"]).toBeUndefined();
    expect(h["x-keep"]).toBe("preserved");
  });

  it("adds Via and the X-Forwarded-* trio on the request", async () => {
    await call({ host: "blog.example.com" });
    const h = lastOriginRequest!.headers;
    expect(h.via).toBe("1.1 marengo");
    expect(h["x-forwarded-host"]).toBe("blog.example.com");
    expect(h["x-forwarded-proto"]).toBe("http");
    expect(h["x-forwarded-for"]).toBeDefined();
  });

  it("appends Via to an existing chain on the response", async () => {
    originResponse = {
      status: 200,
      headers: { "content-type": "text/plain", via: "1.1 origin-cdn" },
      body: "ok",
    };
    const res = await call({ host: "blog.example.com" });
    expect(res.headers.via).toBe("1.1 origin-cdn, 1.1 marengo");
  });
});
