---
title: "Hop-by-hop vs end-to-end headers"
description: "Why a proxy must rewrite some headers and pass others through unchanged — the RFC 9110 distinction every homemade proxy gets wrong, plus the `Connection` header's quiet superpower."
---

# Hop-by-hop vs end-to-end headers

HTTP headers come in **two kinds**, and a proxy has to treat them differently. This is the single thing most homemade proxies get wrong, and it's the reason `src/proxy.ts` does header surgery.

(RFC 9110 §7.6.1, RFC 7230 §6.1 in the older spec.)

## Two kinds of headers

- **End-to-end headers** are meant for the actual sender or actual receiver. A proxy passes them through unchanged.
  Examples: `Content-Type`, `Content-Length`, `ETag`, `Last-Modified`, `Cache-Control`, `Vary`, `Authorization`.
  These are meant to survive every hop of the network — that's the point.

- **Hop-by-hop headers** are meaningful only for *this* TCP connection. A proxy must **drop them on every hop**, in both directions, because their meaning doesn't carry across hops.
  Examples: `Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`.
  These describe the *connection*, not the message. The TCP connection between client→proxy is a different connection from proxy→origin.

If a proxy forwarded `Transfer-Encoding: chunked` blindly, the recipient might double-process the body framing. If it forwarded `Connection: close`, it would close the wrong connection. The whole reason to drop them is "these don't apply to the next hop."

## The standard hop-by-hop set

Eight names are universally hop-by-hop:

```
Connection · Keep-Alive · Proxy-Authenticate · Proxy-Authorization
TE · Trailer · Transfer-Encoding · Upgrade
```

Our code keeps them in a `Set` and filters them out of both the forwarded request and the returned response:

```ts
const HOP_BY_HOP = new Set([
  "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);
```

## The `Connection` header's quiet superpower

This is the trick most homemade proxies miss:

The `Connection` header itself can **name additional headers** that should also be treated as hop-by-hop *for that hop*:

```
Connection: close, X-Custom-Auth, X-Trace-Id
```

That sentence says: *"treat `X-Custom-Auth` and `X-Trace-Id` as hop-by-hop here too."* The proxy must strip them along with the standard set, on *this* hop only:

```ts
const extra = new Set<string>();
const connection = headers["connection"];
if (typeof connection === "string") {
  for (const name of connection.split(",")) extra.add(name.trim().toLowerCase());
}
// ...later, when filtering:
if (HOP_BY_HOP.has(lower) || extra.has(lower)) continue;
```

Skipping this is how secrets in custom hop-by-hop headers end up forwarded to the origin — a real-world security bug class.

## Adding the trail: `Via` and `X-Forwarded-*`

After *dropping* the hop-by-hop headers, the proxy **adds** a small trail so the origin (and any downstream tools) know what really happened upstream:

- **`Via: 1.1 marengo`** — RFC-defined, appended on every hop. A request that passed through Cloudflare and then Marengo carries `Via: 1.1 cloudflare, 1.1 marengo`. The origin sees the chain.

- **`X-Forwarded-For: <client-ip>`** — de-facto standard (RFC 7239 defines the modern `Forwarded:` header, but `X-Forwarded-*` is universally understood). Appended each hop so the origin knows the original client IP, even though *we're* the TCP peer it's talking to.

- **`X-Forwarded-Host: <original-host>`** — what the client put in `Host`, in case the proxy is using a different upstream URL.

- **`X-Forwarded-Proto: http`** — the scheme. Marengo is plain HTTP in v0.1; when a TLS terminator like Nginx fronts us, *it* sets `X-Forwarded-Proto: https` and we leave it alone.

We only set these when not already present — never overwrite what an upstream proxy may have filled in. Otherwise the chain breaks.

## Why this matters

Without correct hop-by-hop handling, three bug classes turn up in production:

1. **Header re-processing.** `Transfer-Encoding: chunked` forwarded means the recipient may try to dechunk twice, or disagree with the sender about content boundaries.
2. **Privacy / security leaks.** Headers the client expected to be local to the first hop (custom auth, trace IDs in `Connection`-listed extension hop-by-hop) get forwarded to the origin.
3. **Connection lifecycle bugs.** `Connection: close` flowing through can prematurely terminate connections that were meant to stay alive.

That's why `stripHopByHop` is its own pure function with its own unit tests in `tests/proxy/headers.test.ts` — it's the kind of thing you want to *prove* is correct, not eyeball.

## See also

- [Reverse proxy: the two halves](./reverse-proxy-two-halves.md) — the inbound + outbound architecture that calls this header surgery.
