# GitHub App and Tier 3 setup (first push) — NOT RUN

Nothing below has been executed: it needs a real GitHub account and a Cloudflare account. Everything in Phase 4 was
verified only against mocks (see `docs/local-run-tier3.md`). Do these steps at the first push, after the hub,
`axon-feed` and `axon-template` are on GitHub and the Worker has a real `workers.dev` URL.

## 1. Create the GitHub App (once, on your account)
GitHub > Settings > Developer settings > GitHub Apps > New GitHub App.
- Name: anything unique (for example `axon-gateway-<yourname>`). Homepage URL: the hub repo URL.
- **Webhook: untick "Active"** (not used).
- Repository permissions: **Actions: Read and write**, **Contents: Read-only**, **Metadata: Read-only**. Nothing else.
  (Contents is read-only on purpose: the App can start workflows and read results, but cannot push code.)
- Where can this App be installed: **Only on this account**.
- Create it, then note the **App ID** (a number). Under "Private keys" choose **Generate a private key**: a `.pem`
  downloads. It is in PKCS#1 form (`BEGIN RSA PRIVATE KEY`); the gateway accepts that form and PKCS#8, no `openssl` needed.
- **Install App** > your account > **Only select repositories** > pick your private digest repo (the one created from `axon-template`).

## 2. Cloudflare
```powershell
cd axon-gateway
npx wrangler kv namespace create TOKENS        # prints an id: put it in wrangler.toml ([[kv_namespaces]] id)
# wrangler.toml: set GITHUB_APP_ID = "<the App ID>" and PUBLIC_URL = "https://axon-gateway.<account>.workers.dev"
Get-Content -Raw C:\path\to\app-private-key.pem | npx wrangler secret put GITHUB_APP_PRIVATE_KEY
npx wrangler deploy
```
Tier 3 appears only when `TOKENS`, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are all present. Do NOT set `ENVIRONMENT`
or any `GITHUB_*_BASE/ISSUER/JWKS` variable in production: they are ignored unless `ENVIRONMENT=development`, and are
for the local mock only. Keep `[observability] enabled = false`. Delete the downloaded `.pem` from Downloads when done.
Check: `Invoke-RestMethod https://<your worker>/.well-known/agent-card.json` lists `run_personal_digest` and `ownerBearer`.

## 3. Your digest repo (created from the template, private)
- Settings > Secrets and variables > Actions > **Variables**: `GATEWAY_URL` = the gateway URL **exactly** as `PUBLIC_URL`
  (it becomes the OIDC audience; no trailing slash needed, one is stripped).
- `digest.yml` must exist on the default branch (it does in the template) and `profile.yaml` should contain your `agent_access` block.
- Actions > **register** > Run workflow. Expect "Registered <repo> as ag_...".
- Actions > **issue-token** > Run workflow (label, days). Open the run's **job summary**, copy the token (`axn_...`),
  then **delete the run**. It is shown once; only a hash is stored. If the summary shows `***` instead of the token
  (GitHub masks it), that is a known open risk (Appendix C 64): tell me and the workflow switches to an artifact.
- To revoke: Actions > **revoke-token** with the token id (`tk_...`) from the summary.

## 4. Use it
A2A: `message/send` with a data part `{"skill":"run_personal_digest","max_items":5}` and `Authorization: Bearer axn_...`,
then `tasks/get` with the returned task id. MCP: tools `start_digest` and `get_digest_status` with the same header.
Client config: `{"mcpServers":{"axon":{"url":"https://<worker>/mcp","headers":{"Authorization":"Bearer axn_..."}}}}`.

## 5. Real integration test (NOT RUN)
```powershell
$env:GATEWAY_URL = "https://<worker>"; $env:OWNER_TOKEN = Read-Host "owner token"
node scripts/integration-real.js
```
It starts a digest, polls until done (up to 10 minutes), prints state, item count and the number of GitHub-side calls it can
see, then starts and cancels a second run. It uses your Actions minutes and your LLM key (cost: one small digest).

## 6. What to measure and record (STATE)
Subrequests per start and per poll (expected 3 cold, 1 to 2 warm), CPU time per request, KV reads and writes per day,
latency from `message/send` to `completed`, whether the job summary shows the token, KV revoke propagation in practice.

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| `/register` 401 | `GATEWAY_URL` differs from `PUBLIC_URL`, or the workflow file name is not `register.yml` |
| `/register` 502 "not accessible" | App not installed on that repo, or wrong App ID or key |
| start returns `failed` "digest.yml could not be started" | `digest.yml` missing on the default branch, or workflow disabled |
| `auth-required` on a fresh token | Wrong header form (`Authorization: Bearer axn_...`), or token expired or revoked |
| `submitted` for a long time | Actions queue; the run list can lag a minute or two |
