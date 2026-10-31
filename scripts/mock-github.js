// Local mock of the parts of GitHub that Tier 3 uses (docs/local-run.md). NOT GitHub: shapes follow
// the REST docs and are checked only by the gateway's own tests. Control endpoints live under /__mock/.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const port = Number(process.env.MOCK_PORT ?? "8790");
const cfg = JSON.parse(readFileSync(".mock-github.json", "utf8"));
const REPO = "alice/axon-digest";
const runs = [];
const files = new Map();
let nextId = 5000;
const log = [];

const send = (res, status, body, raw = false) => {
  res.writeHead(status, { "content-type": raw ? "text/plain" : "application/json" });
  res.end(raw ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const body = await readBody(req);
  log.push(`${req.method} ${url.pathname}${url.search}`);
  console.log(`mock-github: ${req.method} ${url.pathname}`);
  const auth = req.headers.authorization ?? "";
  let m;
  if (url.pathname === "/jwks") return send(res, 200, cfg.jwks);
  if (url.pathname === "/__mock/calls") return send(res, 200, log);
  if (url.pathname === "/__mock/advance" && req.method === "POST") {
    // queued -> in_progress -> completed(success, with a result file on the state branch)
    for (const r of runs) {
      if (r.status === "queued") r.status = "in_progress";
      else if (r.status === "in_progress") {
        r.status = "completed";
        r.conclusion = "success";
        const taskId = r.display_title.replace("digest task ", "");
        files.set(`state:tasks/${taskId}.json`, JSON.stringify({
          task_id: taskId, status: "completed", finished_at: new Date().toISOString(),
          items: [{ id: "0123456789abcdef", title: "Example item", url: "https://example.com/a", fallback_snippet: "Extractive snippet from the mock." }],
          model: { provider: "deepseek", model: "deepseek-v4-flash" }, warnings: [],
        }));
      }
      r.updated_at = new Date().toISOString();
    }
    return send(res, 200, runs.map((r) => ({ id: r.id, status: r.status, conclusion: r.conclusion })));
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(url.pathname))) return auth.startsWith("Bearer ") ? send(res, 200, { id: 777001 }) : send(res, 401, { message: "Bad credentials" });
  if (/^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)) return send(res, 201, { token: "ghs_local_mock_installation_token", expires_at: new Date(Date.now() + 3600_000).toISOString() });
  if (auth !== "Bearer ghs_local_mock_installation_token") return send(res, 401, { message: "Bad credentials" });
  if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname))) return send(res, 200, { default_branch: "main" });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname))) {
    const text = files.get(`${url.searchParams.get("ref")}:${decodeURIComponent(m[2])}`);
    return text === undefined ? send(res, 404, { message: "Not Found" }) : send(res, 200, text, true);
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/digest\.yml\/dispatches$/.exec(url.pathname)) && req.method === "POST") {
    if (m[1] !== REPO) return send(res, 404, { message: "Not Found" });
    const inputs = JSON.parse(body).inputs;
    const now = new Date().toISOString();
    runs.push({ id: nextId++, status: "queued", conclusion: null, display_title: `digest task ${inputs.task_id}`, event: "workflow_dispatch", created_at: now, updated_at: now });
    res.writeHead(204); return res.end();
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/digest\.yml\/runs$/.exec(url.pathname))) return send(res, 200, { total_count: runs.length, workflow_runs: m[1] === REPO ? runs : [] });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/cancel$/.exec(url.pathname)) && req.method === "POST") {
    const r = runs.find((x) => x.id === Number(m[2]));
    if (!r) return send(res, 404, { message: "Not Found" });
    if (r.status === "completed") return send(res, 409, { message: "Cannot cancel a completed run" });
    r.status = "completed"; r.conclusion = "cancelled";
    return send(res, 202, {});
  }
  return send(res, 404, { message: "Not Found" });
}).listen(port, "127.0.0.1", () => console.log(`mock GitHub on http://127.0.0.1:${port}`));
