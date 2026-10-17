import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("gateway", () => {
  it("GET /healthz returns ok, uncached", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves nothing else in Phase 0", async () => {
    for (const [method, path] of [
      ["GET", "/"],
      ["POST", "/a2a"],
      ["POST", "/mcp"],
      ["GET", "/.well-known/agent-card.json"],
      ["POST", "/healthz"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });
});
