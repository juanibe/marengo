import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "marengo-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeConfig = async (yaml: string): Promise<string> => {
  const path = join(dir, "config.yaml");
  await writeFile(path, yaml, "utf8");
  return path;
};

describe("loadConfig", () => {
  it("reads, parses, and validates a valid YAML file", async () => {
    const path = await writeConfig(`
listen:
  proxy: ":8080"
origins:
  - host: blog.example.com
    upstream: http://localhost:3000
    rules:
      - path: /api/*
        ttl: 60s
`);
    const cfg = await loadConfig(path);
    expect(cfg.listen.proxy).toEqual({ port: 8080 });
    expect(cfg.origins[0]?.upstream).toBe("http://localhost:3000");
    expect(cfg.origins[0]?.rules[0]).toEqual({ path: "/api/*", ttl: 60 });
  });

  it("throws ConfigError when the file does not exist", async () => {
    await expect(loadConfig(join(dir, "missing.yaml"))).rejects.toThrow(ConfigError);
    await expect(loadConfig(join(dir, "missing.yaml"))).rejects.toThrow(/could not read/);
  });

  it("throws ConfigError on invalid YAML", async () => {
    const path = await writeConfig("listen:\n  proxy: ':8080\norigins: [");
    await expect(loadConfig(path)).rejects.toThrow(ConfigError);
    await expect(loadConfig(path)).rejects.toThrow(/invalid YAML/);
  });

  it("throws ConfigError on schema violations with a field path", async () => {
    const path = await writeConfig(`
listen:
  proxy: ":8080"
origins:
  - host: x
    upstream: not-a-url
`);
    await expect(loadConfig(path)).rejects.toThrow(/origins\.0\.upstream/);
  });
});
