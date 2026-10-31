// REAL integration test for Tier 3: NOT RUN. Needs a deployed gateway, a registered repo and an owner token
// (docs/github-app-setup.md). Uses your Actions minutes and your LLM key (one small digest).
//   $env:GATEWAY_URL="https://<worker>"; $env:OWNER_TOKEN=Read-Host "owner token"; node scripts/integration-real.js
const base = (process.env.GATEWAY_URL ?? "").replace(/\/+$/, "");
const token = process.env.OWNER_TOKEN ?? "";
if (!/^https:\/\//.test(base) || !/^axn_[A-Za-z0-9_-]{43}$/.test(token)) {
  console.error("set GATEWAY_URL (https) and OWNER_TOKEN (axn_...)");
  process.exit(2);
}
const rpc = async (method, params, auth = true) => {
  const res = await fetch(`${base}/a2a`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }) });
  return { status: res.status, body: await res.json() };
};
const start = () => rpc("message/send", { message: { role: "user", messageId: "m1", parts: [{ kind: "data", data: { skill: "run_personal_digest", max_items: 3 } }] } });
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
if (!card.skills.some((s) => s.id === "run_personal_digest")) fail("card does not list run_personal_digest");
const noAuth = await rpc("tasks/get", { id: "00000000-0000-7000-8000-000000000000" }, false);
if (noAuth.status !== 401) fail(`tasks/get without a token should be 401, got ${noAuth.status}`);

const s = await start();
const id = s.body.result?.id;
if (s.body.result?.status?.state !== "submitted" || !id) fail("start did not return a submitted task");
console.log("started", id);
const t0 = Date.now();
let state = "submitted", last;
while (Date.now() - t0 < 10 * 60_000 && !["completed", "failed", "rejected", "canceled"].includes(state)) {
  await new Promise((r) => setTimeout(r, 15_000));
  last = (await rpc("tasks/get", { id })).body.result;
  state = last?.status?.state ?? "unknown";
  console.log(`${Math.round((Date.now() - t0) / 1000)}s ${state}`);
}
if (state !== "completed") fail(`final state ${state}: ${last?.status?.message?.parts?.[0]?.text ?? ""}`);
const result = last.artifacts[0].parts[0].data.result;
console.log("items:", result.items.length, "model:", result.model.provider + "/" + result.model.model, "warnings:", result.warnings.length);
if (last.artifacts[0].metadata?.untrusted_content !== true) fail("artifact is not marked untrusted");

const s2 = await start();
const c = await rpc("tasks/cancel", { id: s2.body.result.id });
console.log("cancel ->", c.body.result?.status?.state ?? JSON.stringify(c.body.error));
console.log("OK (record the timings and counts in axon-STATE.md)");
