import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KeyableRequest } from "../src/cache/key.ts";
import type { ResponseTiming } from "../src/cache/policy.ts";
import { MemoryStore, type StorableResponse } from "../src/cache/store.ts";
import { createLogger } from "../src/log.ts";
import { createMetrics, createMetricsServer, type Metrics } from "../src/metrics.ts";

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
let metrics: Metrics;

beforeEach(() => {
  store = new MemoryStore(10 * MB);
  metrics = createMetrics({ store });
});

async function scrape(): Promise<string> {
  return metrics.registry.metrics();
}

describe("createMetrics — request counter + duration histogram", () => {
  it("increments requests_total per label combination", async () => {
    metrics.recordRequest({ cache: "hit", method: "GET", status: 200 }, 1);
    metrics.recordRequest({ cache: "hit", method: "GET", status: 200 }, 1);
    metrics.recordRequest({ cache: "miss", method: "GET", status: 200 }, 50);

    const out = await scrape();
    expect(out).toContain('marengo_requests_total{cache="hit",method="GET",status="200"} 2');
    expect(out).toContain('marengo_requests_total{cache="miss",method="GET",status="200"} 1');
  });

  it("observes durations into the histogram (count + buckets)", async () => {
    metrics.recordRequest({ cache: "hit", method: "GET", status: 200 }, 2);
    metrics.recordRequest({ cache: "hit", method: "GET", status: 200 }, 80);

    const out = await scrape();
    expect(out).toContain('marengo_request_duration_seconds_count{cache="hit"} 2');
    // 2ms and 80ms both fall under the 100ms (0.1) bucket
    expect(out).toMatch(/marengo_request_duration_seconds_bucket\{[^}]*le="0\.1"[^}]*\} 2/);
  });
});

describe("createMetrics — origin error counter", () => {
  it("increments on recordOriginError", async () => {
    metrics.recordOriginError();
    metrics.recordOriginError();
    const out = await scrape();
    expect(out).toContain("marengo_origin_errors_total 2");
  });
});

describe("createMetrics — cache-state gauges read from store at scrape time", () => {
  it("exposes entries / bytes / max_bytes / primaryKeys / evictions", async () => {
    store.set(req("GET", "http://x/a"), res(200, "hello"), timing());
    store.get(req("GET", "http://x/a")); // 1 hit to bump internal counters

    const out = await scrape();
    expect(out).toContain("marengo_cache_entries 1");
    expect(out).toContain("marengo_cache_primary_keys 1");
    // bytes > 0 (don't depend on exact size)
    expect(out).toMatch(/marengo_cache_bytes [1-9]\d*/);
    expect(out).toMatch(/marengo_cache_max_bytes \d+/);
    expect(out).toContain("marengo_cache_evictions_total 0");
  });

  it("reflects updates without us pushing anything", async () => {
    const before = await scrape();
    expect(before).toContain("marengo_cache_entries 0");

    store.set(req("GET", "http://x/a"), res(200, "hello"), timing());

    const after = await scrape();
    expect(after).toContain("marengo_cache_entries 1");
  });
});

describe("createMetrics — exposition format", () => {
  it("uses the prom-client content-type", () => {
    expect(metrics.registry.contentType).toContain("text/plain");
    expect(metrics.registry.contentType).toContain("version=0.0.4");
  });

  it("includes Node.js process metrics (event loop / GC / memory)", async () => {
    const out = await scrape();
    expect(out).toContain("process_cpu_user_seconds_total");
    expect(out).toContain("nodejs_eventloop_lag_seconds");
  });
});

describe("metrics server", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    server = createMetricsServer({ metrics, logger: silentLogger });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function call(
    path: string,
    method = "GET",
  ): Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const r = httpRequest({ host: "127.0.0.1", port, method, path }, (resp) => {
        const chunks: Buffer[] = [];
        resp.on("data", (c: Buffer) => chunks.push(c));
        resp.on("end", () =>
          resolve({
            status: resp.statusCode ?? 0,
            headers: resp.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      });
      r.on("error", reject);
      r.end();
    });
  }

  it("GET /metrics returns 200 with prometheus exposition", async () => {
    metrics.recordRequest({ cache: "hit", method: "GET", status: 200 }, 1);
    const r = await call("/metrics");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/plain");
    expect(r.body).toContain("marengo_requests_total");
  });

  it("404s on anything else", async () => {
    expect((await call("/")).status).toBe(404);
    expect((await call("/stats")).status).toBe(404);
    expect((await call("/metrics", "POST")).status).toBe(404);
  });
});
