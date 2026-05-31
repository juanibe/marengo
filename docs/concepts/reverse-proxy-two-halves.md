---
title: "Reverse proxy: the two halves"
description: "What a reverse proxy actually is — an HTTP server plus an HTTP client — and the design choices that make it correct and efficient: streaming, connection pooling, and routing by Host."
---

# Reverse proxy: the two halves

`src/server.ts` is about 20 lines and `src/proxy.ts` is about 150. Most of what makes them correct and efficient is a small set of design choices worth understanding.

## A reverse proxy is a server *and* a client

A reverse proxy speaks HTTP on both sides:

```text
client ──HTTP──> [ inbound: node:http ]  →  [ outbound: undici Pool ]  ──HTTP──> origin
                                                                                    │
client <─────── pipe response body straight through ─────────────────── undici ←────┘
```

- The **inbound** half is a normal HTTP server (`node:http`). It listens, parses requests, exposes `req.headers` / `req.url` / `req.method` / `req.socket`.
- The **outbound** half is an HTTP client (`undici`). It opens a connection to the origin, sends the request we built from the inbound side, and gives us back the response.

Most of the proxy's job is **translation** between those two halves: read what came in, decide what to send out, then pipe the response back.

## Stream — don't buffer

A naïve proxy reads the entire request body into memory, then sends it to the origin, then reads the entire origin response into memory, then writes it back. That breaks for two reasons:

- **Memory.** A 100 MB upload would sit in RAM. Multiply by concurrent requests and you OOM.
- **Latency.** Nothing reaches the origin until the client finishes uploading; nothing reaches the client until the origin finishes responding. Time-to-first-byte goes up dramatically.

We pass `req` (a `Readable`) directly as the body to undici, and pipe `upstream.body` (also a `Readable`) directly to `res`. Bytes pass through without ever being whole-buffered in our memory.

## One connection pool per upstream

Opening a TCP connection (and a TLS handshake, when applicable) costs tens of milliseconds. Doing it on every request is wasteful.

`undici`'s `Pool` keeps a small set of persistent connections to one origin and reuses them across requests. We cache one `Pool` per upstream URL in a module-level `Map`:

```ts
const pools = new Map<string, Pool>();
function getPool(upstream: string): Pool { /* ... */ }
```

**Per-upstream** pooling is the right granularity: two origins are entirely separate destinations, you can't share sockets between them. A single global pool would serialise across origins; one pool per upstream lets them run independently.

## Routing by `Host`

Marengo can sit in front of *many* origins — `blog.example.com`, `api.example.com`, `assets.example.com`, each pointing at a different upstream.

We pick the right one by matching the request's `Host` header against `config.origins[].host`:

```ts
const host = hostHeader.split(":")[0]?.toLowerCase();
return config.origins.find((o) => o.host.toLowerCase() === host);
```

We strip a possible `:port` suffix (`Host: blog.example.com:8080`) and lowercase both sides — host names are case-insensitive.

If nothing matches, we return **`421 Misdirected Request`** — the correct status for "this request reached the wrong server for its Host." Better than a generic 404 because it tells the client (and any intermediary) that the request itself isn't malformed; it just doesn't belong on this proxy.

## Error handling: 502 for the unexpected

If anything goes wrong while talking to the origin (DNS failure, connection refused, origin crashes mid-response, etc.), the proxy returns **`502 Bad Gateway`** — the standard "I'm a gateway and my upstream failed me" status. `src/server.ts` catches any unhandled error from `proxyToOrigin` and surfaces it as 502.

## See also

- [Hop-by-hop vs end-to-end headers](./hop-by-hop-headers.md) — the header surgery that's the other half of being a correct proxy.
