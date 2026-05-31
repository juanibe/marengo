/**
 * Per-path TTL rules (#8).
 *
 * Each origin in the config carries an ordered list of rules:
 *   - exact path:    "/health" -> 30s
 *   - prefix glob:   "/api/*"  -> 60s   (trailing `/*` matches anything after)
 *
 * For each incoming request the pipeline picks the most-specific matching
 * rule and uses its TTL as the freshness fallback when the origin gave no
 * `Cache-Control` directive (the wiring lives in #12).
 *
 * "Most specific" means: exact matches always beat any prefix match; among
 * prefix matches, the longest prefix wins; the bare `/*` is the catch-all.
 *
 * We pre-sort rules at compile time so a request lookup is a linear scan in
 * already-correct order — no per-request sorting, no regex.
 */

export interface PathRule {
  /** Pattern: an exact path, or a trailing-`/*` prefix glob. */
  path: string;
  /** TTL in seconds. */
  ttl: number;
}

export interface CompiledRule extends PathRule {
  /** Returns true if this rule matches the given request path. */
  matches: (requestPath: string) => boolean;
}

const PREFIX_SUFFIX = "/*";
/** A bias large enough that any exact path outranks every prefix match. */
const EXACT_BIAS = 1_000_000;

function compileRule(rule: PathRule): CompiledRule {
  const { path, ttl } = rule;
  if (path.endsWith(PREFIX_SUFFIX)) {
    // "/api/*" -> matches "/api", "/api/", and anything beneath "/api/".
    const base = path.slice(0, -PREFIX_SUFFIX.length); // "/api"
    const baseWithSlash = `${base}/`; // "/api/"
    return {
      path,
      ttl,
      matches: (p) => p === base || p === baseWithSlash || p.startsWith(baseWithSlash),
    };
  }
  return { path, ttl, matches: (p) => p === path };
}

/** Specificity score; higher is more specific. */
function specificity(rule: PathRule): number {
  if (rule.path.endsWith(PREFIX_SUFFIX)) {
    return rule.path.length - PREFIX_SUFFIX.length;
  }
  return rule.path.length + EXACT_BIAS;
}

/**
 * Compile and sort a list of rules. The returned array is in
 * most-specific-first order, so {@link matchRule} can pick the first match.
 * Does not mutate the input.
 */
export function compileRules(rules: readonly PathRule[]): CompiledRule[] {
  return rules
    .slice()
    .sort((a, b) => specificity(b) - specificity(a))
    .map(compileRule);
}

/** First match wins (the array is already sorted by specificity). */
export function matchRule(
  compiled: readonly CompiledRule[],
  requestPath: string,
): CompiledRule | null {
  for (const rule of compiled) {
    if (rule.matches(requestPath)) return rule;
  }
  return null;
}
