import { describe, expect, it } from "vitest";
import { SubrequestBudget, budgeted, mapPool } from "../src/budget";
import { FeedReader, entitySlug, generatedAt, parseItemFile, parseItems } from "../src/core/feed";
import { getUpdates } from "../src/core/updates";
import { feedBase, publicUrl, allowedProviders, hfDefaultModel } from "../src/env";
import { GetUpdatesInput } from "../src/schemas";
import { FEED, NOW, TEST_ENV, deps, idN, itemFile, makeFetch } from "./helpers";

const run = (input: Record<string, unknown>, fx = makeFetch()) => getUpdates(deps(fx), TEST_ENV, GetUpdatesInput.parse(input));
const ids = (r: { items: { id: string }[] }) => r.items.map((i) => i.id);

describe("getUpdates: shard selection", () => {
  it("no filters reads latest.json (plus meta.json)", async () => {
    const fx = makeFetch();
    const r = await run({}, fx);
    expect(fx.feed().map((c) => c.url).sort()).toEqual([`${FEED}/latest.json`, `${FEED}/meta.json`]);
    expect(r.count).toBe(10);
  });
  it("a topic reads only its shard", async () => {
    const fx = makeFetch();
    const r = await run({ topics: ["agents-tooling"] }, fx);
    expect(fx.feed().map((c) => c.url)).toContain(`${FEED}/tags/agents-tooling.json`);
    expect(fx.feed().some((c) => c.url.endsWith("latest.json"))).toBe(false);
    expect(ids(r)).toEqual(["aa4ccde86d8a3d2e", "6a23445afa1896da", "9d4b9e1fe5ab5819", "783605dbe8bc70b6"]);
  });
  it("an entity reads entities/<slug>.json", async () => {
    const r = await run({ entities: ["llama-cpp"] });
    expect(ids(r)).toEqual(["e4159de940dd7513"]);
  });
  it("topics and entities merge by id without duplicates", async () => {
    const r = await run({ topics: ["open-source-llms"], entities: ["llama-cpp"] });
    expect(new Set(ids(r)).size).toBe(ids(r).length);
    expect(ids(r)).toContain("e4159de940dd7513");
  });
  it("duplicate requested slugs are fetched once", async () => {
    const fx = makeFetch();
    await run({ topics: ["rag", "rag"], entities: ["qwen", "qwen"] }, fx);
    expect(fx.feed().filter((c) => c.url.endsWith("rag.json"))).toHaveLength(1);
    expect(fx.feed().filter((c) => c.url.endsWith("qwen.json"))).toHaveLength(1);
  });
  it("a missing shard (404) is normal and reported", async () => {
    const r = await run({ topics: ["agents-tooling", "robotics"] });
    expect(r.missing_shards).toEqual(["tags/robotics.json"]);
    expect(r.count).toBe(4);
    expect(r.fallback).toBeNull();
  });
});

describe("getUpdates: fallback to latest.json (Appendix C 49)", () => {
  it("falls back when every requested shard is missing, but keeps the filters", async () => {
    const r = await run({ topics: ["robotics"] });
    expect(r.fallback).toBe("latest");
    expect(r.count).toBe(0);
  });
  it("fallback still returns items that match the requested topic", async () => {
    const fx = makeFetch({ files: { "tags/llm-releases.json": 404 } });
    const r = await run({ topics: ["llm-releases"] }, fx);
    expect(r.fallback).toBe("latest");
    expect(ids(r)).toEqual(["1dbe22633003a2af"]);
  });
  it("fallback matches entities through their slug", async () => {
    const fx = makeFetch({ files: { "entities/hugging-face-transformers.json": 404 } });
    const r = await run({ entities: ["hugging-face-transformers"] }, fx);
    expect(ids(r)).toEqual(["7613bbebfcfc0377"]);
  });
});

describe("getUpdates: filter, sort, limit", () => {
  it("sorts by score desc, then published desc, then id", async () => {
    const r = await run({});
    const scores = r.items.map((i) => i.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(ids(r).slice(0, 2)).toEqual(["aa4ccde86d8a3d2e", "55c3c0be518a12ff"]);
  });
  it("breaks score ties by newer first, then id", async () => {
    const files = {
      "latest.json": { items: [
        itemFile(idN(3), { base_score: 0.5, published_at: "2026-10-19T10:00:00Z" }),
        itemFile(idN(2), { base_score: 0.5, published_at: "2026-10-19T11:00:00Z" }),
        itemFile(idN(1), { base_score: 0.5, published_at: "2026-10-19T11:00:00Z" }),
      ] },
    };
    expect(ids(await run({}, makeFetch({ files })))).toEqual([idN(1), idN(2), idN(3)]);
  });
  it("limit cuts the list", async () => expect((await run({ limit: 3 })).count).toBe(3));
  it("since filters by published_at (inclusive)", async () => {
    const r = await run({ since: "2026-10-19T23:22:18Z" });
    expect(ids(r).sort()).toEqual(["55c3c0be518a12ff", "7ae8ee8b087e2dbf", "aa4ccde86d8a3d2e", "e4159de940dd7513"]);
  });
  it("since understands offsets", async () => {
    const r = await run({ since: "2026-10-20T05:30:00+05:30" }); // 00:00:00Z
    expect(ids(r)).toContain("aa4ccde86d8a3d2e");
    expect(ids(r)).not.toContain("55c3c0be518a12ff");
  });
  it("an empty result is an honest empty list", async () => {
    const r = await run({ since: "2030-01-01T00:00:00Z" });
    expect(r).toMatchObject({ items: [], count: 0 });
  });
});

describe("getUpdates: output shape", () => {
  it("returns the public fields only, never the excerpt, with canonical url", async () => {
    const files = { "latest.json": { items: [itemFile(idN(1), { excerpt: "SECRET-EXCERPT", url: "https://x.example/?utm=1", canonical_url: "https://x.example/" })] } };
    const r = await run({}, makeFetch({ files }));
    expect(Object.keys(r.items[0] ?? {}).sort()).toEqual(["entities", "id", "published_at", "score", "snippet", "source", "tags", "title", "url"]);
    expect(r.items[0]?.url).toBe("https://x.example/");
    expect(JSON.stringify(r)).not.toContain("SECRET-EXCERPT");
  });
  it("caps snippets at 300 characters", async () => {
    const files = { "latest.json": { items: [itemFile(idN(1), { snippet: "s".repeat(900) })] } };
    expect((await run({}, makeFetch({ files }))).items[0]?.snippet).toHaveLength(300);
  });
  it("drops unknown tag slugs from output", async () => {
    const files = { "latest.json": { items: [itemFile(idN(1), { tags: ["rag", "brand-new-slug"] })] } };
    expect((await run({}, makeFetch({ files }))).items[0]?.tags).toEqual(["rag"]);
  });
  it("marks the content untrusted and reports freshness", async () => {
    const r = await run({});
    expect(r.untrusted).toBe(true);
    expect(r.notice).toMatch(/untrusted/);
    expect(r.feed_generated_at).toBe("2026-10-20T03:47:55.762003Z");
    expect(r.feed_stale).toBe(false);
  });
  it("flags a stale feed (older than 30 hours)", async () => {
    const r = await getUpdates({ ...deps(makeFetch()), now: () => new Date(NOW.getTime() + 40 * 3600_000) }, TEST_ENV, GetUpdatesInput.parse({}));
    expect(r.feed_stale).toBe(true);
  });
  it("meta.json being unavailable is not fatal", async () => {
    const r = await run({}, makeFetch({ files: { "meta.json": 500 } }));
    expect(r.feed_generated_at).toBeNull();
    expect(r.count).toBe(10);
  });
});

describe("getUpdates: tolerant reading and failures", () => {
  it("skips invalid items, counts them, ignores unknown fields", async () => {
    const files = { "latest.json": { items: [
      itemFile(idN(1), { brand_new_field: { a: 1 } }),
      { id: "nope", title: "x" },
      itemFile(idN(2), { canonical_url: "javascript:alert(1)" }),
      itemFile(idN(3), { published_at: "yesterday" }),
      "garbage",
    ] } };
    const r = await run({}, makeFetch({ files }));
    expect(ids(r)).toEqual([idN(1)]);
    expect(r.skipped_invalid_items).toBe(4);
  });
  it.each([
    ["HTTP 503", { "latest.json": 503 }],
    ["invalid JSON", { "latest.json": "{not json" }],
  ])("upstream %s -> upstream_unavailable", async (_n, files) => {
    await expect(run({}, makeFetch({ files }))).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
  it("a network failure -> upstream_unavailable without detail", async () => {
    const fx = { ...makeFetch(), fetch: async () => { throw new Error("ECONNRESET internal.host:1234"); } };
    const err = await getUpdates(deps(fx as never), TEST_ENV, GetUpdatesInput.parse({})).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).not.toContain("internal.host");
    expect(err).toMatchObject({ code: "upstream_unavailable" });
  });
  it("a feed without an items list yields an empty result, not an error", async () => {
    expect((await run({}, makeFetch({ files: { "latest.json": { items: "x" } } }))).count).toBe(0);
  });
});

describe("FeedReader", () => {
  const reader = (fx = makeFetch()) => new FeedReader(FEED, fx.fetch);
  it.each(["../meta.json", "tags/../../x.json", "tags/Bad_Slug.json", "items/XYZ.json", "https://evil.example/x", "tags/a/b.json", "meta.json?x=1", ""])(
    "refuses the path %j before any request",
    async (rel) => {
      const fx = makeFetch();
      await expect(reader(fx).read(rel)).rejects.toMatchObject({ code: "internal_error" });
      expect(fx.calls).toHaveLength(0);
    },
  );
  it("sends a plain GET with edge-cache options and nothing sensitive", async () => {
    const fx = makeFetch();
    await reader(fx).read("latest.json");
    const call = fx.feed()[0];
    expect(call?.method).toBe("GET");
    expect(Object.keys(call?.headers ?? {})).toEqual(["accept"]);
    expect((call?.init as { cf?: unknown }).cf).toEqual({ cacheTtl: 300, cacheEverything: true });
  });
  it("404 and 410 are 'missing'", async () => {
    expect(await reader(makeFetch({ files: { "latest.json": 410 } })).read("latest.json")).toEqual({ status: "missing" });
    expect(await reader().read("tags/robotics.json")).toEqual({ status: "missing" });
  });
  it("rejects an oversized declared body", async () => {
    const big = async () => new Response("{}", { status: 200, headers: { "content-length": "9000000" } });
    await expect(new FeedReader(FEED, big).read("latest.json")).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});

describe("parsing helpers", () => {
  it("entitySlug follows the template rule", () => {
    expect(entitySlug("llama.cpp")).toBe("llama-cpp");
    expect(entitySlug("Hugging Face Transformers")).toBe("hugging-face-transformers");
    expect(entitySlug("github:ollama/ollama")).toBe("github-ollama-ollama");
    expect(entitySlug("!!!")).toBeNull();
  });
  it("generatedAt accepts only ISO strings", () => {
    expect(generatedAt({ generated_at: "2026-10-20T03:47:55.762003Z" })).not.toBeNull();
    expect(generatedAt({ generated_at: "soon" })).toBeNull();
    expect(generatedAt(null)).toBeNull();
  });
  it("parseItemFile and parseItems validate", () => {
    expect(parseItemFile(itemFile(idN(1)))?.id).toBe(idN(1));
    expect(parseItemFile({})).toBeNull();
    expect(parseItems({ items: [itemFile(idN(1)), 5] })).toMatchObject({ skipped: 1 });
  });
});

describe("config and budget", () => {
  it("accepts https and loopback http, rejects everything else", () => {
    expect(feedBase({ FEED_BASE: "https://a.example/feed/" })).toBe("https://a.example/feed");
    expect(feedBase({ FEED_BASE: "http://localhost:8788" })).toBe("http://localhost:8788");
    for (const bad of ["http://evil.example/feed", "ftp://x", "https://u:p@x.example", "https://x.example/?q=1", "https://axon.<account>.workers.dev", ""]) {
      expect(() => feedBase({ FEED_BASE: bad })).toThrow(/not configured/);
    }
    expect(() => feedBase({})).toThrow(/not configured/);
    expect(() => publicUrl({ PUBLIC_URL: "nonsense" })).toThrow();
  });
  it("only known providers pass the allow-list", () => {
    expect(allowedProviders({ ALLOWED_PROVIDERS: " DeepSeek , evil, huggingface" })).toEqual(["deepseek", "huggingface"]);
    expect(allowedProviders({})).toEqual([]);
  });
  it("hf default model is validated", () => {
    expect(hfDefaultModel({ HF_DEFAULT_MODEL: "org/model:fast" })).toBe("org/model:fast");
    expect(hfDefaultModel({ HF_DEFAULT_MODEL: "../etc" })).toBe("openai/gpt-oss-120b");
  });
  it("the budget refuses the 46th request", async () => {
    const fx = makeFetch();
    const b = new SubrequestBudget();
    const f = budgeted(fx.fetch, b);
    for (let i = 0; i < 45; i++) await f(`${FEED}/meta.json`);
    await expect(f(`${FEED}/meta.json`)).rejects.toMatchObject({ name: "BudgetExhaustedError" });
    expect(fx.calls).toHaveLength(45);
  });
  it("mapPool keeps order and never exceeds the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      await Promise.resolve();
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
  it("max Tier 1 request stays under the subrequest limit (10 topics + 10 entities)", async () => {
    const fx = makeFetch();
    await run({ topics: ["llm-releases", "open-source-llms", "small-local-models", "multimodal", "agents-tooling", "rag", "fine-tuning-training", "research-papers", "mlops-infra", "ai-hardware"], entities: Array.from({ length: 10 }, (_, i) => `e${i}`) }, fx);
    expect(fx.calls.length).toBeLessThanOrEqual(22);
  });
});
