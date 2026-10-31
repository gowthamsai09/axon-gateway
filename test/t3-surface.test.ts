import { describe, expect, it } from "vitest";
import { at, bodyOf } from "./helpers";
import { makeKit, type Kit } from "./t3-helpers";

const mcp = (k: Kit, method: string, params: unknown, headers: Record<string, string> = {}) =>
  k.call("POST", "/mcp", headers, { jsonrpc: "2.0", id: 1, method, params });
const tool = (k: Kit, name: string, args: unknown, headers: Record<string, string> = {}) => mcp(k, "tools/call", { name, arguments: args }, headers);
const names = async (res: Response) => ((at(await bodyOf(res), "result.tools") as { name: string }[]) ?? []).map((t) => t.name);

describe("Agent Card and tools/list exposure", () => {
  it("lists the Tier 3 skill and the ownerBearer scheme only when Tier 3 is configured", async () => {
    const on = await makeKit();
    const card = await bodyOf(await on.call("GET", "/.well-known/agent-card.json"));
    expect((at(card, "skills") as { id: string }[]).map((s) => s.id)).toEqual(["get_ai_updates", "summarize_ai_updates", "run_personal_digest"]);
    expect(at(card, "securitySchemes.ownerBearer.scheme")).toBe("bearer");
    expect(at(card, "protocolVersion")).toBe("0.3.0");
    const off = await makeKit({ dropKv: true });
    const plain = await bodyOf(await off.call("GET", "/.well-known/agent-card.json"));
    expect((at(plain, "skills") as { id: string }[]).map((s) => s.id)).toEqual(["get_ai_updates", "summarize_ai_updates"]);
    expect(at(plain, "securitySchemes.ownerBearer")).toBeUndefined();
  });

  it.each([["TOKENS", { dropKv: true }], ["GITHUB_APP_ID", { env: { GITHUB_APP_ID: "" } }], ["GITHUB_APP_PRIVATE_KEY", { env: { GITHUB_APP_PRIVATE_KEY: "" } }]] as const)(
    "stays on the Phase 3 surface when %s is missing",
    async (_n, over) => {
      const k = await makeKit(over as never);
      expect(await names(await mcp(k, "tools/list", {}))).toEqual(["get_ai_updates", "summarize_items"]);
    },
  );

  it("lists start_digest and get_digest_status when configured, with strict schemas", async () => {
    const k = await makeKit();
    const res = await bodyOf(await mcp(k, "tools/list", {}));
    expect(((at(res, "result.tools") as { name: string }[]).map((t) => t.name))).toEqual(["get_ai_updates", "summarize_items", "start_digest", "get_digest_status"]);
    const start = (at(res, "result.tools") as { name: string; inputSchema: Record<string, unknown> }[]).find((t) => t.name === "start_digest");
    expect(start?.inputSchema["additionalProperties"]).toBe(false);
  });

  it("the unknown-skill error lists run_personal_digest only when configured", async () => {
    const k = await makeKit();
    expect(at(await bodyOf(await k.send({ skill: "nope" })), "error.data.skills")).toContain("run_personal_digest");
    const off = await makeKit({ dropKv: true });
    expect(at(await bodyOf(await off.send({ skill: "nope" })), "error.data.skills")).not.toContain("run_personal_digest");
  });

  it("without Tier 3 configured, run_personal_digest and tasks/get keep the Phase 3 answers", async () => {
    const k = await makeKit({ dropKv: true });
    expect(await (await k.send({ skill: "run_personal_digest" })).text()).toContain("unsupported_skill");
    expect(at(await bodyOf(await k.rpc("tasks/get", { id: "abc" })), "error.code")).toBe(-32001);
  });

  it("without Tier 3 configured, the MCP digest tools answer not_implemented", async () => {
    const k = await makeKit({ dropKv: true });
    expect(await (await tool(k, "start_digest", {})).text()).toContain("not_implemented");
  });
});

describe("MCP Tier 3 tools", () => {
  it("start_digest without a token is HTTP 401 with WWW-Authenticate", async () => {
    const k = await makeKit();
    await k.ready();
    const res = await tool(k, "start_digest", {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("start_digest and get_digest_status work end to end with a token", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    const started = await bodyOf(await tool(k, "start_digest", { max_items: 3 }, k.bearer(token)));
    const taskId = at(started, "result.structuredContent.task_id") as string;
    expect(at(started, "result.structuredContent.state")).toBe("submitted");
    const status = await bodyOf(await tool(k, "get_digest_status", { task_id: taskId }, k.bearer(token)));
    expect(at(status, "result.structuredContent.state")).toBe("submitted");
    Object.assign(k.gh.state.runs[0] as object, { status: "completed", conclusion: "success" });
    k.gh.state.files.set(`state:tasks/${taskId}.json`, JSON.stringify({ task_id: taskId, status: "completed", finished_at: "2026-10-20T06:01:00Z", items: [], model: { provider: "deepseek", model: "deepseek-v4-flash" }, warnings: [] }));
    const done = await bodyOf(await tool(k, "get_digest_status", { task_id: taskId }, k.bearer(token)));
    expect(at(done, "result.structuredContent.state")).toBe("completed");
    expect(at(done, "result.structuredContent.untrusted")).toBe(true);
  });

  it("rejects unknown arguments as a tool error without calling GitHub", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.gh.forget();
    const res = await bodyOf(await tool(k, "start_digest", { repo: "evil/x" }, k.bearer(token)));
    expect(at(res, "result.isError")).toBe(true);
    expect(k.gh.calls).toHaveLength(0);
  });

  it("an unknown task is a tool error, not a crash", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    const res = await bodyOf(await tool(k, "get_digest_status", { task_id: "00000000-0000-4000-8000-000000000000" }, k.bearer(token)));
    expect(at(res, "result.isError")).toBe(true);
  });

  it("refuses a token sent in the arguments", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    const res = await tool(k, "start_digest", { note: token });
    const text = await res.text();
    expect(text).toContain("key_in_body");
    expect(text).not.toContain(token);
  });

  it("a revoked token gets 401 on the MCP tools", async () => {
    const k = await makeKit();
    const { token, id } = await k.ready();
    await k.call("DELETE", `/tokens/${id}`, await k.oidcFor("revoke-token.yml"));
    expect((await tool(k, "start_digest", {}, k.bearer(token))).status).toBe(401);
  });

  it("owner policy refusal over MCP is a tool error with the reason", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.gh.state.files.set("main:profile.yaml", "agent_access:\n  allow_inbound_agents: false\n");
    const res = await bodyOf(await tool(k, "start_digest", {}, k.bearer(token)));
    expect(at(res, "result.isError")).toBe(true);
    expect(JSON.stringify(res)).toContain("owner_policy");
  });
});
