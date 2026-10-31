import { describe, expect, it } from "vitest";
import { GatewayError } from "../src/errors";
import { PROVIDER_BASE_URLS, ProviderClient, deprecationWarning } from "../src/providers";
import { BadResponseError } from "../src/summarizer/types";
import { KEY, chat, makeFetch, type ProviderHandler } from "./helpers";

function client(handler: ProviderHandler, provider: "deepseek" | "huggingface" = "deepseek", model = "deepseek-v4-flash") {
  const fx = makeFetch({ provider: handler });
  const sleeps: number[] = [];
  const c = new ProviderClient({ provider, model, key: KEY, fetch: fx.fetch, sleep: async (ms) => void sleeps.push(ms), rng: () => 0.5 });
  return { c, fx, sleeps };
}
const text = '{"ok":true}';

describe("request shape", () => {
  it("deepseek: fixed URL, bearer header, JSON mode, thinking disabled for v4", async () => {
    const { c, fx } = client(() => chat(text));
    await c.complete("SYS", "USER");
    const call = fx.provider()[0];
    expect(call?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call?.method).toBe("POST");
    expect(call?.headers["authorization"]).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "deepseek-v4-flash", max_tokens: 1500, temperature: 0.2, stream: false,
      response_format: { type: "json_object" }, thinking: { type: "disabled" },
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }],
    });
  });
  it("deepseek legacy model ids get no thinking flag", async () => {
    const { c, fx } = client(() => chat(text), "deepseek", "deepseek-chat");
    await c.complete("s", "u");
    expect(JSON.parse(fx.provider()[0]?.body ?? "{}")).not.toHaveProperty("thinking");
  });
  it("huggingface: router URL, no thinking flag", async () => {
    const { c, fx } = client(() => chat(text), "huggingface", "openai/gpt-oss-120b");
    await c.complete("s", "u");
    expect(fx.provider()[0]?.url).toBe("https://router.huggingface.co/v1/chat/completions");
    expect(JSON.parse(fx.provider()[0]?.body ?? "{}")).not.toHaveProperty("thinking");
  });
  it("the only provider hosts are the two fixed ones", () => {
    expect(Object.values(PROVIDER_BASE_URLS)).toEqual(["https://api.deepseek.com", "https://router.huggingface.co/v1"]);
  });
  it("never follows redirects (the key must not travel elsewhere)", async () => {
    const { c, fx } = client(() => chat(text));
    await c.complete("s", "u");
    expect(fx.provider()[0]?.init?.redirect).toBe("manual");
  });
  it("parses text and token usage", async () => {
    const { c } = client(() => chat(text));
    expect(await c.complete("s", "u")).toEqual({ text, usage: { prompt_tokens: 100, completion_tokens: 50, calls: 1 } });
  });
});

describe("JSON mode fallback", () => {
  it.each([400, 422])("HTTP %s retries once without response_format and remembers it", async (status) => {
    const { c, fx } = client((_c, n) => (n === 0 ? new Response("no", { status }) : chat(text)));
    await c.complete("s", "u");
    await c.complete("s", "u");
    const bodies = fx.provider().map((p) => JSON.parse(p.body) as Record<string, unknown>);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toHaveProperty("response_format");
    expect(bodies[1]).not.toHaveProperty("response_format");
    expect(bodies[2]).not.toHaveProperty("response_format");
  });
  it("a second 400 is a bad response, not an endless loop", async () => {
    const { c, fx } = client(() => new Response("no", { status: 400 }));
    await expect(c.complete("s", "u")).rejects.toBeInstanceOf(BadResponseError);
    expect(fx.provider()).toHaveLength(2);
  });
});

describe("error mapping (spec 6.4, 8.5)", () => {
  it.each([[401], [403]])("HTTP %s -> llm_key_invalid, no retry", async (status) => {
    const { c, fx } = client(() => new Response("bad key", { status }));
    await expect(c.complete("s", "u")).rejects.toMatchObject({ code: "llm_key_invalid" });
    expect(fx.provider()).toHaveLength(1);
  });
  it("HTTP 402 -> llm_quota, no retry", async () => {
    const { c, fx } = client(() => new Response("pay", { status: 402 }));
    await expect(c.complete("s", "u")).rejects.toMatchObject({ code: "llm_quota" });
    expect(fx.provider()).toHaveLength(1);
  });
  it.each([[429], [500], [502], [503]])("HTTP %s -> upstream_unavailable after 3 attempts", async (status) => {
    const { c, fx } = client(() => new Response("x", { status }));
    await expect(c.complete("s", "u")).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(fx.provider()).toHaveLength(3);
  });
  it("recovers when a retry succeeds", async () => {
    const { c, fx } = client((_c, n) => (n < 2 ? new Response("x", { status: 503 }) : chat(text)));
    expect((await c.complete("s", "u")).text).toBe(text);
    expect(fx.provider()).toHaveLength(3);
  });
  it("network errors are retried then upstream_unavailable", async () => {
    const { c, fx } = client(() => { throw new Error(`socket closed while sending ${KEY}`); });
    await expect(c.complete("s", "u")).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(fx.provider()).toHaveLength(3);
  });
  it("honors Retry-After but caps it at 5 seconds", async () => {
    const { c, sleeps } = client((_c, n) => (n === 0 ? new Response("x", { status: 429, headers: { "retry-after": "120" } }) : chat(text)));
    await c.complete("s", "u");
    expect(sleeps).toEqual([5000]);
  });
  it("backs off with jitter on 5xx", async () => {
    const { c, sleeps } = client((_c, n) => (n < 2 ? new Response("x", { status: 500 }) : chat(text)));
    await c.complete("s", "u");
    expect(sleeps).toEqual([1000, 2000]); // min(4, 2^attempt * 0.5) * (0.5 + 0.5)
  });
  it.each([
    ["not JSON", () => new Response("<html>", { status: 200 })],
    ["no choices", () => new Response("{}", { status: 200 })],
    ["empty content", () => chat("   ")],
    ["non-string content", () => new Response(JSON.stringify({ choices: [{ message: { content: 5 } }] }), { status: 200 })],
    ["truncated output", () => chat(text, 200, { finish_reason: "length" })],
    ["HTTP 404", () => new Response("nope", { status: 404 })],
  ])("%s -> BadResponseError", async (_n, make) => {
    const { c } = client(make);
    await expect(c.complete("s", "u")).rejects.toBeInstanceOf(BadResponseError);
  });
});

describe("the key never leaks", () => {
  const handlers: [string, ProviderHandler][] = [
    ["401", () => new Response(`invalid key ${KEY}`, { status: 401 })],
    ["402", () => new Response(`balance ${KEY}`, { status: 402 })],
    ["429", () => new Response(`slow down ${KEY}`, { status: 429 })],
    ["500", () => new Response(`oops ${KEY}`, { status: 500 })],
    ["400", () => new Response(`bad request ${KEY}`, { status: 400 })],
    ["network", () => { throw new Error(`failed for ${KEY}`); }],
    ["malformed", () => new Response(`{"choices":[{"message":{"content":"${KEY}"}}`, { status: 200 })],
  ];
  it.each(handlers)("errors for %s contain no key and no header text", async (_n, handler) => {
    const { c } = client(handler);
    const err = await c.complete("s", "u").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const e = err as Error;
    expect(e.message).not.toContain(KEY);
    expect(e.message.toLowerCase()).not.toContain("authorization");
    expect(JSON.stringify(e)).not.toContain(KEY);
    expect(String(e.stack)).not.toContain(KEY);
    if (e instanceof GatewayError) expect(e.code).toMatch(/llm_|upstream/);
  });
  it("the client object does not expose the key when serialized or inspected", () => {
    const { c } = client(() => chat(text));
    expect(JSON.stringify(c)).not.toContain(KEY);
    expect(Object.keys(c)).not.toContain("key");
    expect(String(Object.getOwnPropertyNames(c))).not.toContain("key");
  });
});

describe("deprecation warning", () => {
  it.each(["deepseek-chat", "deepseek-reasoner"])("%s is flagged", (m) => expect(deprecationWarning("deepseek", m)).toContain("retired"));
  it("current ids and other providers are not", () => {
    expect(deprecationWarning("deepseek", "deepseek-v4-flash")).toBeNull();
    expect(deprecationWarning("huggingface", "deepseek-chat")).toBeNull();
  });
});
