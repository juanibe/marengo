# Marengo

> A self-hosted HTTP cache & mini-CDN — a thoughtful caching reverse proxy for your homelab.

[![ci](https://github.com/juanibe/marengo/actions/workflows/ci.yml/badge.svg)](https://github.com/juanibe/marengo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> **Status: early development — v0.1 in progress.** Not yet usable. Track the [v0.1 milestone](https://github.com/juanibe/marengo/milestone/1).

Marengo sits in front of your self-hosted services and caches responses intelligently, so your origin does less work. You point it at your origin, put it in front of your traffic, and it serves what it can from cache.

- **Single binary, single YAML config.** Runs in Docker on a \$5 VPS.
- **Correct HTTP caching (RFC 9111):** cache-key derivation, `Vary`, `Cache-Control` semantics, per-path TTLs.
- **Production observability:** Prometheus metrics, structured JSON logs, health endpoint.
- **No third party in front of your traffic.** Keep the privacy benefits of self-hosting.

Named after Napoleon's warhorse — the steady mount that carries the load.

## Development

Requires **Node 24+** (the project runs TypeScript directly via Node's native type stripping).

```bash
nvm use            # picks up .nvmrc (Node 24)
npm install
npm run dev        # boots a stub server on http://localhost:8080
npm test
```

Useful scripts: `npm run lint` (Biome), `npm run typecheck` (tsc), `npm run build` (tsup bundle).

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint); releases are automated with [release-please](https://github.com/googleapis/release-please).

## Roadmap

- [v0.1 — MVP](https://github.com/juanibe/marengo/milestone/1): reverse proxy, in-memory LRU cache, RFC 9111 `Cache-Control`, `Vary`, admin + metrics, Docker, README.
- [v0.2 — Resilience & scale](https://github.com/juanibe/marengo/milestone/2): stale-while-revalidate, request coalescing, disk tier, surrogate-key purging, compression, conditional revalidation, TLS, admin UI.

## License

[MIT](./LICENSE)
