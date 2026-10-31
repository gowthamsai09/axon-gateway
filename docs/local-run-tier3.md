# Tier 3 local run (mock GitHub) — merge into docs/local-run.md

Everything here runs on your laptop with a **mock GitHub** (`scripts/mock-github.js`). No GitHub, Cloudflare or LLM
access is needed. The mock is not GitHub: it only proves the gateway's flow. Needs Node 22 and `npm ci` done.

## Terminal 1: setup and mock
```powershell
cd ..\axon-gateway
node scripts/dev-setup.js        # writes .dev.vars (ENVIRONMENT=development, a fresh App key) and .mock-github.json
node scripts/mock-github.js      # leave running; prints each request it receives
```
## Terminal 2: the Worker
```powershell
cd ..\axon-gateway
npx wrangler dev --local --port 8787
```
(`Unable to fetch the Request.cf object` is harmless. If your proxy intercepts localhost, run
`[System.Net.WebRequest]::DefaultWebProxy = $null` in terminal 3 first.)

## Terminal 3: the flow
```powershell
cd ..\axon-gateway
$g = "http://localhost:8787"
function T($wf) { node scripts/mint-oidc.js $wf }

# 1 card now lists run_personal_digest and ownerBearer
(Invoke-RestMethod "$g/.well-known/agent-card.json").skills.id

# 2 register, 3 issue a token (shown once)
Invoke-RestMethod -Method Post "$g/register" -Headers @{Authorization="Bearer $(T register.yml)"} -ContentType "application/json" -Body "{}"
$r = Invoke-RestMethod -Method Post "$g/tokens" -Headers @{Authorization="Bearer $(T issue-token.yml)"} -ContentType "application/json" -Body '{"label":"smoke","expires_in_days":7}'
$tok = $r.token; $tid = $r.id; $h = @{Authorization="Bearer $tok"}

# 4 start (A2A) and poll
$msg = '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"role":"user","messageId":"m1","parts":[{"kind":"data","data":{"skill":"run_personal_digest","max_items":5}}]}}}'
$s = Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $msg
$id = $s.result.id; $s.result.status.state                       # submitted
$get = "{`"jsonrpc`":`"2.0`",`"id`":`"2`",`"method`":`"tasks/get`",`"params`":{`"id`":`"$id`"}}"
(Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $get).result.status.state
Invoke-RestMethod -Method Post "http://127.0.0.1:8790/__mock/advance" | Out-Null   # queued -> working
(Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $get).result.status.state   # working
Invoke-RestMethod -Method Post "http://127.0.0.1:8790/__mock/advance" | Out-Null   # -> completed + result file
$done = Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $get
$done.result.status.state; $done.result.artifacts[0].parts[0].data.result.items

# 5 cancel (a second run, still queued)
$s2 = Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $msg
$can = "{`"jsonrpc`":`"2.0`",`"id`":`"3`",`"method`":`"tasks/cancel`",`"params`":{`"id`":`"$($s2.result.id)`"}}"
(Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $can).result.status.state   # canceled

# 6 MCP: no token is HTTP 401; with the token it starts a run
try { Invoke-RestMethod -Method Post "$g/mcp" -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_digest","arguments":{}}}' } catch { $_.Exception.Response.StatusCode.value__ }
(Invoke-RestMethod -Method Post "$g/mcp" -Headers $h -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_digest","arguments":{"max_items":2}}}').result.structuredContent

# 7 revoke, then the token is refused
Invoke-RestMethod -Method Delete "$g/tokens/$tid" -Headers @{Authorization="Bearer $(T revoke-token.yml)"}
(Invoke-RestMethod -Method Post "$g/a2a" -Headers $h -ContentType "application/json" -Body $msg).result.status.state   # auth-required
```
Expected: `submitted`, `submitted`, `working`, `completed` with one item, `canceled`, `401`, `submitted`, `{revoked: true}`, `auth-required`.
Mock call log: `Invoke-RestMethod http://127.0.0.1:8790/__mock/calls`. The Worker log (terminal 2) must never contain the token.
