/**
 * Config loader (#2): read a YAML file and turn it into a validated `Config`,
 * or throw a `ConfigError` with a human-readable message pointing at the
 * offending field. This is the only place that touches the filesystem or
 * deals with the raw YAML/Zod machinery — every other module reads `Config`.
 */

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { type Config, ConfigSchema } from "./schema.ts";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Validate a parsed JS object against `ConfigSchema`. Throws `ConfigError`. */
export function parseConfig(input: unknown, source = "config"): Config {
  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigError(formatZodError(source, result.error));
  }
  return result.data;
}

/** Read a YAML file, parse it, and validate it. Throws `ConfigError` on any failure. */
export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`could not read config file "${path}": ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new ConfigError(`invalid YAML in "${path}": ${(err as Error).message}`);
  }

  return parseConfig(parsed, path);
}

function formatZodError(source: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length === 0 ? "(root)" : issue.path.join(".");
    return `  - ${where}: ${issue.message}`;
  });
  return `invalid config in "${source}":\n${lines.join("\n")}`;
}
