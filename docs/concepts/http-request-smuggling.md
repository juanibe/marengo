---
title: "HTTP request smuggling: the real-world cost of hop-by-hop confusion"
description: "How disagreements between two HTTP parsers about body framing become a smuggled request — and what hop-by-hop discipline does to defend against it."
---

# HTTP request smuggling

The [hop-by-hop rules](./hop-by-hop-headers.md) are not academic — they are the entire reason a real-world attack class called **HTTP request smuggling** works, and the reason most homemade proxies are dangerous. This doc walks through the canonical case so the rules feel concrete, and shows what in `src/proxy.ts` defends against it.

## The setup: two ways to say "where does the body end?"

Any HTTP parser needs to know where one request ends and the next begins on a kept-alive TCP connection. HTTP gives it **two** mechanisms — both hop-by-hop / connection-level:

- **`Content-Length: 42`** — the body is exactly 42 bytes.
- **`Transfer-Encoding: chunked`** — the body comes in length-prefixed chunks, terminated by `0\r\n\r\n`.

RFC 9112 says: if both are present, **use `Transfer-Encoding` and ignore `Content-Length`.** In practice, different parsers disagree — some look at `Content-Length` first, some get confused by oddly-formatted values like `Transfer-Encoding:[tab]chunked` or `Transfer-Encoding: xchunked`. **That disagreement is the vulnerability.**

## The attack (TE.CL desync)

Imagine a front-end proxy that prefers `Transfer-Encoding`, sitting in front of a back-end origin that prefers `Content-Length`. An attacker sends *one* HTTP request to the proxy:

```http
POST / HTTP/1.1
Host: target.example
Content-Length: 4
Transfer-Encoding: chunked

7c
GPOST /admin/delete-user?id=42 HTTP/1.1
Host: target.example
X-Smuggled: yes
...lots more bytes...
0

```

**The proxy** (prefers `Transfer-Encoding`) reads `7c` = 124 bytes of body, consumes 124 bytes (which include the entire `GPOST...` prefix), sees the terminating `0\r\n\r\n`, and concludes the request is well-formed. It forwards everything to the origin over a kept-alive TCP connection.

**The origin** (prefers `Content-Length`) consumes only 4 bytes of body (`7c\r\n`) and considers the request over. **The remaining bytes — `GPOST /admin/delete-user...` — look like the next request on the same keep-alive connection.**

The proxy has framed one request; the origin has seen two. Whoever sends the *next* legitimate request on that pooled connection has their request **appended** to the smuggled prefix.

## What attackers do with that desync

1. **Hijack the next user's request.** Their session cookie ends up attached to the smuggled `GPOST /admin/...` — the origin sees the attacker's URL with the victim's authentication headers.
2. **Poison the cache.** The smuggled request can ask for `/`, get an attacker-controlled response, and the proxy's cache stores it under the cache key for `/`. Every subsequent visitor gets the attacker's payload.
3. **Bypass front-end security.** The WAF / rate limiter / auth check only sees the outer (innocent-looking) request; the smuggled inner request never goes through it.

This was the basis of James Kettle's *"HTTP Desync Attacks: Request Smuggling Reborn"* research at PortSwigger (2019), and the variations that followed. Bug bounties in the tens of thousands of dollars range were paid by PayPal, GitHub, Slack, and many others.

## The `Connection`-header variant

A close cousin uses `Connection`'s "extension hop-by-hop" power to make a proxy strip a security-critical header:

```http
GET /api/admin HTTP/1.1
Host: target.example
Authorization: Bearer some-token
Connection: keep-alive, Authorization
```

A naive proxy reads `Connection: ..., Authorization` as *"treat `Authorization` as hop-by-hop here"*, strips it, and forwards a now-unauthenticated request to the origin. If the origin's permission model assumes *"no `Authorization` means public endpoint,"* the attacker just bypassed auth.

This is the exact bug class `stripHopByHop` in `src/proxy.ts` is built to handle — it only strips Connection-listed headers *on this hop*, exactly as intended, and the test **`strips Connection-listed extension hop-by-hop headers`** in `tests/proxy/headers.test.ts` is a security regression guard for that behaviour.

## How Marengo's hop-by-hop discipline defends

Three things in `proxy.ts` together kill these classes of bugs:

1. **Drop `Transfer-Encoding` on every hop.** It's in the `HOP_BY_HOP` set. `undici` and `node:http` reframe the body themselves between the two TCP hops, so the origin only sees framing *we* computed. A CL/TE disagreement is impossible because each hop's parsers see at most one framing header — the rest are stripped before they leave us.
2. **Strip `Connection`-listed names carefully** — we drop what the *current* hop's `Connection` header lists, on this hop only, and never overwrite end-to-end headers like `Authorization` that the client genuinely sent through.
3. **The `Via` header trail** makes the chain visible to the origin — useful for forensics when something does go wrong.

The hop-by-hop rules look like trivia from RFC 9110 §7.6.1 — but every line of `stripHopByHop` is a defence against a class of attack that has paid out millions in bug bounties.

## See also

- [Hop-by-hop vs end-to-end headers](./hop-by-hop-headers.md) — the RFC rules this attack abuses.
- [Reverse proxy: the two halves](./reverse-proxy-two-halves.md) — the inbound + outbound architecture that owns this header surgery.
