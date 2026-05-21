import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createStubServer } from "../src/index.ts";

let server: ReturnType<typeof createStubServer>;
let baseUrl: string;

beforeEach(async () => {
  server = createStubServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

it("responds 200 from the stub server", async () => {
  const res = await fetch(baseUrl);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("marengo");
});
