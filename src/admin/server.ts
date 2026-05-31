/**
 * Admin HTTP server (#9).
 *
 * Lives on its own port — `127.0.0.1:9090` by default, never the public proxy
 * port. Security is "bind to loopback, don't expose it"; that's why there's
 * no auth in v0.1.
 *
 * The router is a small hand-rolled switch: three known paths, 405 for the
 * right path with the wrong method, 404 for anything else. No framework.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { Logger } from "pino";
import type { Store } from "../cache/store.ts";
import { health, purge, stats } from "./routes.ts";

export interface AdminServerDeps {
  store: Store;
  logger: Logger;
}

export function createAdminServer(deps: AdminServerDeps): Server {
  return createHttpServer((req, res) => {
    void route(req, res, deps).catch((err) => {
      deps.logger.error({ err, method: req.method, path: req.url }, "admin request failed");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AdminServerDeps,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = (req.url ?? "/").split("?")[0] ?? "/";

  if (method === "GET" && path === "/health") return health(req, res, deps);
  if (method === "GET" && path === "/stats") return stats(req, res, deps);
  if (method === "POST" && path === "/purge") return purge(req, res, deps);

  // Known path, wrong method -> 405 (with `Allow` so curl users self-correct).
  const expected = ALLOWED_METHODS[path];
  if (expected) {
    res.writeHead(405, { "content-type": "text/plain", allow: expected });
    res.end("method not allowed\n");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

const ALLOWED_METHODS: Record<string, string | undefined> = {
  "/health": "GET",
  "/stats": "GET",
  "/purge": "POST",
};
