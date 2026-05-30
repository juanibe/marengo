# Marengo docs

Internal docs that explain the *why* behind the code — design decisions, data-structure choices, and notes worked out during the build.

These live next to the source so they don't drift. The public docs site (planned: Astro Starlight, served through Marengo itself) will pull from this directory.

## Concepts

Design and HTTP-flavoured concepts as they show up in Marengo's code.

### Cache

- [LRU cache: the data structure](./concepts/lru-cache-data-structure.md) — why `MemoryStore` is a hash map with a linked-list overlay, not a queue.
- [Cache eviction: when and who](./concepts/cache-eviction.md) — the byte budget vs the replacement policy.

### Proxy

- [Reverse proxy: the two halves](./concepts/reverse-proxy-two-halves.md) — server + client, streaming, connection pooling, routing by Host.
- [Hop-by-hop vs end-to-end headers](./concepts/hop-by-hop-headers.md) — the RFC distinction, the `Connection` header's superpower, and `Via` / `X-Forwarded-*`.
