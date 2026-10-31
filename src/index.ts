import { Hono, type Context } from "hono";
import type { AdapterCtx } from "./adapter";
import { handleA2A } from "./a2a";
import { buildAgentCard } from "./agentcard";
import { defaultDeps, type Deps } from "./core/deps";
import { publicUrl, tier3Configured, type Env } from "./env";
import { InstallationCache } from "./github/app";
import { handleIssueToken, handleRegister, handleRevokeToken } from "./register";
import { GatewayError } from "./errors";
import { errorResponse, json } from "./http";
import { handleMcp } from "./mcp";
import { clientKey, createLimiters } from "./ratelimit";

export type { Env } from "./env";

type App = Hono<{ Bindings: Env }>;

/** Spec 7.4. Routes only; protocol logic lives in the adapters and the core. */
export function createApp(overrides: Partial<Deps> = {}): App {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const limiters = createLimiters(() => deps.now().getTime());
  const cache = new InstallationCache();
  const app: App = new Hono<{ Bindings: Env }>();

  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
  });
  // No CORS headers on purpose (Appendix C 52): agents call server to server, and a browser page
  // must never be able to send a caller key through this Worker.
  app.onError((err) => errorResponse(err instanceof GatewayError ? err : new GatewayError("internal_error", "Internal error.")));
  app.notFound(() => errorResponse(new GatewayError("not_found", "Not found.")));

  const methodNotAllowed = (allow: string) =>
    new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "Method not allowed." } }), {
      status: 405,
      headers: { allow, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  const only = (method: string, handler: (c: Context<{ Bindings: Env }>) => Promise<Response> | Response) =>
    async (c: Context<{ Bindings: Env }>) => (c.req.method === method ? handler(c) : methodNotAllowed(method));
  const ctxFor = (c: Context<{ Bindings: Env }>): AdapterCtx => ({ deps, limiters, ip: clientKey(c.req.raw), cache });
  const limited = async (c: Context<{ Bindings: Env }>): Promise<AdapterCtx> => {
    const ctx = ctxFor(c);
    await limiters.pub.check(c.env?.RL_PUBLIC, ctx.ip);
    return ctx;
  };

  app.all("/healthz", only("GET", (c) => {
    c.header("Cache-Control", "no-store");
    return c.text("ok");
  }));

  app.all("/.well-known/agent-card.json", only("GET", async (c) => {
    await limited(c);
    return json(buildAgentCard(publicUrl(c.env), { tier3: tier3Configured(c.env) }), 200, { "cache-control": "public, max-age=3600" });
  }));

  app.all("/a2a", only("POST", async (c) => handleA2A(c.req.raw, c.env, await limited(c))));
  app.all("/mcp", only("POST", async (c) => handleMcp(c.req.raw, c.env, await limited(c))));

  // Tier 3 routes are real only when KV, the App id and the App key are all configured; otherwise the
  // Phase 3 surface (a stable 501) is served unchanged. OIDC-authenticated routes share the public limit.
  const notYet = new GatewayError("not_implemented", "Not available until Phase 4.");
  app.all("/register", only("POST", async (c) => (tier3Configured(c.env) ? handleRegister(c.req.raw, c.env, await limited(c)) : errorResponse(notYet))));
  app.all("/tokens", only("POST", async (c) => (tier3Configured(c.env) ? handleIssueToken(c.req.raw, c.env, await limited(c)) : errorResponse(notYet))));
  app.all("/tokens/:id", only("DELETE", async (c) => (tier3Configured(c.env) ? handleRevokeToken(c.req.raw, c.env, await limited(c), c.req.param("id") ?? "") : errorResponse(notYet))));

  return app;
}

export default createApp();
