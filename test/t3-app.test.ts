import { describe, expect, it } from "vitest";
import { UUID_V7, uuidv7, uuidv7Time } from "../src/util";
import { githubApiBase, oidcIssuer, oidcJwksUrl, tier3Configured } from "../src/env";
import { pemToPkcs8 } from "../src/github/app";
import { at, bodyOf } from "./helpers";
import { APP_ID, INSTALLATION, INSTALL_TOKEN, REPO, appKeyBoth, makeKit } from "./t3-helpers";
import { readFileSync } from "node:fs";

describe("GitHub App key handling", () => {
  it("loads a PKCS#8 key", async () => {
    const k = await makeKit({ pem: "pkcs8" });
    expect((await k.register()).status).toBe(200);
  });

  it("loads a PKCS#1 key (what GitHub downloads) by wrapping it", async () => {
    const k = await makeKit({ pem: "pkcs1" });
    expect(k.env.GITHUB_APP_PRIVATE_KEY).toContain("BEGIN RSA PRIVATE KEY");
    expect((await k.register()).status).toBe(200);
  });

  it("accepts a key whose newlines were stored as literal \\n", async () => {
    const keys = await appKeyBoth();
    const k = await makeKit({ env: { GITHUB_APP_PRIVATE_KEY: keys.pkcs1.replace(/\n/g, "\\n") } });
    // the mock verifies against its own key, so only the import itself is checked here
    expect(() => pemToPkcs8(keys.pkcs1.replace(/\n/g, "\\n"))).not.toThrow();
    void k;
  });

  it("wraps PKCS#1 into the same PKCS#8 bytes Node produces", async () => {
    const keys = await appKeyBoth();
    const fromPkcs1 = Buffer.from(pemToPkcs8(keys.pkcs1)).toString("hex");
    const fromPkcs8 = Buffer.from(pemToPkcs8(keys.pkcs8)).toString("hex");
    expect(fromPkcs1).toBe(fromPkcs8);
  });

  it.each(["", "not a pem", "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----", "-----BEGIN PRIVATE KEY-----\n!!!!\n-----END PRIVATE KEY-----"])(
    "a bad key gives a generic error that never contains the key text: %j",
    async (bad) => {
      const k = await makeKit({ env: { GITHUB_APP_PRIVATE_KEY: bad || " " } });
      const res = await k.register();
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toContain("internal_error");
      expect(text).not.toContain("BEGIN");
      expect(text).not.toContain("!!!!");
    },
  );

  it("never returns the private key or installation token in any response", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    const start = await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    const all = (await k.register().then((r) => r.text())) + (await start.text());
    expect(all).not.toContain(INSTALL_TOKEN);
    expect(all).not.toContain("PRIVATE KEY");
    expect(all).not.toContain(k.env.GITHUB_APP_PRIVATE_KEY as string);
  });
});

describe("GitHub App requests", () => {
  it("signs an App JWT (iss = app id, at most 10 minutes) that the mock verified", async () => {
    const k = await makeKit();
    await k.register();
    const apiCalls = k.gh.calls.filter((c) => c.path.includes("/installation") || c.path.includes("access_tokens"));
    expect(apiCalls).toHaveLength(2);
    const claims = JSON.parse(Buffer.from((apiCalls[0]?.headers["authorization"] ?? "").split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
    expect(claims["iss"]).toBe(APP_ID);
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBeLessThanOrEqual(660);
  });

  it("mints an installation token down-scoped to one repository and three permissions", async () => {
    const k = await makeKit();
    await k.register();
    const mint = k.gh.calls.find((c) => c.path === `/app/installations/${INSTALLATION}/access_tokens`);
    expect(mint?.body).toEqual({ repositories: ["axon-digest"], permissions: { actions: "write", contents: "read", metadata: "read" } });
  });

  it("caches the installation token in memory across requests", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    const before = k.gh.calls.filter((c) => c.path.includes("access_tokens")).length;
    for (let i = 0; i < 3; i++) await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    expect(k.gh.calls.filter((c) => c.path.includes("access_tokens")).length).toBe(before);
    expect([...k.kv.data.values()].join("")).not.toContain(INSTALL_TOKEN); // never in KV
  });

  it("mints a fresh installation token after the cached one is close to expiry", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.setNow(new Date(k.getNow().getTime() + 3_500_000)); // 100 s left on a 3600 s token
    await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    expect(k.gh.calls.filter((c) => c.path.includes("access_tokens")).length).toBe(2);
  });

  it("fails registration with a neutral message when the App is not installed", async () => {
    const k = await makeKit();
    k.gh.state.installed = false;
    const res = await k.register();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).toContain("upstream_unavailable");
    expect(text).not.toContain("Not Found");
    expect(k.kv.data.size).toBe(0);
  });

  it("fails a Tier 3 start with a clear message if the App was uninstalled later", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.setNow(new Date(k.getNow().getTime() + 3_500_000)); // the cached installation token has expired
    k.gh.state.fail.push({ match: /access_tokens/, status: 404 });
    const res = await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    const body = await bodyOf(res);
    expect(at(body, "result.status.state")).toBe("failed");
    expect(JSON.stringify(body)).toContain("still installed");
  });

  it("reads the default branch from GitHub, never from the caller", async () => {
    const k = await makeKit();
    k.gh.state.defaultBranch = "trunk";
    expect(at(await bodyOf(await k.register()), "default_branch")).toBe("trunk");
  });

  it("rejects a default branch with path tricks", async () => {
    const k = await makeKit();
    k.gh.state.defaultBranch = "../../evil";
    expect((await k.register()).status).toBe(502);
  });
});

describe("UUIDv7 task ids", () => {
  it("matches the template's lowercase UUID pattern and carries the time", () => {
    const now = Date.parse("2026-10-20T06:00:00Z");
    const id = uuidv7(now);
    expect(id).toMatch(UUID_V7);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uuidv7Time(id)).toBe(now);
  });
  it.each(["", "not-a-uuid", crypto.randomUUID(), "00000000-0000-4000-8000-000000000000", "0199A5B2-0000-7000-8000-000000000000"])("is not a v7 id: %j", (id) => {
    expect(uuidv7Time(id)).toBeNull();
  });
  it("is unique and time ordered", () => {
    const a = uuidv7(1_000_000_000_000);
    const b = uuidv7(1_000_000_000_001);
    expect(a < b).toBe(true);
    expect(uuidv7(5)).not.toBe(uuidv7(5));
  });
});

describe("configuration", () => {
  const base = { TOKENS: {} as unknown as KVNamespace, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "k" };
  const table: [Record<string, unknown>, boolean][] = [
    [{}, false],
    [{ ...base }, true],
    [{ ...base, TOKENS: undefined }, false],
    [{ ...base, GITHUB_APP_ID: undefined }, false],
    [{ ...base, GITHUB_APP_PRIVATE_KEY: undefined }, false],
    [{ ...base, GITHUB_APP_ID: "abc" }, false],
  ];
  it.each(table)("tier3Configured %#", (env, want) => expect(tier3Configured(env as never)).toBe(want));

  it("ignores the GitHub API and OIDC overrides unless ENVIRONMENT is exactly development", () => {
    const o = { GITHUB_API_BASE: "http://127.0.0.1:9", GITHUB_OIDC_ISSUER: "http://127.0.0.1:9", GITHUB_JWKS_URL: "http://127.0.0.1:9/jwks" };
    for (const environment of [undefined, "", "production", "Development", "dev"]) {
      const env = { ...o, ...(environment === undefined ? {} : { ENVIRONMENT: environment }) };
      expect(githubApiBase(env)).toBe("https://api.github.com");
      expect(oidcIssuer(env)).toBe("https://token.actions.githubusercontent.com");
      expect(oidcJwksUrl(env)).toBe("https://token.actions.githubusercontent.com/.well-known/jwks");
    }
    const dev = { ...o, ENVIRONMENT: "development" };
    expect(githubApiBase(dev)).toBe("http://127.0.0.1:9");
    expect(oidcJwksUrl(dev)).toBe("http://127.0.0.1:9/jwks");
  });

  it("only accepts https or loopback overrides, even in development", () => {
    expect(githubApiBase({ ENVIRONMENT: "development", GITHUB_API_BASE: "http://evil.example" })).toBe("https://api.github.com");
  });

  it("keeps the overrides out of wrangler.toml", () => {
    const toml = readFileSync("wrangler.toml", "utf8");
    for (const name of ["ENVIRONMENT", "GITHUB_API_BASE", "GITHUB_OIDC_ISSUER", "GITHUB_JWKS_URL"]) expect(toml.replace(/#.*$/gm, "")).not.toContain(name);
  });

  it("serves the Phase 3 501 on the Tier 3 routes when Tier 3 is not configured", async () => {
    const k = await makeKit({ dropKv: true });
    for (const [m, p] of [["POST", "/register"], ["POST", "/tokens"], ["DELETE", "/tokens/tk_0000000000000000"]] as const) {
      expect((await k.call(m, p, {}, m === "POST" ? {} : undefined)).status).toBe(501);
    }
  });

  it("is REPO-scoped in every outbound request of a full session", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    for (const c of k.gh.calls) {
      const u = new URL(c.url);
      expect(["api.github.com", "token.actions.githubusercontent.com"]).toContain(u.host);
      if (u.pathname.startsWith("/repos/")) expect(u.pathname.startsWith(`/repos/${REPO}`)).toBe(true);
    }
  });
});

describe("workerd compatibility", () => {
  it('never uses redirect: "error", which workerd rejects (found by running wrangler dev)', async () => {
    const { readdirSync, readFileSync: read, statSync } = await import("node:fs");
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(`${d}/${n}`).isDirectory() ? walk(`${d}/${n}`) : [`${d}/${n}`]));
    for (const f of walk("src").filter((x) => x.endsWith(".ts"))) expect(read(f, "utf8"), f).not.toMatch(/redirect:\s*["']error["']/);
  });

  it('sends redirect: "manual" to GitHub and treats a 3xx as a neutral failure', async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    expect(k.gh.calls.filter((c) => c.url.startsWith("https://api.github.com"))).not.toHaveLength(0);
    k.setNow(new Date(k.getNow().getTime() + 3_500_000));
    k.gh.state.fail.push({ match: /access_tokens/, status: 302 });
    const body = await bodyOf(await k.send({ skill: "run_personal_digest" }, k.bearer(token)));
    expect(at(body, "result.status.state")).toBe("failed");
  });
});
