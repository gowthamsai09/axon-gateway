import { describe, expect, it } from "vitest";
import app from "../src/index";

describe("gateway", () => {
  it("GET /healthz returns ok, uncached", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Phase 3 rewrite of the Phase 0 test "serves nothing else": the routes of spec 7.3 now exist,
  // so what must stay true is that unknown paths are 404 and known paths reject other methods.
  it("unknown paths are 404", async () => {
    for (const path of ["/", "/admin", "/a2a/extra", "/healthz/x", "/.well-known/other.json"]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
  it("known paths reject the wrong method with 405 and an Allow header", async () => {
    for (const [method, path, allow] of [
      ["POST", "/healthz", "GET"],
      ["GET", "/a2a", "POST"],
      ["GET", "/mcp", "POST"],
      ["POST", "/.well-known/agent-card.json", "GET"],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(405);
      expect(res.headers.get("allow")).toBe(allow);
    }
  });
});
