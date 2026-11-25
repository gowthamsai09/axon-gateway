// SSRF checks for the gateway (spec 10.1, Appendix C 84). The Worker never fetches a caller-supplied URL:
// it reads the feed from FEED_BASE, calls two fixed provider hosts and (Tier 3) api.github.com. These tests
// pin the config rules for FEED_BASE and PUBLIC_URL, the feed path allow-list, and the hosts it can contact.
import { describe, expect, it } from "vitest";
import { FeedReader } from "../src/core/feed";
import { feedBase, isIpLiteral, publicUrl } from "../src/env";
import { PROVIDER_BASE_URLS } from "../src/providers";
import { FEED, ITEM, KEY, TEST_ENV, chat, goodSummary, llmHeaders, makeApp, makeFetch, post, sendMsg, type Call } from "./helpers";

type Pick = (env: Record<string, string>) => string;
const settings: [string, string, Pick][] = [
  ["FEED_BASE", "FEED_BASE", (env) => feedBase(env)],
  ["PUBLIC_URL", "PUBLIC_URL", (env) => publicUrl(env)],
];

const valid: [string, string][] = [
  ["https://a.example/feed", "https://a.example/feed"],
  ["https://a.example/feed/", "https://a.example/feed"],
  ["https://a.example", "https://a.example"],
  ["http://localhost:8788", "http://localhost:8788"],
  ["http://127.0.0.1:8788/feed", "http://127.0.0.1:8788/feed"],
  ["http://[::1]:8788", "http://[::1]:8788"],
  ["http://2130706433:8788", "http://2130706433:8788"], // the URL parser reads this as 127.0.0.1: loopback anyway
  ["http://127.1:8788", "http://127.1:8788"],
];
const invalid: string[] = [
  "", "   ", "nonsense", "ftp://a.example/feed", "file:///etc/passwd", "javascript:alert(1)", "https://",
  "https://user:pw@a.example/feed", "https://user@a.example/feed", "https://a.example/feed?x=1", "https://a.example/feed#f",
  "http://a.example/feed", "http://localhost.evil.example/feed", "http://127.0.0.1.evil.example/feed",
  "http://[::ffff:127.0.0.1]/feed", "https://169.254.169.254/feed", "https://2130706433/feed", "https://0x7f.0.0.1/feed",
  "https://127.1/feed", "https://[::1]/feed", "https://[fd00::1]/feed", "https://10.0.0.1/feed", "https://8.8.8.8/feed",
  "https://a.example.<account>/feed", "https://axon-gateway.<account>.workers.dev",
];

describe.each(settings)("%s validation", (_label, name, pick) => {
  it.each(valid)("accepts %s", (input, expected) => {
    expect(pick({ [name]: input })).toBe(expected);
  });
  it.each(invalid)("refuses %j", (input) => {
    expect(() => pick({ [name]: input })).toThrow(/not configured/);
  });
  it("refuses a missing value", () => {
    expect(() => pick({})).toThrow(/not configured/);
  });
});

describe("isIpLiteral", () => {
  it.each(["127.0.0.1", "10.0.0.1", "2130706433", "0x7f000001", "0x7f.0.0.1", "127.1", "127.0.0.1.", "[::1]", "[fd00::1]"])(
    "%s is an IP literal",
    (h) => expect(isIpLiteral(h)).toBe(true),
  );
  it.each(["example.com", "a.example", "localhost", "127.0.0.1.evil.example", "workers.dev", "x1.example"])("%s is a name", (h) =>
    expect(isIpLiteral(h)).toBe(false),
  );
});

describe("feed paths", () => {
  const rejected = [
    "../meta.json", "tags/../../x.json", "tags/%2e%2e/x.json", "tags/..%2fx.json", "tags\\x.json",
    "items/6a23445afa1896da.json/../../x", "items/6A23445AFA1896DA.json", "tags/a_b.json", "https://evil.example/x",
    "//evil.example/x", " tags/x.json", "tags/x.json\n", "latest.json?x=1", "latest.json#x", "tags/.json", "items/short.json", "",
  ];
  it.each(rejected)("refuses %j before any request", async (rel) => {
    const fx = makeFetch();
    await expect(new FeedReader(FEED, fx.fetch).read(rel)).rejects.toMatchObject({ code: "internal_error" });
    expect(fx.calls).toHaveLength(0);
  });
  it.each(["meta.json", "latest.json", "tags/rag.json", "entities/qwen.json", "items/6a23445afa1896da.json"])("reads %s from the feed host only", async (rel) => {
    const fx = makeFetch();
    await new FeedReader(FEED, fx.fetch).read(rel);
    expect(fx.calls.map((c) => c.url)).toEqual([`${FEED}/${rel}`]);
  });
});

describe("outbound hosts", () => {
  const urlOf = (c: Call): string => /^source_url: (.*)$/m.exec((JSON.parse(c.body) as { messages: { content: string }[] }).messages[1]?.content ?? "")?.[1] ?? "";
  const answer = (c: Call) => chat(goodSummary({}, urlOf(c)));
  const ALLOWED = new Set(["feed.test", "api.deepseek.com", "router.huggingface.co"]);
  const hostsOf = (calls: Call[]): string[] => [...new Set(calls.map((c) => new URL(c.url).host))];

  it("the provider table holds exactly the two fixed https hosts", () => {
    const hosts = Object.values(PROVIDER_BASE_URLS).map((u) => new URL(u));
    expect(hosts.map((u) => u.protocol)).toEqual(["https:", "https:"]);
    expect(hosts.map((u) => u.host).sort()).toEqual(["api.deepseek.com", "router.huggingface.co"]);
  });

  it.each([
    ["Tier 1 without filters", sendMsg({ skill: "get_ai_updates" }), {}],
    ["Tier 1 with a topic and an entity", sendMsg({ skill: "get_ai_updates", topics: ["agents-tooling"], entities: ["llama-cpp"] }), {}],
    ["Tier 2 on DeepSeek", sendMsg({ skill: "summarize_ai_updates", item_ids: [ITEM] }), llmHeaders()],
    ["Tier 2 on Hugging Face", sendMsg({ skill: "summarize_ai_updates", item_ids: [ITEM] }), llmHeaders({ "x-llm-provider": "huggingface" })],
  ])("%s contacts only the feed and the fixed provider hosts", async (_n, body, headers) => {
    const fx = makeFetch({ provider: answer });
    await post(makeApp(fx), "/a2a", body, headers);
    expect(fx.calls.length).toBeGreaterThan(0);
    for (const host of hostsOf(fx.calls)) expect(ALLOWED.has(host), host).toBe(true);
  });

  it.each(["https://evil.example", "deepseek.evil.example", "deepseek@evil.example", "huggingface/../x", "DEEPSEEK\u00A0", "http://api.deepseek.com"])(
    "provider header %j cannot redirect the key anywhere and makes no outbound call",
    async (provider) => {
      const fx = makeFetch({ provider: answer });
      const res = await post(makeApp(fx), "/a2a", sendMsg({ skill: "summarize_ai_updates", item_ids: [ITEM] }), llmHeaders({ "x-llm-provider": provider }));
      expect(fx.calls).toHaveLength(0);
      expect(JSON.stringify(await res.json())).not.toContain(KEY);
    },
  );

  it("a hostile FEED_BASE in the environment fails closed with no request at all", async () => {
    const fx = makeFetch();
    for (const bad of ["http://169.254.169.254/feed", "https://10.0.0.1/feed", "https://user:pw@feed.test/feed"]) {
      const res = await post(makeApp(fx), "/a2a", sendMsg({ skill: "get_ai_updates" }), {}, { ...TEST_ENV, FEED_BASE: bad });
      expect(res.status).toBe(500);
    }
    expect(fx.calls).toHaveLength(0);
  });
});
