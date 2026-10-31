// Registration and token store on Workers KV (spec 7.7, 9.2). Tokens are 256-bit random values shown
// once and stored only as SHA-256 hashes. Unknown, expired and revoked tokens look identical.
// KV is eventually consistent across locations: a revoked token can keep working elsewhere for up to
// about 60 seconds (Cloudflare's documented cache TTL; Appendix C 65). Within one location a revoke
// is immediate (a delete), which the tests assert.
import { z } from "zod";
import { GatewayError } from "./errors";
import { REPO_RE } from "./github/http";
import { b64url, randomBytes, sha256Hex, toHex } from "./util";

export interface Kv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; limit?: number }): Promise<{ keys: { name: string }[] }>;
}

export function kvOf(ns: KVNamespace): Kv {
  return {
    get: (k) => ns.get(k),
    put: (k, v, o) => ns.put(k, v, o),
    delete: (k) => ns.delete(k),
    list: async (o) => ({ keys: (await ns.list(o)).keys.map((x) => ({ name: x.name })) }),
  };
}

export const TOKEN_PREFIX = "axn_";
export const TOKEN_RE = /^axn_[A-Za-z0-9_-]{43}$/;
export const TOKEN_ID_RE = /^tk_[a-f0-9]{16}$/;
export const MAX_TOKENS_PER_REPO = 10;
export const DEFAULT_EXPIRY_DAYS = 90;

export const IssueInput = z.strictObject({
  label: z.string().regex(/^[A-Za-z0-9 ._-]{1,64}$/),
  expires_in_days: z.number().int().min(1).max(365).default(DEFAULT_EXPIRY_DAYS),
});
export const RegisterInput = z.strictObject({});

const Registration = z.strictObject({
  repo: z.string().regex(REPO_RE),
  repository_id: z.string(),
  installation_id: z.number().int().positive(),
  default_branch: z.string(),
  registered_at: z.iso.datetime({ offset: true }),
});
export type RegistrationRecord = z.infer<typeof Registration>;

export const TokenRecord = z.strictObject({
  id: z.string().regex(TOKEN_ID_RE),
  repo: z.string().regex(REPO_RE),
  installation_id: z.number().int().positive(),
  label: z.string(),
  scopes: z.array(z.literal("digest")),
  created_at: z.iso.datetime({ offset: true }),
  expires_at: z.iso.datetime({ offset: true }),
});
export type TokenRecordT = z.infer<typeof TokenRecord>;

const unauthorized = () => new GatewayError("auth_required", "A valid owner token is required.");

export class TokenStore {
  constructor(
    private readonly kv: Kv,
    private readonly now: () => Date,
  ) {}

  async register(rec: Omit<RegistrationRecord, "registered_at">): Promise<RegistrationRecord> {
    const full = Registration.parse({ ...rec, registered_at: this.now().toISOString() });
    await this.kv.put(`repo:${full.repo}`, JSON.stringify(full));
    return full;
  }

  async registration(repo: string): Promise<RegistrationRecord | null> {
    const raw = await this.kv.get(`repo:${repo}`);
    if (raw === null) return null;
    try {
      const p = Registration.safeParse(JSON.parse(raw));
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  }

  /** Returns the plaintext token exactly once; only its hash is stored. */
  async issue(reg: RegistrationRecord, label: string, days: number): Promise<{ token: string; record: TokenRecordT }> {
    const existing = await this.kv.list({ prefix: `tokid:${reg.repo}:`, limit: MAX_TOKENS_PER_REPO + 1 });
    if (existing.keys.length >= MAX_TOKENS_PER_REPO) {
      throw new GatewayError("policy_violation", `At most ${MAX_TOKENS_PER_REPO} active tokens per repository. Revoke one first.`);
    }
    const token = TOKEN_PREFIX + b64url(randomBytes(32));
    const hash = await sha256Hex(token);
    const created = this.now();
    const record: TokenRecordT = {
      id: "tk_" + toHex(randomBytes(8)),
      repo: reg.repo,
      installation_id: reg.installation_id,
      label,
      scopes: ["digest"],
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + days * 86_400_000).toISOString(),
    };
    const ttl = { expirationTtl: Math.max(60, days * 86_400) };
    await this.kv.put(`tok:${hash}`, JSON.stringify(record), ttl);
    await this.kv.put(`tokid:${reg.repo}:${record.id}`, hash, ttl);
    return { token, record };
  }

  /** null for unknown, malformed, expired or revoked: callers cannot tell which. */
  async lookup(token: string): Promise<TokenRecordT | null> {
    if (!TOKEN_RE.test(token)) return null;
    const raw = await this.kv.get(`tok:${await sha256Hex(token)}`);
    if (raw === null) return null;
    try {
      const p = TokenRecord.safeParse(JSON.parse(raw));
      if (!p.success || Date.parse(p.data.expires_at) <= this.now().getTime()) return null;
      return p.data;
    } catch {
      return null;
    }
  }

  async authenticate(header: string | null): Promise<TokenRecordT> {
    const m = header === null ? null : /^Bearer ([^\s]+)$/i.exec(header);
    const rec = m?.[1] ? await this.lookup(m[1]) : null;
    if (rec === null) throw unauthorized();
    return rec;
  }

  /** Revokes a token of `repo` only. */
  async revoke(repo: string, id: string): Promise<boolean> {
    if (!TOKEN_ID_RE.test(id)) return false;
    const hash = await this.kv.get(`tokid:${repo}:${id}`);
    if (hash === null) return false;
    const raw = await this.kv.get(`tok:${hash}`);
    if (raw !== null) {
      const p = TokenRecord.safeParse(JSON.parse(raw));
      if (p.success && p.data.repo !== repo) return false;
    }
    await this.kv.delete(`tok:${hash}`);
    await this.kv.delete(`tokid:${repo}:${id}`);
    return true;
  }
}
