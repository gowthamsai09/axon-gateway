import { z } from "zod";
import { GatewayError } from "./errors";
import { ModelHeader } from "./schemas";

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Spec 7.2. Phase 4 values (GitHub App, KV) are optional until then.
export type Env = {
  TOKENS?: KVNamespace;
  RL_PUBLIC?: RateLimitBinding;
  RL_SUMMARY?: RateLimitBinding;
  RL_TIER3?: RateLimitBinding;
  FEED_BASE: string;
  PUBLIC_URL: string;
  ALLOWED_PROVIDERS: string;
  HF_DEFAULT_MODEL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  // Development only (Appendix C 66): honoured solely when ENVIRONMENT is "development".
  ENVIRONMENT?: string;
  GITHUB_API_BASE?: string;
  GITHUB_OIDC_ISSUER?: string;
  GITHUB_JWKS_URL?: string;
};

export const PROVIDER_NAMES = ["deepseek", "huggingface"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export const DEFAULT_HF_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const IPV4_LIKE = /^(?:0x[0-9a-f]+|\d+)(?:\.(?:0x[0-9a-f]+|\d+))*\.?$/i;
/** An IP address written as a host. The URL parser already turns 2130706433 or 0x7f.1 into dotted form. */
export const isIpLiteral = (host: string): boolean => host.startsWith("[") || IPV4_LIKE.test(host);

/** https, or http only for loopback (local `wrangler dev` with a local feed server). */
function baseUrl(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return null;
  if (url.hostname.includes("<") || url.hostname.includes(">")) return null;
  // An https base must be a DNS name: an IP literal (169.254.169.254, 10.0.0.1, [::1]) is never a feed host.
  if (url.protocol === "https:" && isIpLiteral(url.hostname)) return null;
  return value.replace(/\/+$/, "");
}

const misconfigured = () => new GatewayError("internal_error", "The gateway is not configured correctly.");

export function feedBase(env: Partial<Env>): string {
  const v = baseUrl(env.FEED_BASE);
  if (v === null) throw misconfigured();
  return v;
}

export function publicUrl(env: Partial<Env>): string {
  const v = baseUrl(env.PUBLIC_URL);
  if (v === null) throw misconfigured();
  return v;
}

export function allowedProviders(env: Partial<Env>): ProviderName[] {
  const wanted = (env.ALLOWED_PROVIDERS ?? "").split(",").map((s) => s.trim().toLowerCase());
  return PROVIDER_NAMES.filter((p) => wanted.includes(p));
}

const ModelId = z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/);
export function hfDefaultModel(env: Partial<Env>): string {
  const parsed = ModelId.safeParse(env.HF_DEFAULT_MODEL);
  return parsed.success && ModelHeader.safeParse(parsed.data).success ? parsed.data : DEFAULT_HF_MODEL;
}

// ---- Tier 3 configuration (Phase 4) ---------------------------------------------------------
export const GITHUB_API = "https://api.github.com";
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const isDev = (env: Partial<Env>): boolean => env.ENVIRONMENT === "development";

/** Tier 3 exists only when the KV namespace, the App id and the App key are all present. */
export function tier3Configured(env: Partial<Env>): boolean {
  return Boolean(env.TOKENS) && /^\d{1,20}$/.test(env.GITHUB_APP_ID ?? "") && Boolean(env.GITHUB_APP_PRIVATE_KEY);
}

/** Overrides for a local mock GitHub are ignored unless ENVIRONMENT is exactly "development". */
export const githubApiBase = (env: Partial<Env>): string => (isDev(env) ? (baseUrl(env.GITHUB_API_BASE) ?? GITHUB_API) : GITHUB_API);
export const oidcIssuer = (env: Partial<Env>): string => (isDev(env) ? (baseUrl(env.GITHUB_OIDC_ISSUER) ?? GITHUB_OIDC_ISSUER) : GITHUB_OIDC_ISSUER);
export const oidcJwksUrl = (env: Partial<Env>): string =>
  isDev(env) && baseUrl(env.GITHUB_JWKS_URL) !== null ? (baseUrl(env.GITHUB_JWKS_URL) as string) : `${oidcIssuer(env)}/.well-known/jwks`;
