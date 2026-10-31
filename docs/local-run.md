# Run the gateway locally (Windows, PowerShell)

Nothing here needs a Cloudflare login. Three terminals.

## 0. Checks
```powershell
cd C:\Users\DGY3KOR\Desktop\Axon\axon-gateway
npm ci
npm run typecheck; npm run lint; npm test
npm run prompt:check
npm run prompt:compare -- ..\axon-template\digest\prompts\summarizer_system.txt
```
Behind the proxy: `npm config set proxy ...`, `npm config set https-proxy ...`, `$env:NODE_EXTRA_CA_CERTS = "<corporate CA bundle>"`.
`wrangler dev` prints `Unable to fetch the Request.cf object ... ENOTFOUND workers.cloudflare.com`. That warning is
harmless: it only means Cloudflare is unreachable, the Worker still runs.

## 1. Terminal 1: serve the real feed like GitHub Pages
```powershell
cd C:\Users\DGY3KOR\Desktop\Axon\Axon\feed-out
python -m http.server 8788
```

## 2. Terminal 2: run the Worker
```powershell
cd C:\Users\DGY3KOR\Desktop\Axon\axon-gateway
npx wrangler dev --var FEED_BASE:http://localhost:8788 --var PUBLIC_URL:http://localhost:8787
```
(or copy `.dev.vars.example` to `.dev.vars`, which is git-ignored). Rate limit bindings are emulated locally.

## 3. Terminal 3: smoke tests
If the corporate proxy intercepts `localhost`, bypass it for this session first:
```powershell
[System.Net.WebRequest]::DefaultWebProxy = $null
$B = "http://localhost:8787"
```

**Agent Card and health**
```powershell
Invoke-RestMethod "$B/.well-known/agent-card.json" | Select-Object protocolVersion, url, @{n="skills";e={$_.skills.id}}
Invoke-RestMethod "$B/healthz"
```

**A2A, Tier 1 (no key)**
```powershell
$body = @{ jsonrpc="2.0"; id="1"; method="message/send"; params=@{ message=@{ role="user"; messageId="m1"; parts=@(@{ kind="data"; data=@{ skill="get_ai_updates"; topics=@("agents-tooling"); limit=5 } }) } } } | ConvertTo-Json -Depth 10
$r = Invoke-RestMethod -Method Post -Uri "$B/a2a" -ContentType "application/json" -Body $body
$r.result.status.state
$r.result.artifacts[0].parts[0].data.items | Select-Object id, title, score | Format-Table -AutoSize
$r.result.artifacts[0].parts[0].data | Select-Object count, feed_generated_at, feed_stale, fallback
$id = $r.result.artifacts[0].parts[0].data.items[0].id
```

**MCP: discover, list, call** (revision 2026-07-28, no handshake)
```powershell
$h = @{ "MCP-Protocol-Version"="2026-07-28"; "Mcp-Method"="tools/list" }
$list = @{ jsonrpc="2.0"; id=1; method="tools/list"; params=@{ _meta=@{ "io.modelcontextprotocol/protocolVersion"="2026-07-28" } } } | ConvertTo-Json -Depth 10
(Invoke-RestMethod -Method Post -Uri "$B/mcp" -ContentType "application/json" -Headers $h -Body $list).result.tools.name

$disc = @{ jsonrpc="2.0"; id=1; method="server/discover" } | ConvertTo-Json
(Invoke-RestMethod -Method Post -Uri "$B/mcp" -ContentType "application/json" -Body $disc).result | Select-Object supportedVersions, @{n="server";e={$_.serverInfo.name}}

$h = @{ "MCP-Protocol-Version"="2026-07-28"; "Mcp-Method"="tools/call"; "Mcp-Name"="get_ai_updates" }
$call = @{ jsonrpc="2.0"; id=2; method="tools/call"; params=@{ name="get_ai_updates"; arguments=@{ entities=@("llama-cpp") }; _meta=@{ "io.modelcontextprotocol/protocolVersion"="2026-07-28" } } } | ConvertTo-Json -Depth 10
(Invoke-RestMethod -Method Post -Uri "$B/mcp" -ContentType "application/json" -Headers $h -Body $call).result.structuredContent.items | Select-Object id, title
```
Older MCP clients: send `initialize` instead (answers revision 2025-11-25, never issues a session id).

**Tier 2 (uses YOUR key; real LLM call, costs a little)**. Use a dedicated key with a spending limit.
```powershell
$env:LLM_API_KEY = Read-Host "LLM key"        # session only, never put it in a file
$h = @{ "X-LLM-Provider"="deepseek"; "X-LLM-Key"=$env:LLM_API_KEY }   # optional: "X-LLM-Model"="deepseek-v4-flash"
$body = @{ jsonrpc="2.0"; id="2"; method="message/send"; params=@{ message=@{ role="user"; messageId="m2"; parts=@(@{ kind="data"; data=@{ skill="summarize_ai_updates"; item_ids=@($id); depth="brief"; language="en" } }) } } } | ConvertTo-Json -Depth 10
$r = Invoke-RestMethod -Method Post -Uri "$B/a2a" -ContentType "application/json" -Headers $h -Body $body
$r.result.status.state
$r.result.artifacts[0].parts[0].data.results | ConvertTo-Json -Depth 6
$r.result.artifacts[0].parts[0].data | Select-Object provider, model, prompt_version, usage
```
For Hugging Face use `"X-LLM-Provider"="huggingface"` with your HF token. Expected failure shapes: no key gives an
`input-required` task, a wrong key a `failed` task with `llm_key_invalid`, no balance `llm_quota`.

**Things that must be refused** (all should fail cleanly)
```powershell
# wrong method / content type / body key
try { Invoke-RestMethod "$B/a2a" } catch { $_.Exception.Response.StatusCode.value__ }        # 405
try { Invoke-RestMethod -Method Post "$B/a2a" -ContentType "text/plain" -Body "x" } catch { $_.Exception.Response.StatusCode.value__ }   # 415
$bad = @{ jsonrpc="2.0"; id="3"; method="message/send"; params=@{ message=@{ role="user"; parts=@(@{ kind="data"; data=@{ skill="summarize_ai_updates"; item_ids=@($id); api_key="sk-not-a-real-key-123456" } }) } } } | ConvertTo-Json -Depth 10
(Invoke-RestMethod -Method Post -Uri "$B/a2a" -ContentType "application/json" -Body $bad).result.status.state   # rejected
```

## Using your own feed from a published URL instead
`--var FEED_BASE:https://<org>.github.io/axon-feed/feed` (https is required; plain http is accepted for localhost only).
