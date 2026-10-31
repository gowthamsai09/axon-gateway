import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp";
import { ITEM, KEY, at, bodyOf, chat, goodSummary, llmHeaders, makeApp, makeFetch, post, type Call } from "./helpers";

const urlOf = (c: Call): string => /^source_url: (.*)$/m.exec((JSON.parse(c.body) as { messages: { content: string }[] }).messages[1]?.content ?? "")?.[1] ?? "";
const model = (c: Call) => chat(goodSummary({}, urlOf(c)));
const V = "io.modelcontextprotocol/protocolVersion";
const modernHeaders = (method: string, name?: string) => ({
  "mcp-protocol-version": "2026-07-28",
  "mcp-method": method,
  ...(name ? { "mcp-name": name } : {}),
});
const call = async (body: unknown, headers: Record<string, string> = {}, fx = makeFetch({ provider: model })) => {
  const res = await post(makeApp(fx), "/mcp", body, headers);
  return { res, body: res.status === 202 ? null : await bodyOf(res), fx };
};
const modernCall = (name: string, args: unknown, headers: Record<string, string> = {}) =>
  call(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args, _meta: { [V]: "2026-07-28" } } },
    { ...modernHeaders("tools/call", name), ...headers },
  );

describe("MCP 2026-07-28 (stateless, primary)", () => {
  it("server/discover lists supported versions, capabilities and instructions", async () => {
    const { res, body } = await call({ jsonrpc: "2.0", id: 1, method: "server/discover" });
    expect(res.status).toBe(200);
    expect(at(body, "result.resultType")).toBe("complete");
    expect(at(body, "result.supportedVersions")).toEqual(["2026-07-28", "2025-11-25"]);
    expect(at(body, "result.capabilities")).toEqual({ tools: {} });
    expect(at(body, "result.serverInfo.name")).toBe("axon");
    expect(at(body, "result.instructions")).toMatch(/untrusted third-party content/);
  });
  it("issues no session id anywhere", async () => {
    for (const method of ["server/discover", "initialize", "tools/list"]) {
      const { res } = await call({ jsonrpc: "2.0", id: 1, method }, method === "tools/list" ? {} : {});
      expect(res.headers.get("mcp-session-id")).toBeNull();
    }
  });
  it("tools/list: exactly the two Phase 3 tools, cacheable, with schemas", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2026-07-28" } } }, modernHeaders("tools/list"));
    expect((at(body, "result.tools") as { name: string }[]).map((t) => t.name)).toEqual(["get_ai_updates", "summarize_items"]);
    expect(at(body, "result.resultType")).toBe("complete");
    expect(at(body, "result.cacheScope")).toBe("public");
    expect(at(body, "result.ttlMs")).toBe(3_600_000);
    expect(JSON.stringify(body)).not.toMatch(/start_digest|get_digest_status/);
  });
  it("tool input schemas describe the strict parameters and annotate read-only", () => {
    const [updates, summarize] = MCP_TOOLS;
    expect(at(updates?.inputSchema, "additionalProperties")).toBe(false);
    expect(Object.keys(at(updates?.inputSchema, "properties") as object)).toEqual(["topics", "entities", "since", "limit"]);
    expect(at(summarize?.inputSchema, "required")).toEqual(["item_ids"]);
    expect(Object.keys(at(summarize?.inputSchema, "properties") as object)).toEqual(["item_ids", "depth", "language"]);
    expect(updates?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect(JSON.stringify(MCP_TOOLS)).not.toMatch(/api_key|X-LLM-Key"?\s*:\s*\{/);
  });
  it("tools/call returns text content plus structuredContent, and decorates the result", async () => {
    const { body } = await modernCall("get_ai_updates", { topics: ["agents-tooling"], limit: 2 });
    expect(at(body, "result.resultType")).toBe("complete");
    expect(at(body, "result.isError")).toBeUndefined();
    expect(at(body, "result.content.0.type")).toBe("text");
    expect(JSON.parse(at(body, "result.content.0.text") as string)).toEqual(at(body, "result.structuredContent"));
    expect(at(body, "result.structuredContent.count")).toBe(2);
  });
  it("Mcp-Method must match the body", async () => {
    const { res, body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2026-07-28" } } }, modernHeaders("tools/call"));
    expect(res.status).toBe(400);
    expect(at(body, "error.code")).toBe(-32020);
  });
  it("Mcp-Method missing -> header mismatch", async () => {
    const { res } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2026-07-28" });
    expect(res.status).toBe(400);
  });
  it("Mcp-Name must match the tool name", async () => {
    const { res, body } = await call(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_ai_updates", arguments: {} } },
      modernHeaders("tools/call", "summarize_items"),
    );
    expect(res.status).toBe(400);
    expect(at(body, "error.code")).toBe(-32020);
  });
  it("header version and _meta version must agree", async () => {
    const { res, body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { [V]: "2025-11-25" } } }, modernHeaders("tools/list"));
    expect(res.status).toBe(400);
    expect(at(body, "error.code")).toBe(-32020);
  });
  it("an unsupported version -> -32022 listing what is supported", async () => {
    const { res, body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2030-01-01" });
    expect(res.status).toBe(400);
    expect(at(body, "error.code")).toBe(-32022);
    expect(at(body, "error.data.supported")).toEqual(["2026-07-28", "2025-11-25"]);
  });
  it("ping is gone in 2026-07-28", async () => {
    expect(at((await call({ jsonrpc: "2.0", id: 1, method: "ping" }, modernHeaders("ping"))).body, "error.code")).toBe(-32601);
  });
});

describe("MCP 2025-11-25 (legacy clients, still stateless)", () => {
  it("initialize answers without a session and without per-call state", async () => {
    const { res, body } = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } });
    expect(at(body, "result.protocolVersion")).toBe("2025-11-25");
    expect(at(body, "result.capabilities.tools")).toEqual({ listChanged: false });
    expect(at(body, "result.instructions")).toMatch(/untrusted/);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
  it("initialize with a newer or unknown version still answers the legacy revision", async () => {
    for (const v of ["2099-01-01", "2026-07-28", 5]) {
      const { body } = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: v } });
      expect(at(body, "result.protocolVersion")).toBe("2025-11-25");
    }
  });
  it("notifications/initialized -> 202 with no body", async () => {
    const { res } = await call({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
  it("any notifications/* is accepted silently", async () => {
    expect((await call({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).res.status).toBe(202);
  });
  it("a non-notification request without id is invalid", async () => {
    expect((await call({ jsonrpc: "2.0", method: "tools/list" })).res.status).toBe(400);
  });
  it("tools/list works without any version header", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect((at(body, "result.tools") as unknown[]).length).toBe(2);
    expect(at(body, "result.resultType")).toBeUndefined();
  });
  it("tools/list with the legacy header", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": "2025-11-25" });
    expect((at(body, "result.tools") as unknown[]).length).toBe(2);
  });
  it("ping answers an empty result", async () => {
    expect(at((await call({ jsonrpc: "2.0", id: 1, method: "ping" })).body, "result")).toEqual({});
  });
  it("tools/call works", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_ai_updates", arguments: { entities: ["llama-cpp"] } } });
    expect(at(body, "result.structuredContent.count")).toBe(1);
  });
  it("arguments may be omitted", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_ai_updates" } });
    expect(at(body, "result.structuredContent.count")).toBe(10);
  });
});

describe("MCP tools/call: Tier 2 and error handling", () => {
  const args = { item_ids: [ITEM], depth: "brief" };
  it("summarize_items with the key in headers", async () => {
    const { body, fx } = await modernCall("summarize_items", args, llmHeaders());
    expect(at(body, "result.structuredContent.results.0.status")).toBe("ok");
    expect(fx.provider()[0]?.headers["authorization"]).toBe(`Bearer ${KEY}`);
  });
  it("missing key is a tool error (isError) that names the header", async () => {
    const { body } = await modernCall("summarize_items", args, { "x-llm-provider": "deepseek" });
    expect(at(body, "result.isError")).toBe(true);
    expect(JSON.parse(at(body, "result.content.0.text") as string)).toMatchObject({ error: { code: "missing_parameter" } });
  });
  it.each([
    [401, "llm_key_invalid"],
    [402, "llm_quota"],
    [500, "upstream_unavailable"],
  ])("provider HTTP %s -> tool error %s without the key", async (status, code) => {
    const fx = makeFetch({ provider: () => new Response("x", { status }) });
    const r = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarize_items", arguments: args } }, llmHeaders(), fx);
    expect(at(r.body, "result.isError")).toBe(true);
    expect(JSON.parse(at(r.body, "result.content.0.text") as string)).toMatchObject({ error: { code } });
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });
  it("invalid arguments are tool errors so a model can correct itself", async () => {
    const { body, fx } = await modernCall("get_ai_updates", { topics: ["nope"] });
    expect(at(body, "result.isError")).toBe(true);
    expect(JSON.parse(at(body, "result.content.0.text") as string).error.message).toMatch(/Invalid params in: topics/);
    expect(fx.calls).toHaveLength(0);
  });
  it("a key in the arguments is refused as key_in_body and never echoed", async () => {
    const { body, fx } = await modernCall("summarize_items", { ...args, api_key: KEY }, llmHeaders());
    expect(at(body, "result.isError")).toBe(true);
    expect(JSON.parse(at(body, "result.content.0.text") as string).error.code).toBe("key_in_body");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(fx.calls).toHaveLength(0);
  });
  it.each(["start_digest", "get_digest_status"])("%s -> an honest not_implemented tool error", async (name) => {
    const { body } = await modernCall(name, {});
    expect(at(body, "result.isError")).toBe(true);
    expect(JSON.parse(at(body, "result.content.0.text") as string).error).toMatchObject({ code: "not_implemented" });
  });
  it("an unknown tool is a protocol error", async () => {
    expect(at((await modernCall("rm_rf", {})).body, "error.code")).toBe(-32602);
  });
  it("tools/call params are validated", async () => {
    const { body } = await call({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 5 } });
    expect(at(body, "error.code")).toBe(-32602);
  });
  it.each(["resources/list", "prompts/list", "completion/complete", "logging/setLevel"])("%s -> -32601 (only tools are offered)", async (method) => {
    expect(at((await call({ jsonrpc: "2.0", id: 1, method })).body, "error.code")).toBe(-32601);
  });
  it("Tier 2 over MCP is rate limited with HTTP 429 and Retry-After", async () => {
    const app = makeApp(makeFetch({ provider: model }));
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarize_items", arguments: args } };
    let last = 0;
    let retry: string | null = null;
    for (let i = 0; i < 11; i++) {
      const r = await post(app, "/mcp", body, llmHeaders({ "cf-connecting-ip": "192.0.2.5" }));
      last = r.status;
      retry = r.headers.get("retry-after");
    }
    expect(last).toBe(429);
    expect(retry).toBe("60");
  });
});
