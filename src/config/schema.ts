/**
 * Config schema (#2).
 *
 * The YAML file is untrusted input; this module turns it into a strongly-typed
 * `Config` value at startup, once. Two principles:
 *   - Parse, don't validate: every consumer downstream reads typed fields,
 *     never re-checks shapes or re-parses strings.
 *   - Coerce at the boundary: human strings ("60s", ":8080") become the values
 *     the rest of the code wants (seconds, { host, port }).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Helpers — pure parsers, exported so tests can hit them directly.
// ---------------------------------------------------------------------------

/** Parse a duration like "60s", "5m", "1h", "7d", "2w" into seconds. */
export function parseDurationSeconds(s: string): number | null {
  const m = s.trim().match(/^(\d+)(ms|s|m|h|d|w)$/);
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return n / 1000;
    case "s":
      return n;
    case "m":
      return n * 60;
    case "h":
      return n * 3600;
    case "d":
      return n * 86400;
    case "w":
      return n * 604800;
  }
  return null;
}

export interface ListenAddress {
  /** Undefined means "all interfaces". */
  host?: string;
  port: number;
}

/** Parse ":8080", "127.0.0.1:9090", or "[::1]:9091" into { host?, port }. */
export function parseListenAddress(s: string): ListenAddress | null {
  const trimmed = s.trim();

  // IPv6 bracketed:  [::1]:8080
  const ipv6 = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) {
    const port = Number(ipv6[2]);
    return validPort(port) ? { host: ipv6[1], port } : null;
  }

  // No host:  :8080  -> bind all interfaces
  if (trimmed.startsWith(":")) {
    const port = Number(trimmed.slice(1));
    return validPort(port) ? { port } : null;
  }

  // host:port
  const idx = trimmed.lastIndexOf(":");
  if (idx <= 0) return null;
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  return host && validPort(port) ? { host, port } : null;
}

function validPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

// ---------------------------------------------------------------------------
// Zod schemas — the contract.
// ---------------------------------------------------------------------------

const Duration = z.string().transform((s, ctx) => {
  const seconds = parseDurationSeconds(s);
  if (seconds === null) {
    ctx.addIssue({
      code: "custom",
      message: `expected a duration like "60s", "5m", "1h", "7d" — got "${s}"`,
    });
    return z.NEVER;
  }
  return seconds;
});

const ListenAddressField = z.string().transform((s, ctx) => {
  const parsed = parseListenAddress(s);
  if (parsed === null) {
    ctx.addIssue({
      code: "custom",
      message: `expected an address like ":8080", "127.0.0.1:9090", or "[::1]:9091" — got "${s}"`,
    });
    return z.NEVER;
  }
  return parsed;
});

const Rule = z.object({
  path: z.string().min(1, "rule path cannot be empty"),
  ttl: Duration,
});

const Origin = z.object({
  host: z.string().min(1, "origin host cannot be empty"),
  upstream: z.url("upstream must be a valid URL"),
  rules: z.array(Rule).default([]),
});

export const ConfigSchema = z.object({
  listen: z.object({
    proxy: ListenAddressField,
    admin: ListenAddressField.prefault("127.0.0.1:9090"),
    metrics: ListenAddressField.prefault("127.0.0.1:9091"),
  }),
  cache: z
    .object({
      max_size_mb: z.number().int().positive().default(512),
    })
    .prefault({}),
  origins: z.array(Origin).min(1, "at least one origin is required"),
  logging: z
    .object({
      level: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
      format: z.enum(["json", "pretty"]).default("json"),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
