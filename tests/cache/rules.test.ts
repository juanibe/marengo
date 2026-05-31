import { describe, expect, it } from "vitest";
import { compileRules, matchRule, type PathRule } from "../../src/cache/rules.ts";

const compile = (rules: PathRule[]) => compileRules(rules);

describe("matchRule + compileRules", () => {
  it("matches an exact path", () => {
    const r = compile([{ path: "/health", ttl: 30 }]);
    expect(matchRule(r, "/health")?.ttl).toBe(30);
    expect(matchRule(r, "/health/")).toBeNull();
    expect(matchRule(r, "/somewhere")).toBeNull();
  });

  it("matches a prefix glob, including the bare prefix", () => {
    const r = compile([{ path: "/api/*", ttl: 60 }]);
    expect(matchRule(r, "/api")?.ttl).toBe(60);
    expect(matchRule(r, "/api/")?.ttl).toBe(60);
    expect(matchRule(r, "/api/posts/5")?.ttl).toBe(60);
  });

  it("does NOT match a prefix that isn't really a parent path", () => {
    const r = compile([{ path: "/api/*", ttl: 60 }]);
    expect(matchRule(r, "/apifoo")).toBeNull();
    expect(matchRule(r, "/health")).toBeNull();
  });

  it("the catch-all `/*` matches everything", () => {
    const r = compile([{ path: "/*", ttl: 3600 }]);
    expect(matchRule(r, "/")?.ttl).toBe(3600);
    expect(matchRule(r, "/anything")?.ttl).toBe(3600);
    expect(matchRule(r, "/deeply/nested/path")?.ttl).toBe(3600);
  });

  it("the most specific prefix wins", () => {
    const r = compile([
      { path: "/api/*", ttl: 60 },
      { path: "/api/v1/*", ttl: 10 },
      { path: "/*", ttl: 3600 },
    ]);
    expect(matchRule(r, "/api/v1/posts")?.ttl).toBe(10);
    expect(matchRule(r, "/api/v2/posts")?.ttl).toBe(60);
    expect(matchRule(r, "/health")?.ttl).toBe(3600);
  });

  it("an exact match beats any prefix that would also match", () => {
    const r = compile([
      { path: "/*", ttl: 3600 },
      { path: "/api/*", ttl: 60 },
      { path: "/api/health", ttl: 5 },
    ]);
    expect(matchRule(r, "/api/health")?.ttl).toBe(5);
    expect(matchRule(r, "/api/posts")?.ttl).toBe(60);
  });

  it("returns null when nothing matches and there is no catch-all", () => {
    const r = compile([{ path: "/api/*", ttl: 60 }]);
    expect(matchRule(r, "/health")).toBeNull();
  });

  it("empty rules return null for everything", () => {
    expect(matchRule(compile([]), "/anything")).toBeNull();
  });

  it("input order doesn't affect the outcome (compile sorts by specificity)", () => {
    const a = compile([
      { path: "/*", ttl: 3600 },
      { path: "/api/v1/*", ttl: 10 },
      { path: "/api/*", ttl: 60 },
    ]);
    const b = compile([
      { path: "/api/v1/*", ttl: 10 },
      { path: "/*", ttl: 3600 },
      { path: "/api/*", ttl: 60 },
    ]);
    for (const p of ["/api/v1/x", "/api/x", "/other"]) {
      expect(matchRule(a, p)?.ttl).toBe(matchRule(b, p)?.ttl);
    }
  });

  it("does not mutate the input rules array", () => {
    const input: PathRule[] = [
      { path: "/api/*", ttl: 60 },
      { path: "/*", ttl: 3600 },
    ];
    const clone = input.map((r) => ({ ...r }));
    compile(input);
    expect(input).toEqual(clone);
  });
});
