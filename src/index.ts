import { Hono } from "hono";

// Spec 7.4. Phase 0 serves /healthz only; every other route is a later phase.
export type Env = {
  TOKENS: KVNamespace;
  RL_PUBLIC: unknown;
  RL_SUMMARY: unknown;
  FEED_BASE: string;
  PUBLIC_URL: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  ALLOWED_PROVIDERS: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/healthz", (c) => {
  c.header("Cache-Control", "no-store");
  return c.text("ok");
});

export default app;
