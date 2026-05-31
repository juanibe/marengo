import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminServer } from "../../src/admin/server.ts";
import type { KeyableRequest } from "../../src/cache/key.ts";
import type { ResponseTiming } from "../../src/cache/policy.ts";
import { MemoryStore, type StorableResponse } from "../../src/cache/store.ts";
import { createLogger } from "../../src/log.ts";

const logSink = new Writable({
  write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
    cb();
  },
});
const silentLogger = createLogger({ level: "error", format: "json" }, logSink);

const MB = 1024 * 1024;
const T = 1_700_000_000_000;

const req = (method: string, url: string): KeyableRequest => ({
  method,
  url,
  headers: new Headers(),
});

const res = (status: number, body: string): StorableResponse => ({
  status,
  headers: new Headers({ "content-type": "text/plain" }),
  body: new TextEncoder().encode(body),
});

const timing = (): ResponseTiming => ({
  dateValue: T,
  ageValue: 0,
  requestTime: T,
  responseTime: T,
});

let store: MemoryStore;
let adminServer: Server;
let adminPort: number;

beforeEach(async () => {
  store = new MemoryStore(10 * MB);
  adminServer = createAdminServer({ store, logger: silentLogger });
  await new Promise<void>((r) => adminServer.listen(0, "127.0.0.1", r));
  adminPort = (adminServer.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((r) => adminServer.close(() => r()));
});

interface CallOptions {
  method?: string;
  path: string;
  body?: string;
  contentType?: string;
}
interface CallResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function call(opts: CallOptions): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) {
      headers["content-type"] = opts.contentType ?? "application/json";
      headers["content-length"] = String(Buffer.byteLength(opts.body));
    }
    const r = httpRequest(
      {
        host: "127.0.0.1",
        port: adminPort,
        method: opts.method ?? "GET",
        path: opts.path,
        headers,
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () =>
          resolve({
            status: resp.statusCode ?? 0,
            headers: resp.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    r.on("error", reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

describe("admin server — /health", () => {
  it("returns 200 ok", async () => {
    const r = await call({ path: "/health" });
    expect(r.status).toBe(200);
    expect(r.body.trim()).toBe("ok");
  });
});

describe("admin server — /stats", () => {
  it("returns the empty store's stats as JSON", async () => {
    const r = await call({ path: "/stats" });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(r.body)).toMatchObject({
      entries: 0,
      primaryKeys: 0,
      bytes: 0,
      hits: 0,
      misses: 0,
      hitRatio: 0,
    });
  });

  it("reflects activity on the underlying store", async () => {
    const a = req("GET", "http://x/a");
    store.set(a, res(200, "hello"), timing());
    store.get(a); // 1 hit
    store.get(req("GET", "http://x/nope")); // 1 miss

    const r = await call({ path: "/stats" });
    const s = JSON.parse(r.body);
    expect(s.entries).toBe(1);
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(1);
    expect(s.hitRatio).toBeCloseTo(0.5);
  });
});

describe("admin server — POST /purge", () => {
  it("purges by exact primary key and returns the count removed", async () => {
    store.set(req("GET", "http://x/a"), res(200, "a"), timing());
    store.set(req("GET", "http://x/b"), res(200, "b"), timing());

    const r = await call({
      method: "POST",
      path: "/purge",
      body: JSON.stringify({ pattern: "GET http://x/a" }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ removed: 1 });
    expect(store.stats().entries).toBe(1);
  });

  it("purges by prefix pattern (trailing *)", async () => {
    store.set(req("GET", "http://x/api/posts"), res(200, "1"), timing());
    store.set(req("GET", "http://x/api/users"), res(200, "2"), timing());
    store.set(req("GET", "http://x/assets/logo"), res(200, "3"), timing());

    const r = await call({
      method: "POST",
      path: "/purge",
      body: JSON.stringify({ pattern: "GET http://x/api/*" }),
    });
    expect(JSON.parse(r.body)).toEqual({ removed: 2 });
    expect(store.stats().primaryKeys).toBe(1);
  });

  it("400s when the body is not JSON", async () => {
    const r = await call({ method: "POST", path: "/purge", body: "not json" });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/JSON/);
  });

  it("400s when `pattern` is missing", async () => {
    const r = await call({ method: "POST", path: "/purge", body: JSON.stringify({}) });
    expect(r.status).toBe(400);
  });

  it("400s when `pattern` is empty", async () => {
    const r = await call({
      method: "POST",
      path: "/purge",
      body: JSON.stringify({ pattern: "" }),
    });
    expect(r.status).toBe(400);
  });
});

describe("admin server — routing", () => {
  it("405s with an Allow header for the wrong method on a known path", async () => {
    const r = await call({ method: "PUT", path: "/purge" });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST");
  });

  it("404s on an unknown path", async () => {
    const r = await call({ path: "/nope" });
    expect(r.status).toBe(404);
  });
});
