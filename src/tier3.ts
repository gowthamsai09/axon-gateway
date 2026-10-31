// Wiring for Tier 3: builds the GitHub clients with a fresh subrequest budget per request and turns a
// bearer token into the repository context. Used by the adapters and the registration routes.
import { SubrequestBudget, budgeted } from "./budget";
import type { AdapterCtx } from "./adapter";
import type { Tier3Ctx } from "./core/digest";
import { githubApiBase, type Env } from "./env";
import { GatewayError } from "./errors";
import { GithubApp } from "./github/app";
import type { Gh } from "./github/http";
import { TokenStore, kvOf } from "./tokens";

export type Tier3Services = { store: TokenStore; gh: Gh; app: GithubApp };

export function tier3Services(env: Env, ctx: AdapterCtx): Tier3Services {
  if (env.TOKENS === undefined || env.GITHUB_APP_ID === undefined || env.GITHUB_APP_PRIVATE_KEY === undefined) {
    throw new GatewayError("internal_error", "The gateway is not configured correctly.");
  }
  const budget = new SubrequestBudget();
  const gh: Gh = { fetch: budgeted(ctx.deps.fetch, budget), base: githubApiBase(env) };
  const app = new GithubApp(gh, env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, ctx.deps.now, ctx.cache);
  return { store: new TokenStore(kvOf(env.TOKENS), ctx.deps.now), gh, app };
}

/** Bearer token -> record -> registration. Every failure is the same `auth_required`. */
export async function authenticateTier3(req: Request, env: Env, ctx: AdapterCtx): Promise<Tier3Ctx> {
  const svc = tier3Services(env, ctx);
  const token = await svc.store.authenticate(req.headers.get("authorization"));
  await ctx.limiters.tier3.check(env.RL_TIER3, token.id);
  const reg = await svc.store.registration(token.repo);
  if (reg === null || reg.installation_id !== token.installation_id) {
    throw new GatewayError("auth_required", "A valid owner token is required.");
  }
  return { gh: svc.gh, app: svc.app, reg, token, deps: ctx.deps };
}
