/**
 * Structured logging (#11).
 *
 * One logger built from `config.logging`, used by everything. Three choices
 * worth noting:
 *
 * 1. Structured JSON by default — every line is `{level, msg, ...fields}` so
 *    journalctl / docker logs / Loki can filter on `cache: "HIT"` or
 *    `status: 502` without regex.
 *
 * 2. Redaction at the logger — `Authorization` / `Cookie` / `Set-Cookie` /
 *    `Proxy-Authorization` are scrubbed pino-side. Even if some future code
 *    accidentally logs a whole headers object, the secrets never leak.
 *
 * 3. `format: pretty` swaps in pino-pretty (colors, friendly time) for local
 *    development. Production stays on raw JSON to keep startup fast and
 *    output machine-parseable.
 */

import type { DestinationStream, Logger } from "pino";
import pino from "pino";
import type { Config } from "./config/schema.ts";

export type LoggingConfig = Config["logging"];

const REDACT_PATHS = [
  // bare headers objects
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  'headers["proxy-authorization"]',
  // nested under `req` (matches pino's stdSerializers.req shape)
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'req.headers["proxy-authorization"]',
];

/**
 * Build a logger from `config.logging`. `destination` is for tests; if omitted
 * pino writes to stdout (or, in pretty mode, hands off to pino-pretty).
 */
export function createLogger(cfg: LoggingConfig, destination?: DestinationStream): Logger {
  const shared = {
    level: cfg.level,
    redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
    serializers: pino.stdSerializers,
  };

  if (cfg.format === "pretty") {
    return pino({
      ...shared,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(shared, destination);
}
