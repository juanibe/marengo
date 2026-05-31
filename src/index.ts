/**
 * Marengo entrypoint (#12).
 *
 * The composition root: load + validate config, build the in-memory store,
 * pre-compile per-origin TTL rules, build the logger, start the cache-aware
 * proxy server, and register graceful-shutdown signal handlers.
 *
 * Everything else in the codebase is a pure module or a building block; this
 * file is where it all comes together.
 *
 * Usage:  marengo path/to/config.yaml
 *         (also runs via `npm run dev -- path/to/config.yaml` in development)
 */

import type { Server } from "node:http";
import { createAdminServer } from "./admin/server.ts";
import { type CompiledRule, compileRules } from "./cache/rules.ts";
import { MemoryStore } from "./cache/store.ts";
import { ConfigError, loadConfig } from "./config/load.ts";
import { createLogger } from "./log.ts";
import { createCacheServer, type PipelineDeps } from "./pipeline.ts";
import { closeAllPools } from "./proxy.ts";

const MB = 1024 * 1024;

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("usage: marengo <path-to-config.yaml>");
    process.exit(2);
  }

  let deps: PipelineDeps;
  try {
    const config = await loadConfig(configPath);
    deps = {
      config,
      store: new MemoryStore(config.cache.max_size_mb * MB),
      compiledOrigins: new Map<string, CompiledRule[]>(
        config.origins.map((o) => [o.host.toLowerCase(), compileRules(o.rules)]),
      ),
      logger: createLogger(config.logging),
    };
  } catch (err) {
    if (err instanceof ConfigError) {
      // Logger doesn't exist yet — config is what configures it.
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const proxyServer = createCacheServer(deps);
  const { host: proxyHost, port: proxyPort } = deps.config.listen.proxy;
  await new Promise<void>((resolve) => proxyServer.listen(proxyPort, proxyHost, resolve));
  deps.logger.info(
    {
      address: addressOf(proxyServer),
      origins: deps.config.origins.map((o) => o.host),
      cache_max_mb: deps.config.cache.max_size_mb,
    },
    "marengo proxy listening",
  );

  const adminServer = createAdminServer({ store: deps.store, logger: deps.logger });
  const { host: adminHost, port: adminPort } = deps.config.listen.admin;
  await new Promise<void>((resolve) => adminServer.listen(adminPort, adminHost, resolve));
  deps.logger.info({ address: addressOf(adminServer) }, "marengo admin listening");

  // Graceful shutdown: stop accepting new connections, drain pools, exit.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.logger.info({ signal }, "shutting down");
    proxyServer.close();
    adminServer.close();
    await closeAllPools();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function addressOf(server: Server): string {
  const addr = server.address();
  return typeof addr === "object" && addr ? `${addr.address}:${addr.port}` : String(addr);
}

if (import.meta.main) {
  void main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
