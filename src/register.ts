// OIDC-authenticated routes (spec 7.3, 9.2): /register, /tokens, /tokens/:id. The repository comes
// ONLY from the verified identity claims, never from the request.
import { SubrequestBudget, budgeted } from "./budget";
import type { AdapterCtx } from "./adapter";
import { oidcIssuer, oidcJwksUrl, publicUrl, type Env } from "./env";
import { GatewayError } from "./errors";
import { verifyOidc, type OidcClaims, type OidcWorkflow } from "./github/oidc";
import { MAX_BODY_BYTES, json, readJsonBody } from "./http";
import { IssueInput, RegisterInput, TOKEN_ID_RE } from "./tokens";
import { tier3Services } from "./tier3";
import { sha256Hex } from "./util";

async function claimsFrom(req: Request, env: Env, ctx: AdapterCtx, workflow: OidcWorkflow): Promise<OidcClaims> {
  const m = /^Bearer ([^\s]+)$/i.exec(req.headers.get("authorization") ?? "");
  if (m?.[1] === undefined) throw new GatewayError("auth_required", "A GitHub identity token is required.");
  return await verifyOidc(m[1], {
    issuer: oidcIssuer(env),
    audience: publicUrl(env),
    jwksUrl: oidcJwksUrl(env),
    fetch: budgeted(ctx.deps.fetch, new SubrequestBudget()),
    now: ctx.deps.now(),
    workflow,
  });
}

const bad = (what: string) => new GatewayError("invalid_params", `Invalid ${what}.`);

export async function handleRegister(req: Request, env: Env, ctx: AdapterCtx): Promise<Response> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const claims = await claimsFrom(req, env, ctx, "register.yml");
  if (body.kind !== "ok" || !RegisterInput.safeParse(body.value).success) throw bad("request body (send {})");
  const svc = tier3Services(env, ctx);
  const installationId = await svc.app.installationId(claims.repository); // proves the App is installed there
  const token = await svc.app.installationToken(installationId, claims.repository);
  const branch = await svc.app.defaultBranch(token, claims.repository);
  const reg = await svc.store.register({ repo: claims.repository, repository_id: claims.repositoryId, installation_id: installationId, default_branch: branch });
  const agentId = "ag_" + (await sha256Hex(`repository:${claims.repositoryId}`)).slice(0, 16);
  return json({ agent_id: agentId, repo: reg.repo, installation_id: reg.installation_id, default_branch: reg.default_branch, registered_at: reg.registered_at });
}

export async function handleIssueToken(req: Request, env: Env, ctx: AdapterCtx): Promise<Response> {
  const body = await readJsonBody(req, MAX_BODY_BYTES);
  const claims = await claimsFrom(req, env, ctx, "issue-token.yml");
  const input = body.kind === "ok" ? IssueInput.safeParse(body.value) : null;
  if (input === null || !input.success) throw bad("label or expires_in_days");
  const svc = tier3Services(env, ctx);
  const reg = await svc.store.registration(claims.repository);
  if (reg === null) throw new GatewayError("policy_violation", "This repository is not registered. Run the register workflow first.");
  const { token, record } = await svc.store.issue(reg, input.data.label, input.data.expires_in_days);
  return json({ token, id: record.id, label: record.label, scopes: record.scopes, expires_at: record.expires_at, notice: "Shown once. Copy it now; only a hash is stored." }, 201);
}

export async function handleRevokeToken(req: Request, env: Env, ctx: AdapterCtx, id: string): Promise<Response> {
  const claims = await claimsFrom(req, env, ctx, "revoke-token.yml");
  if (!TOKEN_ID_RE.test(id)) throw bad("token id");
  const svc = tier3Services(env, ctx);
  if (!(await svc.store.revoke(claims.repository, id))) throw new GatewayError("not_found", "Token not found.");
  return json({ revoked: true, id, note: "Revocation is immediate in the location that handled it and can take up to about a minute elsewhere." });
}
