# axon-gateway

Plane 3 of [Axon](https://github.com/gowthamsai09/Axon): a Cloudflare Worker (TypeScript, Hono) that serves
**A2A** and **MCP** over one core. Spec: sections 4.3, 7, 8, 9. Local run: [docs/local-run.md](docs/local-run.md).

**Phase 5 status (hardening, nothing deployed):** a `deploy.yml` workflow (after CI on `main`, environment `production` with
a required reviewer, `scripts/check-deploy-config.js` refuses placeholder URLs, a bad KV id, override variables and enabled
observability; Cloudflare secrets only in the deploy step), a `wrangler deploy --dry-run` step in CI, the shared injection
corpus and SSRF cases from the hub, a byte check of the summarizer prompt against the hub (`npm run prompt:hub -- ..\Axon`),
and `FEED_BASE` / `PUBLIC_URL` as IP literals refused. Procedures: `docs/npm-audit.md` and `docs/repo-hardening.md` in the hub.

**Phase 4 status (Tier 3 done against mocks, nothing deployed):** `/register`, `/tokens`, `/tokens/:id` (GitHub OIDC), the
`run_personal_digest` skill, real `tasks/get` and `tasks/cancel`, and the MCP tools `start_digest` and `get_digest_status` exist
and appear **only when** `TOKENS`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are configured. Otherwise the Phase 3 surface
(including the stable 501s) is served unchanged. Setup: [docs/github-app-setup.md](docs/github-app-setup.md). Local mock run:
[docs/local-run-tier3.md](docs/local-run-tier3.md).

**Phase 3 status (Tier 1 and 2):**

| Route | What it does |
|---|---|
| `GET /.well-known/agent-card.json` | A2A Agent Card (protocol 0.3.0), skills `get_ai_updates` and `summarize_ai_updates` |
| `POST /a2a` | A2A JSON-RPC: `message/send` (both skills); `tasks/get`, `tasks/cancel` answer TaskNotFound (Tier 1 and 2 finish inside `message/send`) |
| `POST /mcp` | MCP Streamable HTTP, stateless: revision 2026-07-28 (`server/discover`, `tools/list`, `tools/call`) and, for older clients, 2025-11-25 (`initialize`, no session id). Tools `get_ai_updates`, `summarize_items` |
| `GET /healthz` | `ok` |
| `POST /register`, `POST /tokens`, `DELETE /tokens/:id` | OIDC-authenticated (Tier 3 configured), otherwise a stable `501` |

Tier 1 needs no key. Tier 2 summarizes with **your** key, sent in the `X-LLM-Provider` (`deepseek` or
`huggingface`), `X-LLM-Key` and optional `X-LLM-Model` headers. The key is used in memory for one request;
it is never stored, cached, logged or returned. Tier 3 (the personal digest) arrives in Phase 4 and is not advertised.

```bash
npm ci
npm run lint && npm run typecheck && npm test
npm run prompt:check          # generated prompt module is current
npm run bench                 # prints Tier 1 timings (Node, not workerd)
```

Contract tests read the hub's JSON Schemas from `../Axon/schemas` (override with `HUB_SCHEMAS_DIR`; set
`REQUIRE_HUB_SCHEMAS=1` to fail instead of skip when missing).

## The summarizer prompt must match the template

`prompts/summarizer_system.txt` is a byte-identical copy of the template's `digest/prompts/summarizer_system.txt`
(spec 4.4). `src/prompts/summarizer.generated.ts` is generated from it (`npm run prompt:generate`) so the Worker
bundle does not depend on text-file loaders. Its id is `p-` plus the first 10 hex characters of the sha256 and is
pinned in `test/prompt.test.ts`. After any change in either repo, compare the two copies:

```powershell
npm run prompt:compare -- ..\axon-template\digest\prompts\summarizer_system.txt
```
