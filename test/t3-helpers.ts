// Tier 3 test kit: fake KV (with a replica-lag switch), RSA keys in both PEM formats, OIDC token
// minting, and a mock GitHub that records every call and can inject failures. All offline.
import { generateKeyPairSync } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { createApp } from "../src/index";
import type { Env } from "../src/env";
import type { Kv } from "../src/tokens";
import { NOW, TEST_ENV, at } from "./helpers";

export const APP_ID = "424242";
export const REPO = "alice/axon-digest";
export const OTHER_REPO = "bob/other-digest";
export const INSTALLATION = 777001;
export const INSTALL_TOKEN = "ghs_UNIQUE_installation_token_55aa";
export const PUBLIC_URL = "https://gw.test";
export const ISSUER = "https://token.actions.githubusercontent.com";
export const JWKS_URL = `${ISSUER}/.well-known/jwks`;

export class FakeKv implements Kv {
  data = new Map<string, string>();
  ttls = new Map<string, number | undefined>();
  /** When set, reads come from this frozen replica (models eventual consistency in another location). */
  replica: Map<string, string> | null = null;
  ops = { get: 0, put: 0, delete: 0, list: 0 };
  async get(k: string) {
    this.ops.get++;
    return (this.replica ?? this.data).get(k) ?? null;
  }
  async put(k: string, v: string, o?: { expirationTtl?: number }) {
    this.ops.put++;
    this.data.set(k, v);
    this.ttls.set(k, o?.expirationTtl);
  }
  async delete(k: string) {
    this.ops.delete++;
    this.data.delete(k);
  }
  async list(o: { prefix: string; limit?: number }) {
    this.ops.list++;
    const keys = [...(this.replica ?? this.data).keys()].filter((k) => k.startsWith(o.prefix)).slice(0, o.limit ?? 1000);
    return { keys: keys.map((name) => ({ name })) };
  }
  freeze(): void {
    this.replica = new Map(this.data);
  }
  all(): string {
    return JSON.stringify([...this.data.entries()]);
  }
}

export type AppKeys = { pkcs1: string; pkcs8: string; publicJwk: JWK };
async function generateAppKeys(): Promise<AppKeys> {
  const k = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    pkcs1: k.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    pkcs8: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicJwk: await exportJWK(k.publicKey),
  };
}
// RSA-2048 generation is the slowest part of a test kit (seconds on a loaded laptop). The key material
// is immutable test data, so one matched triple is shared by every kit in this test file's worker.
let appKeysOnce: Promise<AppKeys> | undefined;
/** A matched PKCS#1 + PKCS#8 + public JWK triple of the same RSA key. */
export function appKeyBoth(): Promise<AppKeys> {
  return (appKeysOnce ??= generateAppKeys());
}

export type Oidc = { kid: string; privateKey: CryptoKey; jwks: { keys: JWK[] } };
const oidcKits = new Map<string, Promise<Oidc>>();
async function generateOidcKit(kid: string, alg: string, withAlg: boolean): Promise<Oidc> {
  const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, ...(withAlg ? { alg, use: "sig" } : {}) };
  return { kid, privateKey, jwks: { keys: [jwk] } };
}
/** Shared per (kid, alg, withAlg): the same reasoning as appKeyBoth. Tests that need a DIFFERENT key use another kid. */
export function oidcKit(kid = "kid-1", alg = "RS256", withAlg = true): Promise<Oidc> {
  const id = `${kid}|${alg}|${String(withAlg)}`;
  let kit = oidcKits.get(id);
  if (kit === undefined) {
    kit = generateOidcKit(kid, alg, withAlg);
    oidcKits.set(id, kit);
  }
  return kit;
}

export type ClaimOver = Record<string, unknown>;
export async function mintOidc(kit: Oidc, workflow: string, over: ClaimOver = {}, opts: { alg?: string; key?: CryptoKey | Uint8Array; kid?: string; aud?: string; iss?: string; iatOffset?: number; expOffset?: number } = {}): Promise<string> {
  const sec = Math.floor(NOW.getTime() / 1000);
  const claims = {
    repository: REPO,
    repository_id: "9001",
    repository_owner: REPO.split("/")[0],
    event_name: "workflow_dispatch",
    job_workflow_ref: `${REPO}/.github/workflows/${workflow}@refs/heads/main`,
    ...over,
  };
  let jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? kit.kid })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? PUBLIC_URL)
    .setIssuedAt(sec + (opts.iatOffset ?? 0))
    .setExpirationTime(sec + (opts.expOffset ?? 300));
  jwt = jwt.setJti("jti-1");
  return await jwt.sign((opts.key ?? kit.privateKey) as CryptoKey);
}

export type GhCall = { method: string; url: string; path: string; headers: Record<string, string>; body: unknown };
export type Run = { id: number; status: string; conclusion: string | null; display_title: string; event: string; created_at: string; updated_at: string };

export type MockGh = ReturnType<typeof mockGithub>;
export function mockGithub(opts: { appKey: { publicJwk: JWK }; oidc: Oidc; installed?: boolean }) {
  const calls: GhCall[] = [];
  const state = {
    installed: opts.installed ?? true,
    jwks: opts.oidc.jwks as { keys: JWK[] },
    jwksFetches: 0,
    defaultBranch: "main",
    files: new Map<string, string>(), // "<ref>:<path>" -> text
    runs: [] as Run[],
    nextRunId: 5000,
    fail: [] as { match: RegExp; status: number; body?: string }[],
    dispatchStatus: 204,
    listBody: null as unknown,
    hostile: new Set<string>(),
  };
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

  async function appJwtOk(auth: string): Promise<boolean> {
    const { jwtVerify, importJWK } = await import("jose");
    try {
      const key = await importJWK({ ...opts.appKey.publicJwk, alg: "RS256" }, "RS256");
      const { payload } = await jwtVerify(auth.replace(/^Bearer /, ""), key, { issuer: APP_ID, algorithms: ["RS256"], currentDate: NOW });
      return typeof payload.exp === "number" && typeof payload.iat === "number" && payload.exp - payload.iat <= 600 + 60;
    } catch {
      return false;
    }
  }

  const f = async (input: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const method = init?.method ?? "GET";
    const path = u.pathname + u.search;
    calls.push({ method, url: input, path, headers, body });
    const injected = state.fail.find((x) => x.match.test(`${method} ${path}`));
    if (injected) return new Response(injected.body ?? "", { status: injected.status });
    if (input === JWKS_URL) {
      state.jwksFetches++;
      return json(state.jwks);
    }
    if (u.host !== "api.github.com") throw new Error("unexpected outbound host: " + u.host);
    const auth = headers["authorization"] ?? "";
    let m: RegExpExecArray | null;
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/installation$/.exec(u.pathname))) {
      if (!(await appJwtOk(auth))) return json({ message: "Bad credentials" }, 401);
      return state.installed ? json({ id: INSTALLATION }) : json({ message: "Not Found" }, 404);
    }
    if ((m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(u.pathname))) {
      if (!(await appJwtOk(auth))) return json({ message: "Bad credentials" }, 401);
      return json({ token: INSTALL_TOKEN, expires_at: new Date(NOW.getTime() + 3_600_000).toISOString() }, 201);
    }
    if (auth !== `Bearer ${INSTALL_TOKEN}`) return json({ message: "Bad credentials" }, 401);
    if ((m = /^\/repos\/([^/]+\/[^/]+)$/.exec(u.pathname))) return json({ default_branch: state.defaultBranch });
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(u.pathname))) {
      const text = state.files.get(`${u.searchParams.get("ref")}:${decodeURIComponent(m[2] as string)}`);
      return text === undefined ? json({ message: "Not Found" }, 404) : new Response(text, { status: 200 });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/digest\.yml\/dispatches$/.exec(u.pathname))) {
      if (m[1] !== REPO) return json({ message: "Not Found" }, 404);
      if (state.dispatchStatus === 204) {
        const inputs = (body as { inputs: { task_id: string } }).inputs;
        state.runs.push({ id: state.nextRunId++, status: "queued", conclusion: null, display_title: `digest task ${inputs.task_id}`, event: "workflow_dispatch", created_at: NOW.toISOString(), updated_at: NOW.toISOString() });
      }
      return new Response(null, { status: state.dispatchStatus });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/digest\.yml\/runs$/.exec(u.pathname))) {
      if (m[1] !== REPO) return json({ total_count: 0, workflow_runs: [] }); // runs are per repository
      return json(state.listBody ?? { total_count: state.runs.length, workflow_runs: state.runs });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/cancel$/.exec(u.pathname))) {
      const run = state.runs.find((r) => r.id === Number(m?.[2]));
      if (!run) return json({ message: "Not Found" }, 404);
      if (run.status === "completed") return json({ message: "Cannot cancel a workflow run that is completed." }, 409);
      run.status = "completed";
      run.conclusion = "cancelled";
      return json({}, 202);
    }
    return json({ message: "Not Found" }, 404);
  };
  return { fetch: f, calls, state, urls: () => calls.map((c) => c.url), forget: () => (calls.length = 0) };
}

export type Kit = Awaited<ReturnType<typeof makeKit>>;
export async function makeKit(over: { env?: Partial<Env>; pem?: "pkcs8" | "pkcs1"; extraDeps?: Record<string, unknown>; dropKv?: boolean } = {}) {
  const keys = await appKeyBoth();
  const oidc = await oidcKit();
  const gh = mockGithub({ appKey: keys, oidc });
  const kv = new FakeKv();
  let now = NOW;
  const env: Env = {
    ...TEST_ENV,
    PUBLIC_URL,
    TOKENS: kv as unknown as KVNamespace,
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY: over.pem === "pkcs1" ? keys.pkcs1 : keys.pkcs8,
    ...over.env,
  };
  if (over.dropKv) delete env.TOKENS;
  const deps = { fetch: gh.fetch, now: () => now, sleep: async () => undefined, rng: () => 0.5, nonce: () => "0123456789abcdef0123456789abcdef", ...over.extraDeps };
  const app = createApp(deps);
  const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown, e: Env = env) =>
    app.request(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) }, e);
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
  const oidcFor = async (wf: string, over2: ClaimOver = {}, o: Parameters<typeof mintOidc>[3] = {}) => bearer(await mintOidc(oidc, wf, over2, o));
  const register = () => oidcFor("register.yml").then((h) => call("POST", "/register", h, {}));
  const issue = async (label = "my agent", days?: number) => {
    const res = await call("POST", "/tokens", await oidcFor("issue-token.yml"), { label, ...(days !== undefined ? { expires_in_days: days } : {}) });
    const body = (await res.json()) as unknown;
    return { res, body, token: (at(body, "token") as string | undefined) ?? "", id: (at(body, "id") as string | undefined) ?? "" };
  };
  const rpc = (method: string, params: unknown, headers: Record<string, string> = {}, id: string | number = "1") => call("POST", "/a2a", headers, { jsonrpc: "2.0", id, method, params });
  const send = (data: Record<string, unknown>, headers: Record<string, string> = {}) => rpc("message/send", { message: { role: "user", messageId: "m-1", parts: [{ kind: "data", data }] } }, headers);
  const setNow = (d: Date) => (now = d);
  /** Registers and issues a token; returns it ready for use. */
  const ready = async () => {
    await register();
    return await issue();
  };
  return { keys, oidc, gh, kv, env, app, call, bearer, oidcFor, register, issue, rpc, send, setNow, ready, deps, getNow: () => now };
}
export { NOW, at };
