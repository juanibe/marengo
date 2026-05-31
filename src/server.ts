/**
 * Inbound HTTP server (#3): accepts requests and hands each to `proxyToOrigin`.
 *
 * Kept tiny on purpose — the request lifecycle, header surgery, and pooling
 * live in `proxy.ts`. This module only knows how to listen and how to surface
 * unexpected errors as 502 Bad Gateway.
 */

import { createServer, type Server } from "node:http";
import type { Config } from "./config/schema.ts";
import { proxyToOrigin } from "./proxy.ts";

export function createProxyServer(config: Config): Server {
  return createServer((req, res) => {
    void proxyToOrigin(req, res, config).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain" });
      }
      res.end("Bad Gateway\n");
      // Structured logging of the error lands in #11 (logging).
    });
  });
}
