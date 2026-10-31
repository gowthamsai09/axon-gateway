// The only place that talks to the GitHub REST API. Paths come from validated builders; GitHub's
// answers are never echoed to callers (errors are mapped to short, neutral messages).
import { isBudgetError, type FetchFn } from "../budget";
import { GatewayError } from "../errors";

export const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
export const MAX_GH_BYTES = 1_000_000;
export type Gh = { fetch: FetchFn; base: string };
export type GhResponse = { status: number; text: string };

export function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo) || repo.includes("..")) throw new GatewayError("internal_error", "Invalid repository name.");
}

export async function ghRequest(
  gh: Gh,
  req: { method: "GET" | "POST"; path: string; token: string; body?: unknown; accept?: string; maxBytes?: number },
): Promise<GhResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${req.token}`,
    accept: req.accept ?? "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "axon-gateway",
  };
  const init: RequestInit = { method: req.method, headers, redirect: "manual" };
  if (req.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }
  let resp: Response;
  try {
    resp = await gh.fetch(gh.base + req.path, init);
  } catch (e) {
    if (isBudgetError(e)) throw e;
    throw new GatewayError("upstream_unavailable", "GitHub could not be reached.");
  }
  const cap = req.maxBytes ?? MAX_GH_BYTES;
  if (Number(resp.headers.get("content-length") ?? "0") > cap) {
    throw new GatewayError("upstream_unavailable", "GitHub returned too much data.");
  }
  let text: string;
  try {
    text = await resp.text();
  } catch {
    throw new GatewayError("upstream_unavailable", "GitHub returned unreadable data.");
  }
  if (text.length > cap) throw new GatewayError("upstream_unavailable", "GitHub returned too much data.");
  return { status: resp.status, text };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GatewayError("upstream_unavailable", "GitHub returned unreadable data.");
  }
}

/** Maps a failed GitHub status to a neutral error. 401/403/404 usually mean the App was uninstalled. */
export function failFor(status: number): GatewayError {
  if (status === 401 || status === 403 || status === 404) {
    return new GatewayError("upstream_unavailable", "The repository is not accessible to the gateway. Check that the GitHub App is still installed on it.");
  }
  if (status === 429) return new GatewayError("upstream_unavailable", "GitHub is rate limiting the gateway. Retry later.");
  return new GatewayError("upstream_unavailable", "GitHub returned an error. Retry later.");
}
