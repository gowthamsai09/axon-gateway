import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { MAX_BODY_BYTES } from "../src/http";
import { TEST_ENV, at, bodyOf, makeApp, makeFetch, post, sendMsg } from "./helpers";

const fx = () => makeFetch();

describe("Agent Card", () => {
  it("serves the card for the implemented skills only, cacheable for an hour", async () => {
    const res = await makeApp(fx()).request("/.well-known/agent-card.json", {}, TEST_ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const card = await bodyOf(res);
    expect(at(card, "protocolVersion")).toBe("0.3.0");
    expect(at(card, "url")).toBe("https://gw.test/a2a");
    expect(at(card, "preferredTransport")).toBe("JSONRPC");
    expect(at(card, "capabilities")).toEqual({ streaming: false, pushNotifications: false, stateTransitionHistory: false });
    expect((at(card, "skills") as { id: string }[]).map((s) => s.id)).toEqual(["get_ai_updates", "summarize_ai_updates"]);
    expect(Object.keys(at(card, "securitySchemes") as object)).toEqual(["callerLlmKey"]);
    expect(JSON.stringify(card)).not.toMatch(/run_personal_digest|ownerBearer/);
  });
  it("uses PUBLIC_URL only, never the Host header", async () => {
    const res = await makeApp(fx()).request("https://attacker.example/.well-known/agent-card.json", { headers: { host: "attacker.example" } }, TEST_ENV);
    expect(at(await bodyOf(res), "url")).toBe("https://gw.test/a2a");
  });
  it("fails closed (500) when PUBLIC_URL is still a placeholder", async () => {
    const res = await makeApp(fx()).request("/.well-known/agent-card.json", {}, { ...TEST_ENV, PUBLIC_URL: "https://axon-gateway.<account>.workers.dev" });
    expect(res.status).toBe(500);
    expect(at(await bodyOf(res), "error.code")).toBe("internal_error");
  });
});

describe("request hygiene (a2a and mcp share it)", () => {
  const rpc = sendMsg({ skill: "get_ai_updates" });
  it.each(["/a2a", "/mcp"])("%s: wrong content type -> 415", async (path) => {
    const res = await post(makeApp(fx()), path, JSON.stringify(rpc), { "content-type": "text/plain" });
    expect(res.status).toBe(415);
    expect(at(await bodyOf(res), "error.code")).toBe("unsupported_media_type");
  });
  it.each(["/a2a", "/mcp"])("%s: accepts application/json with a charset", async (path) => {
    const res = await post(makeApp(fx()), path, { jsonrpc: "2.0", id: 1, method: "nope" }, { "content-type": "application/json; charset=utf-8" });
    expect(res.status).toBe(200);
  });
  it.each(["/a2a", "/mcp"])("%s: body over the cap (declared) -> 413", async (path) => {
    const res = await post(makeApp(fx()), path, "x", { "content-length": String(MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
  });
  it.each(["/a2a", "/mcp"])("%s: body over the cap (streamed) -> 413", async (path) => {
    const res = await post(makeApp(fx()), path, JSON.stringify({ pad: "x".repeat(MAX_BODY_BYTES + 10) }));
    expect(res.status).toBe(413);
    expect(at(await bodyOf(res), "error.code")).toBe("payload_too_large");
  });
  it.each(["/a2a", "/mcp"])("%s: invalid JSON -> JSON-RPC parse error", async (path) => {
    const res = await post(makeApp(fx()), path, "{not json");
    expect(res.status).toBe(400);
    expect(at(await bodyOf(res), "error.code")).toBe(-32700);
  });
  it.each(["/a2a", "/mcp"])("%s: empty body -> parse error", async (path) => {
    expect((await post(makeApp(fx()), path, "")).status).toBe(400);
  });
  it.each(["/a2a", "/mcp"])("%s: JSON-RPC batches are rejected with a clear error", async (path) => {
    const res = await post(makeApp(fx()), path, [rpc, rpc]);
    expect(res.status).toBe(400);
    expect(at(await bodyOf(res), "error.message")).toMatch(/batches are not supported/);
  });
  it.each([
    ["not an object", "5"],
    ["wrong version", JSON.stringify({ jsonrpc: "1.0", id: 1, method: "x" })],
    ["no method", JSON.stringify({ jsonrpc: "2.0", id: 1 })],
    ["fractional id", JSON.stringify({ jsonrpc: "2.0", id: 1.5, method: "x" })],
  ])("invalid envelope (%s) -> -32600", async (_n, body) => {
    const res = await post(makeApp(fx()), "/a2a", body);
    expect(res.status).toBe(400);
    expect(at(await bodyOf(res), "error.code")).toBe(-32600);
  });
  it("responses are never cached and carry nosniff", async () => {
    const res = await post(makeApp(fx()), "/a2a", rpc);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("sends no CORS headers (decision: server to server only)", async () => {
    const res = await post(makeApp(fx()), "/a2a", rpc, { origin: "https://page.example" });
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control"))).toEqual([]);
    const pre = await makeApp(fx()).request("/a2a", { method: "OPTIONS", headers: { origin: "https://page.example", "access-control-request-method": "POST" } }, TEST_ENV);
    expect(pre.status).toBe(405);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("Phase 4 routes", () => {
  it.each([["POST", "/register"], ["POST", "/tokens"], ["DELETE", "/tokens/tk_123"]])("%s %s -> stable 501", async (method, path) => {
    const res = await createApp().request(path, { method }, TEST_ENV);
    expect(res.status).toBe(501);
    expect(await bodyOf(res)).toEqual({ error: { code: "not_implemented", message: "Not available until Phase 4." } });
  });
  it("other methods on them are 405", async () => {
    expect((await createApp().request("/register", { method: "GET" }, TEST_ENV)).status).toBe(405);
  });
});

describe("failure containment", () => {
  it("an unexpected exception becomes a generic 500 with no detail", async () => {
    const boom = { ...makeFetch(), fetch: async () => { throw new TypeError("SECRET-INTERNAL-DETAIL"); } };
    const res = await post(makeApp(boom as never), "/a2a", sendMsg({ skill: "get_ai_updates" }));
    const text = await res.text();
    expect(text).not.toContain("SECRET-INTERNAL-DETAIL");
  });
  it("a misconfigured FEED_BASE is a generic 500 and never fetches", async () => {
    const f = makeFetch();
    const res = await post(makeApp(f), "/a2a", sendMsg({ skill: "get_ai_updates" }), {}, { ...TEST_ENV, FEED_BASE: "http://evil.example" });
    expect(res.status).toBe(500);
    expect(f.calls).toHaveLength(0);
  });
});
