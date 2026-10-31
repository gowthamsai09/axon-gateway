import { describe, expect, it } from "vitest";
import type { RateLimitBinding } from "../src/env";
import { GatewayError } from "../src/errors";
import { Limiter, clientKey } from "../src/ratelimit";
import { TEST_ENV, at, bodyOf, makeApp, makeFetch, post, sendMsg } from "./helpers";

const rl = (fn: RateLimitBinding["limit"]): RateLimitBinding => ({ limit: fn });

describe("Limiter", () => {
  it("fallback counter allows the limit then refuses, per key", async () => {
    const t = 0;
    const l = new Limiter(3, 60, () => t);
    for (let i = 0; i < 3; i++) await l.check(undefined, "a");
    await expect(l.check(undefined, "a")).rejects.toMatchObject({ code: "rate_limited", retryAfter: 60 });
    await l.check(undefined, "b");
  });
  it("fallback window resets after the period", async () => {
    let t = 0;
    const l = new Limiter(1, 60, () => t);
    await l.check(undefined, "a");
    await expect(l.check(undefined, "a")).rejects.toBeInstanceOf(GatewayError);
    t = 60_001;
    await l.check(undefined, "a");
  });
  it("uses the binding when present, passing the client key", async () => {
    const seen: string[] = [];
    const l = new Limiter(1, 60, () => 0);
    await l.check(rl(async ({ key }) => (seen.push(key), { success: true })), "ip-1");
    await l.check(rl(async ({ key }) => (seen.push(key), { success: true })), "ip-1");
    expect(seen).toEqual(["ip-1", "ip-1"]); // the binding decides, the fallback counter is not consulted
  });
  it("a binding that says no -> rate_limited", async () => {
    await expect(new Limiter(99, 60, () => 0).check(rl(async () => ({ success: false })), "x")).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("a binding that throws falls back to the in-isolate counter", async () => {
    const l = new Limiter(1, 60, () => 0);
    const broken = rl(async () => { throw new Error("binding down"); });
    await l.check(broken, "x");
    await expect(l.check(broken, "x")).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("bounds memory: a flood of keys cannot grow the table without limit", async () => {
    const l = new Limiter(1, 60, () => 0);
    for (let i = 0; i < 12_000; i++) await l.check(undefined, `k${i}`);
  });
  it("clientKey prefers CF-Connecting-IP and truncates", () => {
    expect(clientKey(new Request("https://x", { headers: { "cf-connecting-ip": "203.0.113.1" } }))).toBe("203.0.113.1");
    expect(clientKey(new Request("https://x"))).toBe("unknown");
    expect(clientKey(new Request("https://x", { headers: { "cf-connecting-ip": "a".repeat(200) } })).length).toBe(64);
  });
});

describe("rate limit bindings in the app", () => {
  it("RL_PUBLIC guards the card, a2a and mcp; the 429 tells when to retry", async () => {
    const env = { ...TEST_ENV, RL_PUBLIC: rl(async () => ({ success: false })) };
    const app = makeApp(makeFetch());
    for (const path of ["/.well-known/agent-card.json", "/a2a", "/mcp"]) {
      const res = path === "/a2a" ? await post(app, path, sendMsg({ skill: "get_ai_updates" }), {}, env) : await app.request(path, { method: path === "/mcp" ? "POST" : "GET", headers: { "content-type": "application/json" }, body: path === "/mcp" ? "{}" : null }, env);
      expect(res.status, path).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      expect(at(await bodyOf(res), "error.code")).toBe("rate_limited");
    }
  });
  it("healthz is never limited", async () => {
    const env = { ...TEST_ENV, RL_PUBLIC: rl(async () => ({ success: false })) };
    expect((await makeApp(makeFetch()).request("/healthz", {}, env)).status).toBe(200);
  });
  it("RL_SUMMARY guards Tier 2 only", async () => {
    const env = { ...TEST_ENV, RL_SUMMARY: rl(async () => ({ success: false })) };
    const app = makeApp(makeFetch());
    expect((await post(app, "/a2a", sendMsg({ skill: "get_ai_updates" }), {}, env)).status).toBe(200);
    const res = await post(app, "/a2a", sendMsg({ skill: "summarize_ai_updates", item_ids: ["6a23445afa1896da"] }), { "x-llm-provider": "deepseek", "x-llm-key": "sk-abcdefghijkl" }, env);
    expect(res.status).toBe(429);
  });
  it("the limited request never reaches the feed or a provider", async () => {
    const fx = makeFetch();
    await post(makeApp(fx), "/a2a", sendMsg({ skill: "get_ai_updates" }), {}, { ...TEST_ENV, RL_PUBLIC: rl(async () => ({ success: false })) });
    expect(fx.calls).toHaveLength(0);
  });
});
