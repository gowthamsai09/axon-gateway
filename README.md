# axon-gateway

[![ci](https://github.com/gowthamsai09/axon-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/gowthamsai09/axon-gateway/actions/workflows/ci.yml)

**Plane 3 of [Axon](https://github.com/gowthamsai09/Axon): the A2A and MCP gateway.** A Cloudflare Worker
(TypeScript, Hono, zod, jose) that lets other agents use Axon. Both protocols are thin adapters over one core.

![Axon overview](docs/img/overview.png)

- **Live:** `https://axon-gateway.gowthamsaiyadlapalli1234.workers.dev`
- **Agent Card:** `/.well-known/agent-card.json` (A2A 0.3.0)
- **How to call it:** [call-the-agent.md](https://github.com/gowthamsai09/Axon/blob/main/docs/call-the-agent.md)

## Routes

| Route | What |
|---|---|
| `GET /.well-known/agent-card.json` | Agent Card: skills `get_ai_updates`, `summarize_ai_updates`, and `run_personal_digest` when Tier 3 is on |
| `POST /a2a` | A2A JSON-RPC: `message/send`, `tasks/get`, `tasks/cancel` |
| `POST /mcp` | MCP Streamable HTTP, stateless: revision 2026-07-28 and 2025-11-25. Tools `get_ai_updates`, `summarize_items`, and `start_digest`, `get_digest_status` (Tier 3) |
| `POST /register`, `POST /tokens`, `DELETE /tokens/:id` | Tier 3 identity via GitHub OIDC; a stable 501 when Tier 3 is off |
| `GET /healthz` | `ok` |

## Tiers

| Tier | Key | Result |
|---|---|---|
| 1 data | none | Ranked, deduplicated feed items by topic, entity and time |
| 2 summary | caller's, headers `X-LLM-Provider`, `X-LLM-Key`, optional `X-LLM-Model`; memory only, never stored, logged or returned | AI summaries of up to 10 items |
| 3 digest | owner bearer token `axn_...`; the key stays in the owner's repo | The owner's personal digest, run by their own Actions workflow through a GitHub App |

Everything returned is untrusted third-party content (`untrusted: true`). No CORS headers: agents call server to server.

## Develop

```powershell
npm ci
npm run lint; npm run typecheck; npm test
npm run prompt:check          # generated prompt equals the canonical one (p-56a22986b1)
npm run dev                   # local Worker (wrangler dev); see docs/local-run.md
```

Contract tests read the hub's schemas from `../Axon/schemas`. Override with `HUB_SCHEMAS_DIR`; set
`REQUIRE_HUB_SCHEMAS=1` to fail instead of skip when missing. Local Tier 3 against a mock GitHub:
[docs/local-run-tier3.md](docs/local-run-tier3.md).

## Deploy

`deploy.yml` runs after CI on `main`, in the GitHub environment `production` with a required reviewer.
`scripts/check-deploy-config.js` refuses placeholder URLs, a bad KV id, dev override variables and enabled
observability. Cloudflare credentials are secrets of that environment only. Keep `[observability] enabled = false`.
Steps: [docs/deploy.md](docs/deploy.md). Tier 3 setup (GitHub App, KV, secret): [docs/github-app-setup.md](docs/github-app-setup.md).
Tier 3 turns on only when the KV binding, a numeric `GITHUB_APP_ID` and the App private key (type **Secret**) all exist.

## Status

**Verified live:** deploy, `/healthz`, Agent Card, Tier 1 (A2A and MCP), Tier 2 with a real key, rate limiting,
Tier 3 over A2A (register, token, start, poll, cancel, revoke). **Not run:** Tier 3 over MCP, a third-party A2A
or MCP client, CPU p99 and per-request subrequest measurements. Tests: 992 passed (observed 2026-11-28).
Free-plan limits and the rest of the design: [ARCHITECTURE.md](ARCHITECTURE.md).

## Contributing, security, licence

[CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md). Apache-2.0, Copyright 2026 gowthamsai09.
