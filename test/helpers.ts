import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp } from "../src/index";
import type { Env } from "../src/env";
import { SUMMARIZER_SYSTEM_PROMPT } from "../src/prompts/summarizer.generated";

export const FEED = "https://feed.test/feed";
export const FIXTURES = resolve("test/fixtures/feed-out");
export const NOW = new Date("2026-10-20T06:00:00Z");
export const NONCE = "0123456789abcdef0123456789abcdef";
export const KEY = "sk-UNIQUE-test-key-9f8e7d6c5b4a";
export const ITEM = "6a23445afa1896da";
export const ITEM_URL = "https://news.ycombinator.com/item?id=50154029";

export const TEST_ENV = {
  FEED_BASE: FEED,
  PUBLIC_URL: "https://gw.test",
  ALLOWED_PROVIDERS: "deepseek,huggingface",
} satisfies Env;

export type Call = { url: string; method: string; headers: Record<string, string>; body: string; init: RequestInit | undefined };
export type ProviderHandler = (call: Call, n: number) => Response | Promise<Response>;
export type Overrides = Record<string, unknown>; // rel path -> JSON value, or a number for an HTTP status

export function makeFetch(opts: { provider?: ProviderHandler; files?: Overrides; feedError?: boolean } = {}) {
  const calls: Call[] = [];
  let providerN = 0;
  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const call: Call = { url: input, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : "", init };
    calls.push(call);
    if (input.startsWith(FEED + "/")) {
      if (opts.feedError) return new Response("boom", { status: 503 });
      const rel = input.slice(FEED.length + 1);
      const o = opts.files?.[rel];
      if (typeof o === "number") return new Response("", { status: o });
      if (o !== undefined) return new Response(typeof o === "string" ? o : JSON.stringify(o), { status: 200 });
      const path = resolve(FIXTURES, rel);
      if (existsSync(path)) return new Response(readFileSync(path), { status: 200 });
      return new Response("not found", { status: 404 });
    }
    const host = new URL(input).host;
    if ((host === "api.deepseek.com" || host === "router.huggingface.co") && opts.provider) {
      return opts.provider(call, providerN++);
    }
    throw new Error("unexpected outbound host: " + host);
  };
  return {
    fetch: f,
    calls,
    feed: () => calls.filter((c) => c.url.startsWith(FEED)),
    provider: () => calls.filter((c) => !c.url.startsWith(FEED)),
  };
}
export type FakeFetch = ReturnType<typeof makeFetch>;

export const deps = (fx: FakeFetch, extra: Record<string, unknown> = {}) => ({
  fetch: fx.fetch,
  now: () => NOW,
  sleep: async () => undefined,
  rng: () => 0.5,
  nonce: () => NONCE,
  ...extra,
});
export const makeApp = (fx: FakeFetch, extra: Record<string, unknown> = {}) => createApp(deps(fx, extra));

export const chat = (content: unknown, status = 200, extra: Record<string, unknown> = {}): Response =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop", ...extra }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
    { status },
  );

export const goodSummary = (over: Record<string, unknown> = {}, url = ITEM_URL) => ({
  status: "ok",
  title: "Laminar launches flow-1",
  one_line: "Laminar released flow-1, a model trained with RL to find errors in agent traces.",
  key_points: ["The authors say it matches GPT-6-sol in detection quality while being 23x cheaper."],
  why_it_matters: "Agent builders get a cheaper way to find failing steps in traces.",
  tags: ["agents-tooling", "evals-benchmarks"],
  entities: ["Laminar"],
  notable_figures: [{ value: "23x", context: "cheaper than GPT-6-sol per the authors" }],
  source_url: url,
  injection_flag: false,
  ...over,
});

export const itemFile = (id: string, over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  id,
  url: `https://example.com/${id}`,
  canonical_url: `https://example.com/${id}`,
  title: `Item ${id}`,
  source_id: "example-blog",
  source_type: "rss",
  published_at: "2026-10-19T10:00:00Z",
  fetched_at: "2026-10-20T03:00:00Z",
  snippet: "A short snippet.",
  excerpt: "A longer excerpt about a model release with 42 tokens per second.",
  tags: ["llm-releases"],
  entities: [],
  signals: { stars: 0, points: 0, comments: 0 },
  also_covered_by: [],
  base_score: 0.5,
  ...over,
});

export const idN = (n: number): string => n.toString(16).padStart(16, "0");

/** Typed path access into parsed JSON: at(body, "result.artifacts.0.name"). */
export function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
export const bodyOf = async (res: Response): Promise<unknown> => (await res.json()) as unknown;
export const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}, env: Partial<Env> = TEST_ENV) =>
  app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) },
    env,
  );

export const sendMsg = (data: Record<string, unknown>, id: string | number = "1") => ({
  jsonrpc: "2.0",
  id,
  method: "message/send",
  params: { message: { role: "user", messageId: "m-1", parts: [{ kind: "data", data }] } },
});
export const llmHeaders = (extra: Record<string, string> = {}) => ({ "x-llm-provider": "deepseek", "x-llm-key": KEY, ...extra });
export const promptText = SUMMARIZER_SYSTEM_PROMPT;
