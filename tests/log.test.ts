import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.ts";

interface CapturedLog {
  level: number;
  msg: string;
  [k: string]: unknown;
}

function captureLogger(level: "trace" | "debug" | "info" | "warn" | "error" = "info") {
  const records: CapturedLog[] = [];
  const dest = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: () => void) {
      records.push(JSON.parse(chunk.toString("utf8")));
      cb();
    },
  });
  const logger = createLogger({ level, format: "json" }, dest);
  return { logger, records };
}

describe("createLogger", () => {
  it("emits structured JSON with level and message", () => {
    const { logger, records } = captureLogger();
    logger.info({ foo: 1 }, "hello");
    expect(records[0]).toMatchObject({ msg: "hello", foo: 1, level: 30 });
  });

  it("honors the configured level (debug filtered below info)", () => {
    const { logger, records } = captureLogger("info");
    logger.debug("not emitted");
    logger.info("emitted");
    expect(records).toHaveLength(1);
    expect(records[0]?.msg).toBe("emitted");
  });

  it("redacts sensitive headers when logged in a headers object", () => {
    const { logger, records } = captureLogger();
    logger.info({ headers: { authorization: "Bearer secret", cookie: "s=abc", host: "x" } }, "r");
    const headers = records[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("[Redacted]");
    expect(headers.cookie).toBe("[Redacted]");
    expect(headers.host).toBe("x");
  });

  it("redacts sensitive headers nested under `req.headers`", () => {
    const { logger, records } = captureLogger();
    logger.info({ req: { headers: { authorization: "Bearer secret", host: "x" } } }, "r");
    const headers = (records[0]?.req as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe("[Redacted]");
    expect(headers.host).toBe("x");
  });

  it("serializes Error objects with message and stack", () => {
    const { logger, records } = captureLogger("error");
    logger.error({ err: new Error("boom") }, "fail");
    const err = records[0]?.err as { type: string; message: string; stack?: string };
    expect(err.message).toBe("boom");
    expect(err.stack).toBeDefined();
  });
});
