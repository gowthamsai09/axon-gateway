// GitHub App access (spec 9.1, 9.2). The private key is imported into a non-extractable CryptoKey and
// is never logged, returned or placed in an error. GitHub downloads keys as PKCS#1 ("BEGIN RSA PRIVATE
// KEY"); the spec said PKCS#8. Both are accepted: PKCS#1 is wrapped into PKCS#8 here (Appendix C 63).
import { SignJWT } from "jose";
import { z } from "zod";
import { GatewayError } from "../errors";
import { b64decode } from "../util";
import { assertRepo, failFor, ghRequest, parseJson, type Gh } from "./http";

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const derLen = (n: number): Uint8Array => (n < 128 ? Uint8Array.of(n) : n < 256 ? Uint8Array.of(0x81, n) : n < 65536 ? Uint8Array.of(0x82, n >> 8, n & 255) : Uint8Array.of(0x83, n >> 16, (n >> 8) & 255, n & 255));
const der = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLen(body.length), body);
};
const RSA_ALG_ID = der(0x30, Uint8Array.of(0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01), Uint8Array.of(0x05, 0x00));

export const pkcs1ToPkcs8 = (pkcs1: Uint8Array): Uint8Array => der(0x30, Uint8Array.of(0x02, 0x01, 0x00), RSA_ALG_ID, der(0x04, pkcs1));

const bad = () => new GatewayError("internal_error", "The gateway is not configured correctly.");

export function pemToPkcs8(pemText: string): Uint8Array {
  const pem = pemText.replace(/\\n/g, "\n").trim(); // wrangler secrets sometimes carry literal \n
  const m = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----([A-Za-z0-9+/=\s]+)-----END \1-----$/.exec(pem);
  if (m === null) throw bad();
  let raw: Uint8Array;
  try {
    raw = b64decode((m[2] ?? "").replace(/\s+/g, ""));
  } catch {
    throw bad();
  }
  return m[1] === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(raw) : raw;
}

let keyCache: { pem: string; key: Promise<CryptoKey> } | undefined;
export function importAppKey(pem: string): Promise<CryptoKey> {
  if (keyCache?.pem === pem) return keyCache.key;
  const key = crypto.subtle
    .importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
    .catch(() => {
      keyCache = undefined;
      throw bad();
    });
  keyCache = { pem, key };
  return key;
}

export const INSTALLATION_PERMISSIONS = { actions: "write", contents: "read", metadata: "read" } as const;

type CacheEntry = { token: string; expiresAt: number };
/** Installation tokens live in isolate memory only (never KV) for a few minutes. */
export class InstallationCache {
  readonly #map = new Map<string, CacheEntry>();
  get(key: string, nowMs: number): string | null {
    const e = this.#map.get(key);
    return e !== undefined && e.expiresAt - nowMs > 120_000 ? e.token : null;
  }
  set(key: string, token: string, expiresAt: number): void {
    if (this.#map.size >= 100) this.#map.clear();
    this.#map.set(key, { token, expiresAt });
  }
}

const Installation = z.object({ id: z.number().int().positive() });
const AccessToken = z.object({ token: z.string().min(10).max(500), expires_at: z.iso.datetime({ offset: true }) });
const RepoInfo = z.object({ default_branch: z.string().regex(/^[A-Za-z0-9._/-]{1,100}$/).refine((b) => !b.includes("..")) });

export class GithubApp {
  constructor(
    private readonly gh: Gh,
    private readonly appId: string,
    private readonly pem: string,
    private readonly now: () => Date,
    private readonly cache: InstallationCache,
  ) {}

  async appJwt(): Promise<string> {
    const key = await importAppKey(this.pem);
    const sec = Math.floor(this.now().getTime() / 1000);
    return await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(this.appId).setIssuedAt(sec - 60).setExpirationTime(sec + 9 * 60).sign(key);
  }

  /** Proves the App is installed on `repo` (spec 9.2 step 3). */
  async installationId(repo: string): Promise<number> {
    assertRepo(repo);
    const r = await ghRequest(this.gh, { method: "GET", path: `/repos/${repo}/installation`, token: await this.appJwt() });
    if (r.status !== 200) throw failFor(r.status);
    const p = Installation.safeParse(parseJson(r.text));
    if (!p.success) throw failFor(502);
    return p.data.id;
  }

  /** Down-scoped to one repository and the three permissions the design needs (spec 9.1). */
  async installationToken(installationId: number, repo: string): Promise<string> {
    assertRepo(repo);
    const name = repo.split("/")[1] as string;
    const cacheKey = `${installationId}:${repo}`;
    const hit = this.cache.get(cacheKey, this.now().getTime());
    if (hit !== null) return hit;
    const r = await ghRequest(this.gh, {
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      token: await this.appJwt(),
      body: { repositories: [name], permissions: INSTALLATION_PERMISSIONS },
    });
    if (r.status !== 201) throw failFor(r.status);
    const p = AccessToken.safeParse(parseJson(r.text));
    if (!p.success) throw failFor(502);
    this.cache.set(cacheKey, p.data.token, Date.parse(p.data.expires_at));
    return p.data.token;
  }

  async defaultBranch(token: string, repo: string): Promise<string> {
    assertRepo(repo);
    const r = await ghRequest(this.gh, { method: "GET", path: `/repos/${repo}`, token });
    if (r.status !== 200) throw failFor(r.status);
    const p = RepoInfo.safeParse(parseJson(r.text));
    if (!p.success) throw failFor(502);
    return p.data.default_branch;
  }
}
