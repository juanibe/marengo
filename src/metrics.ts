/**
 * Prometheus metrics (#10).
 *
 * Pull-model exposition: Prometheus scrapes our `/metrics` endpoint. We hold
 * a `prom-client` Registry and increment counters/histograms from the
 * pipeline; gauges that reflect cache state are filled in lazily by a
 * `collect()` callback that reads `store.stats()` at scrape time.
 *
 * Cardinality is kept low on purpose:
 *   - `requests_total` is labelled by (cache, method, status) — all bounded.
 *   - No path label — Prometheus storage hates unbounded label cardinality.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Logger } from "pino";
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";
import type { Store } from "./cache/store.ts";

export interface MetricsDeps {
  store: Store;
}

export interface RequestLabels {
  /** Cache decision — hit / miss / stale / pass / off. */
  cache: string;
  method: string;
  status: number;
}

export interface Metrics {
  readonly registry: Registry;
  /** Record a finished request: increments the counter and observes the histogram. */
  recordRequest(labels: RequestLabels, durationMs: number): void;
  /** Increment when an origin fetch fails (connection refused, timeout, etc.). */
  recordOriginError(): void;
}

/** Build a fresh metrics registry with all of Marengo's metrics installed. */
export function createMetrics(deps: MetricsDeps): Metrics {
  const registry = new Registry();

  const requestsTotal = new Counter({
    name: "marengo_requests_total",
    help: "Total HTTP requests processed, labelled by cache decision, method, status.",
    labelNames: ["cache", "method", "status"] as const,
    registers: [registry],
  });

  const originErrorsTotal = new Counter({
    name: "marengo_origin_errors_total",
    help: "Total failures while fetching from the origin (network/DNS/timeout).",
    registers: [registry],
  });

  const requestDurationSeconds = new Histogram({
    name: "marengo_request_duration_seconds",
    help: "End-to-end request duration in seconds, labelled by cache decision.",
    labelNames: ["cache"] as const,
    // Log-ish buckets covering cache hits (~ms) to slow origins (~seconds).
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // Cache-state gauges — `collect` is called at scrape time, so the value
  // is always fresh and we don't have to push updates from set/get sites.
  const gaugeFromStats = (name: string, help: string, get: () => number): Gauge =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(get());
      },
    });

  gaugeFromStats(
    "marengo_cache_entries",
    "Current number of cached variants (one URL may have several).",
    () => deps.store.stats().entries,
  );
  gaugeFromStats(
    "marengo_cache_primary_keys",
    "Current number of distinct primary cache keys (URLs).",
    () => deps.store.stats().primaryKeys,
  );
  gaugeFromStats(
    "marengo_cache_bytes",
    "Bytes currently held in the cache (headers + body, approximate).",
    () => deps.store.stats().bytes,
  );
  gaugeFromStats(
    "marengo_cache_max_bytes",
    "Configured cache byte budget.",
    () => deps.store.stats().maxBytes,
  );
  gaugeFromStats(
    "marengo_cache_evictions_total",
    "Total entries evicted by LRU (monotonic; modelled as a gauge for store ownership).",
    () => deps.store.stats().evictions,
  );

  // Node.js process metrics (event loop lag, GC, memory, etc.).
  collectDefaultMetrics({ register: registry });

  return {
    registry,
    recordRequest({ cache, method, status }, durationMs) {
      requestsTotal.inc({ cache, method, status: String(status) });
      requestDurationSeconds.observe({ cache }, durationMs / 1000);
    },
    recordOriginError() {
      originErrorsTotal.inc();
    },
  };
}

// ---------------------------------------------------------------------------
// The metrics server — its own port, no auth (loopback-bind by default).
// ---------------------------------------------------------------------------

export interface MetricsServerDeps {
  metrics: Metrics;
  logger: Logger;
}

export function createMetricsServer(deps: MetricsServerDeps): Server {
  return createHttpServer((req, res) => void handle(req, res, deps));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetricsServerDeps,
): Promise<void> {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (req.method !== "GET" || path !== "/metrics") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found\n");
    return;
  }
  try {
    const body = await deps.metrics.registry.metrics();
    res.writeHead(200, { "content-type": deps.metrics.registry.contentType });
    res.end(body);
  } catch (err) {
    deps.logger.error({ err }, "metrics scrape failed");
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
    }
    res.end("error\n");
  }
}
