import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compileRules } from "../src/cache/rules.ts";
import { MemoryStore } from "../src/cache/store.ts";
import { parseConfig } from "../src/config/load.ts";
import { createLogger } from "../src/log.ts";
import { createCacheServer } from "../src/pipeline.ts";
import { closeAllPools } from "../src/proxy.ts";

// pino + sink-destination so test output stays clean regardless of level.
const logSink = new Writable({
  write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    cb();
  },
});
const silentLogger = createLogger({ level: "error", format: "json" }, logSink);

const MB = 1024 * 1024;

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
let originHits: number;
let lastOriginRequest: CapturedRequest | null;
/** Lets a test override the origin's response shape per test. */
let originResponse: { status: number; headers: Record<string, string>; body: string };

beforeEach(async () => {
  originHits = 0;
  lastOriginRequest = null;
  originResponse = {
    status: 200,
    headers: { "content-type": "text/plain" },
    body: "hello from origin",
  };

  originServer = createServer((req: IncomingMessage, res) => {
    originHits++;
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
    cache: { max_size_mb: 1 },
    origins: [
      {
        host: "blog.example.com",
        upstream: `http://127.0.0.1:${originPort}`,
        rules: [{ path: "/cached/*", ttl: "60s" }],
      },
    ],
  });

  const deps = {
    config,
    store: new MemoryStore(config.cache.max_size_mb * MB),
    compiledOrigins: new Map(
      config.origins.map((o) => [o.host.toLowerCase(), compileRules(o.rules)]),
    ),
    logger: silentLogger,
  };

  proxyServer = createCacheServer(deps);
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
  host?: string;
  headers?: Record<string, string>;
  body?: string;
}
interface CallResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(opts: CallOptions = {}): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers: { host: opts.host ?? "blog.example.com", ...opts.headers },
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

describe("cache pipeline — MISS then HIT", () => {
  it("first GET is a MISS that stores; second GET is a HIT (origin untouched)", async () => {
    const first = await call({ path: "/cached/post" });
    expect(first.status).toBe(200);
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.body).toBe("hello from origin");
    expect(originHits).toBe(1);

    const second = await call({ path: "/cached/post" });
    expect(second.status).toBe(200);
    expect(second.headers["x-cache"]).toBe("HIT");
    expect(second.body).toBe("hello from origin");
    expect(originHits).toBe(1); // origin NOT called again
    expect(second.headers.age).toBeDefined();
  });

  it("HEAD has its own cache key — first HEAD is a MISS, second is a HIT", async () => {
    // GET and HEAD primary keys are different (method is part of the key);
    // v0.1 does not implement the optional "serve HEAD from a stored GET".
    const first = await call({ method: "HEAD", path: "/cached/post" });
    expect(first.headers["x-cache"]).toBe("MISS");
    const second = await call({ method: "HEAD", path: "/cached/post" });
    expect(second.headers["x-cache"]).toBe("HIT");
  });
});

describe("cache pipeline — non-storable responses pass through", () => {
  it("Cache-Control: no-store is not stored; both requests reach origin", async () => {
    originResponse = {
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "no-store" },
      body: "fresh always",
    };
    const first = await call({ path: "/cached/x" });
    expect(first.headers["x-cache"]).toBe("PASS");
    expect(first.body).toBe("fresh always");

    const second = await call({ path: "/cached/x" });
    expect(second.headers["x-cache"]).toBe("PASS");
    expect(originHits).toBe(2);
  });

  it("a request with Authorization is not stored unless the origin opts in", async () => {
    await call({ path: "/cached/secret", headers: { authorization: "Bearer x" } });
    await call({ path: "/cached/secret", headers: { authorization: "Bearer x" } });
    expect(originHits).toBe(2); // each request reaches origin
  });
});

describe("cache pipeline — pass-through for non-cacheable methods", () => {
  it("POST is X-Cache: PASS and always reaches origin", async () => {
    const res = await call({
      method: "POST",
      path: "/cached/post",
      headers: { "content-type": "text/plain" },
      body: "create me",
    });
    expect(res.headers["x-cache"]).toBe("PASS");
    expect(res.body).toBe("hello from origin");
    expect(lastOriginRequest?.method).toBe("POST");
    expect(lastOriginRequest?.body).toBe("create me");
  });

  it("returns 421 when no origin matches the Host header", async () => {
    const res = await call({ host: "unknown.example.com", path: "/anything" });
    expect(res.status).toBe(421);
  });
});

describe("cache pipeline — Vary handling", () => {
  it("two Accept-Encoding values cache as separate variants under one URL", async () => {
    originResponse = {
      status: 200,
      headers: { "content-type": "text/plain", vary: "Accept-Encoding" },
      body: "varied",
    };

    const gzip = await call({ path: "/cached/p", headers: { "accept-encoding": "gzip" } });
    const br = await call({ path: "/cached/p", headers: { "accept-encoding": "br" } });
    expect(gzip.headers["x-cache"]).toBe("MISS");
    expect(br.headers["x-cache"]).toBe("MISS"); // separate variant, also a miss
    expect(originHits).toBe(2);

    const gzip2 = await call({ path: "/cached/p", headers: { "accept-encoding": "gzip" } });
    expect(gzip2.headers["x-cache"]).toBe("HIT");
    expect(originHits).toBe(2);
  });
});

describe("cache pipeline — origin Cache-Control wins over the rule's TTL", () => {
  it("max-age=0 produces a stale-on-arrival entry that re-fetches next time", async () => {
    originResponse = {
      status: 200,
      headers: { "content-type": "text/plain", "cache-control": "max-age=0" },
      body: "edge",
    };
    await call({ path: "/cached/p" });
    expect(originHits).toBe(1);
    const second = await call({ path: "/cached/p" });
    // First lookup was a stale HIT -> refetched -> stored fresh again -> X-Cache: STALE
    expect(second.headers["x-cache"]).toBe("STALE");
    expect(originHits).toBe(2);
  });
});
