// GitHub Actions OIDC verification (spec 9.2, 10.2). RS256 only, issuer, exact audience, expiry,
// token age, and the claims that bind the token to one repository and one workflow file.
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { isBudgetError, type FetchFn } from "../budget";
import { GatewayError } from "../errors";
import { REPO_RE } from "./http";

export const MAX_OIDC_TOKEN_CHARS = 6000;
export type OidcWorkflow = "register.yml" | "issue-token.yml" | "revoke-token.yml";
export type OidcClaims = { repository: string; repositoryId: string; owner: string };
export type OidcOptions = { issuer: string; audience: string; jwksUrl: string; fetch: FetchFn; now: Date; workflow: OidcWorkflow };

const Claims = z.object({
  repository: z.string().regex(REPO_RE),
  repository_id: z.string().regex(/^\d{1,20}$/),
  repository_owner: z.string().min(1).max(100),
  event_name: z.string(),
  job_workflow_ref: z.string().max(400),
});

const denied = () => new GatewayError("auth_required", "The identity token could not be verified.");
const JwksShape = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(20) });

async function loadJwks(o: OidcOptions, refresh: boolean): Promise<JSONWebKeySet> {
  let resp: Response;
  try {
    resp = await o.fetch(o.jwksUrl, { method: "GET", headers: { accept: "application/json" }, cf: refresh ? { cacheTtl: 0 } : { cacheTtl: 300, cacheEverything: true } });
  } catch (e) {
    if (isBudgetError(e)) throw e;
    throw new GatewayError("upstream_unavailable", "GitHub could not be reached.");
  }
  if (resp.status !== 200) throw new GatewayError("upstream_unavailable", "GitHub could not be reached.");
  const text = await resp.text();
  if (text.length > 100_000) throw new GatewayError("upstream_unavailable", "GitHub returned too much data.");
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("upstream_unavailable", "GitHub returned unreadable data.");
  }
  const shape = JwksShape.safeParse(data);
  if (!shape.success) throw new GatewayError("upstream_unavailable", "GitHub returned unreadable data.");
  return data as JSONWebKeySet;
}

export async function verifyOidc(token: string, o: OidcOptions): Promise<OidcClaims> {
  if (token.length === 0 || token.length > MAX_OIDC_TOKEN_CHARS || token.split(".").length !== 3) throw denied();
  const verify = async (jwks: JSONWebKeySet) =>
    await jwtVerify(token, createLocalJWKSet(jwks), { issuer: o.issuer, audience: o.audience, algorithms: ["RS256"], clockTolerance: 30, maxTokenAge: "15m", currentDate: o.now });
  let payload;
  try {
    try {
      payload = (await verify(await loadJwks(o, false))).payload;
    } catch (e) {
      if (!(e instanceof errors.JWKSNoMatchingKey)) throw e;
      payload = (await verify(await loadJwks(o, true))).payload; // one refresh for a rotated key, never a loop
    }
  } catch (e) {
    if (e instanceof GatewayError || isBudgetError(e)) throw e;
    throw denied();
  }
  const c = Claims.safeParse(payload);
  if (!c.success) throw denied();
  const { repository, repository_id, repository_owner, event_name, job_workflow_ref } = c.data;
  if (repository.split("/")[0] !== repository_owner) throw denied();
  if (event_name !== "workflow_dispatch") throw denied();
  // The workflow code must come from the same repository and be the file this route expects.
  if (!job_workflow_ref.startsWith(`${repository}/.github/workflows/${o.workflow}@refs/`)) throw denied();
  return { repository, repositoryId: repository_id, owner: repository_owner };
}
