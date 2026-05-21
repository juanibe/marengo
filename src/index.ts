import { createServer, type Server } from "node:http";

const DEFAULT_PORT = 8080;

/**
 * Placeholder server for the scaffold. The real pipeline (config -> proxy ->
 * cache -> admin/metrics) is wired up in later issues; this just proves the
 * toolchain boots and gives the smoke test something to hit.
 */
export function createStubServer(): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("marengo: scaffold OK — not yet configured\n");
  });
}

function main(): void {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = createStubServer();
  server.listen(port, () => {
    console.log(`marengo stub listening on http://localhost:${port}`);
  });
}

if (import.meta.main) {
  main();
}
