import { afterEach, describe, expect, it, vi } from "vitest";
import { ITEM, KEY, TEST_ENV, at, chat, goodSummary, llmHeaders, makeApp, makeFetch, post, sendMsg, type Call, type FakeFetch, type ProviderHandler } from "./helpers";

const urlOf = (c: Call): string => /^source_url: (.*)$/m.exec((JSON.parse(c.body) as { messages: { content: string }[] }).messages[1]?.content ?? "")?.[1] ?? "";
const okModel: ProviderHandler = (c) => chat(goodSummary({}, urlOf(c)));
const tier2 = sendMsg({ skill: "summarize_ai_updates", item_ids: [ITEM] });
const mcpTier2 = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarize_items", arguments: { item_ids: [ITEM] } } };

afterEach(() => vi.restoreAllMocks());

const scenarios: [string, ProviderHandler][] = [
  ["success", okModel],
  ["provider 401", () => new Response(`key ${KEY} rejected`, { status: 401 })],
  ["provider 402", () => new Response(`balance for ${KEY}`, { status: 402 })],
  ["provider 429", () => new Response(`limit ${KEY}`, { status: 429 })],
  ["provider 500", () => new Response(`crash ${KEY}`, { status: 500 })],
  ["provider 400", () => new Response(`bad ${KEY}`, { status: 400 })],
  ["network error", () => { throw new Error(`reset while sending ${KEY}`); }],
  ["malformed 200", () => new Response(`{"choices":[{"message":{"content":"${KEY}`, { status: 200 })],
  ["model echoes the key", (c) => chat(goodSummary({ one_line: `my key is ${KEY}` }, urlOf(c)))],
];

describe("the caller's key never appears in anything the gateway produces", () => {
  const capture = () => {
    const logged: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
    }
    return logged;
  };
  for (const [path, body] of [["/a2a", tier2], ["/mcp", mcpTier2]] as const) {
    it.each(scenarios)(`${path}: %s`, async (_n, handler) => {
      const logged = capture();
      const fx = makeFetch({ provider: handler });
      const res = await post(makeApp(fx), path, body, llmHeaders());
      const headers = JSON.stringify([...res.headers.entries()]);
      const text = await res.text();
      expect(text).not.toContain(KEY);
      expect(headers).not.toContain(KEY);
      expect(logged.join("\n")).not.toContain(KEY);
      // The only place it may appear in an outbound request is the Authorization header to the provider.
      for (const c of fx.calls) {
        expect(c.url).not.toContain(KEY);
        expect(c.body).not.toContain(KEY);
        const others = Object.entries(c.headers).filter(([k]) => k !== "authorization");
        expect(JSON.stringify(others)).not.toContain(KEY);
        if (c.headers["authorization"]) expect(c.url.startsWith("https://api.deepseek.com/")).toBe(true);
      }
    });
  }
  it("is absent from the feed requests (the only cacheable ones)", async () => {
    const fx = makeFetch({ provider: okModel });
    await post(makeApp(fx), "/a2a", tier2, llmHeaders());
    expect(fx.feed().length).toBeGreaterThan(0);
    for (const c of fx.feed()) {
      expect(JSON.stringify(c)).not.toContain(KEY);
      expect(c.headers["authorization"]).toBeUndefined();
      expect(c.headers["x-llm-key"]).toBeUndefined();
    }
  });
  it("provider requests are never marked cacheable", async () => {
    const fx = makeFetch({ provider: okModel });
    await post(makeApp(fx), "/a2a", tier2, llmHeaders());
    for (const c of fx.provider()) expect((c.init as { cf?: unknown }).cf).toBeUndefined();
  });
  it("is not stored: no KV, no Cache API use anywhere in the source", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const files = [...readdirSync("src", { recursive: true, encoding: "utf8" })].filter((f) => f.endsWith(".ts") && f !== "tokens.ts");
    const source = files.map((f) => readFileSync(`src/${f}`, "utf8")).join("\n");
    expect(source).not.toMatch(/\bcaches\.(default|open)\b|\.put\(|TOKENS\.(put|get)|localStorage/);
    expect(source).not.toMatch(/console\./);
  });
  it("the Worker never returns request headers, even in errors", async () => {
    const res = await post(makeApp(makeFetch()), "/a2a", tier2, { "x-llm-provider": "evil-provider", "x-llm-key": KEY, "x-secret-header": "HEADER-VALUE-123" });
    const text = await res.text();
    expect(text).not.toContain("evil-provider");
    expect(text).not.toContain("HEADER-VALUE-123");
    expect(text).not.toContain(KEY);
  });
});

describe("keys in the body are refused", () => {
  it.each([
    ["a2a", "/a2a", sendMsg({ skill: "summarize_ai_updates", item_ids: [ITEM], "x-llm-key": KEY })],
    ["a2a nested", "/a2a", sendMsg({ skill: "get_ai_updates", filters: [{ authorization: `Bearer ${KEY}` }] })],
    ["mcp", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "summarize_items", arguments: { item_ids: [ITEM], llm_key: KEY } } }],
  ])("%s", async (_n, path, body) => {
    const fx = makeFetch({ provider: okModel });
    const res = await post(makeApp(fx), path, body, llmHeaders());
    expect(await res.text()).not.toContain(KEY);
    expect(fx.calls).toHaveLength(0);
  });
});

describe("the Worker is not an open proxy", () => {
  const hostile = {
    "x-llm-base-url": "https://evil.example",
    "x-llm-url": "https://evil.example",
    "x-forwarded-host": "evil.example",
    host: "evil.example",
    "x-original-url": "https://evil.example/x",
  };
  it("caller headers cannot redirect the provider call or the feed", async () => {
    const fx = makeFetch({ provider: okModel });
    await post(makeApp(fx), "/a2a", tier2, llmHeaders(hostile));
    expect(new Set(fx.calls.map((c) => new URL(c.url).host))).toEqual(new Set(["feed.test", "api.deepseek.com"]));
  });
  it("a URL in item_ids, topics or entities is rejected before any request", async () => {
    for (const data of [
      { skill: "summarize_ai_updates", item_ids: ["https://evil.example/x"] },
      { skill: "get_ai_updates", topics: ["https://evil.example"] },
      { skill: "get_ai_updates", entities: ["evil.example/x"] },
      { skill: "get_ai_updates", entities: ["a/b"] },
    ]) {
      const fx = makeFetch({ provider: okModel });
      await post(makeApp(fx), "/a2a", sendMsg(data), llmHeaders());
      expect(fx.calls).toHaveLength(0);
    }
  });
  it("a provider name that is a URL or an internal host is refused", async () => {
    for (const p of ["https://evil.example", "localhost", "169.254.169.254", "deepseek@evil.example", "deepseek.evil.example"]) {
      const fx = makeFetch({ provider: okModel });
      const res = await post(makeApp(fx), "/a2a", tier2, llmHeaders({ "x-llm-provider": p }));
      expect(at(await res.json(), "error.code")).toBe(-32602);
      expect(fx.calls).toHaveLength(0);
    }
  });
  it("every outbound URL across a full Tier 1 + Tier 2 session is on an expected host", async () => {
    const fx: FakeFetch = makeFetch({ provider: okModel });
    const app = makeApp(fx);
    await post(app, "/a2a", sendMsg({ skill: "get_ai_updates", topics: ["agents-tooling"], entities: ["llama-cpp"] }));
    await post(app, "/a2a", tier2, llmHeaders());
    await post(app, "/mcp", mcpTier2, llmHeaders({ "x-llm-provider": "huggingface" }));
    const hosts = new Set(fx.calls.map((c) => new URL(c.url).host));
    expect([...hosts].sort()).toEqual(["api.deepseek.com", "feed.test", "router.huggingface.co"]);
  });
  it("the feed host comes only from configuration", async () => {
    const fx = makeFetch({ provider: okModel });
    await post(makeApp(fx), "/a2a", sendMsg({ skill: "get_ai_updates" }), {}, { ...TEST_ENV, FEED_BASE: "https://feed.test/feed" });
    expect(fx.feed().every((c) => c.url.startsWith("https://feed.test/feed/"))).toBe(true);
  });
});

describe("duplicate and malformed headers", () => {
  it("a duplicated X-LLM-Key (joined by the platform) is refused without calling anyone", async () => {
    const fx = makeFetch({ provider: okModel });
    const headers = new Headers({ "content-type": "application/json", "x-llm-provider": "deepseek" });
    headers.append("x-llm-key", KEY);
    headers.append("x-llm-key", "sk-another-key-1234567890");
    const res = await makeApp(fx).request("/a2a", { method: "POST", headers, body: JSON.stringify(tier2) }, TEST_ENV);
    const body = await res.json();
    expect(at(body, "result.status.message.parts.1.data.error.code")).toBe("llm_key_invalid");
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(fx.provider()).toHaveLength(0);
  });
  it("a model header cannot carry a URL or traversal", async () => {
    for (const m of ["https://evil.example/m", "../../x", "a b", "m\u0000"]) {
      const fx = makeFetch({ provider: okModel });
      const res = await post(makeApp(fx), "/a2a", tier2, llmHeaders({ "x-llm-model": m.replace("\u0000", "%00") }));
      expect(at(await res.json(), "error.code")).toBe(-32602);
      expect(fx.provider()).toHaveLength(0);
    }
  });
});

describe("stored data", () => {
  it("serving requests writes nothing: responses carry no-store and there is no state", async () => {
    const res = await post(makeApp(makeFetch({ provider: okModel })), "/a2a", tier2, llmHeaders());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
