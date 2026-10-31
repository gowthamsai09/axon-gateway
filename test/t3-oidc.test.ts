import { describe, expect, it } from "vitest";
import { generateKeyPair } from "jose";
import { at, bodyOf } from "./helpers";
import { ISSUER, JWKS_URL, REPO, makeKit, mintOidc, oidcKit } from "./t3-helpers";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("OIDC verification on /register", () => {
  it("accepts a valid token and binds the repo from the claims", async () => {
    const k = await makeKit();
    const res = await k.register();
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(at(body, "repo")).toBe(REPO);
    expect(at(body, "installation_id")).toBe(777001);
    expect(String(at(body, "agent_id"))).toMatch(/^ag_[a-f0-9]{16}$/);
  });

  it("is idempotent: registering twice gives the same agent_id", async () => {
    const k = await makeKit();
    const a = await bodyOf(await k.register());
    const b = await bodyOf(await k.register());
    expect(at(a, "agent_id")).toBe(at(b, "agent_id"));
  });

  const cases: [string, (k: Awaited<ReturnType<typeof makeKit>>) => Promise<string>][] = [
    ["expired", (k) => mintOidc(k.oidc, "register.yml", {}, { iatOffset: -4000, expOffset: -3600 })],
    ["wrong issuer", (k) => mintOidc(k.oidc, "register.yml", {}, { iss: "https://evil.test" })],
    ["wrong audience", (k) => mintOidc(k.oidc, "register.yml", {}, { aud: "https://other.test" })],
    ["audience with trailing slash", (k) => mintOidc(k.oidc, "register.yml", {}, { aud: "https://gw.test/" })],
    ["token older than 15 minutes", (k) => mintOidc(k.oidc, "register.yml", {}, { iatOffset: -1000 })],
    ["repository claim is not owner/name", (k) => mintOidc(k.oidc, "register.yml", { repository: "../etc/passwd" })],
    ["repository claim with extra segment", (k) => mintOidc(k.oidc, "register.yml", { repository: "a/b/c" })],
    ["repository_owner differs", (k) => mintOidc(k.oidc, "register.yml", { repository_owner: "mallory" })],
    ["repository_id missing", (k) => mintOidc(k.oidc, "register.yml", { repository_id: undefined })],
    ["event is push", (k) => mintOidc(k.oidc, "register.yml", { event_name: "push" })],
    ["event is pull_request", (k) => mintOidc(k.oidc, "register.yml", { event_name: "pull_request" })],
    ["workflow is issue-token.yml", (k) => mintOidc(k.oidc, "issue-token.yml")],
    ["workflow is revoke-token.yml", (k) => mintOidc(k.oidc, "revoke-token.yml")],
    ["workflow ref from another repository", (k) => mintOidc(k.oidc, "register.yml", { job_workflow_ref: "evil/repo/.github/workflows/register.yml@refs/heads/main" })],
    ["workflow ref is a different file", (k) => mintOidc(k.oidc, "register.yml", { job_workflow_ref: `${REPO}/.github/workflows/other.yml@refs/heads/main` })],
    ["workflow ref prefix trick", (k) => mintOidc(k.oidc, "register.yml", { job_workflow_ref: `${REPO}/.github/workflows/register.yml.evil@refs/heads/main` })],
    ["signed by a different key, same kid", async (k) => mintOidc(k.oidc, "register.yml", {}, { key: (await generateKeyPair("RS256")).privateKey })],
    ["alg HS256 signed with the public key (confusion)", (k) => mintOidc(k.oidc, "register.yml", {}, { alg: "HS256", key: new TextEncoder().encode(JSON.stringify(k.oidc.jwks.keys[0])) as unknown as CryptoKey })],
    ["alg none", async () => `${b64({ alg: "none", kid: "kid-1" })}.${b64({ iss: ISSUER, aud: "https://gw.test", repository: REPO })}.`],
    ["not a JWT", async () => "not-a-jwt"],
    ["two parts", async () => "aaa.bbb"],
    ["oversized token", async () => "a".repeat(7000) + ".b.c"],
    ["empty token", async () => ""],
  ];
  it.each(cases)("rejects: %s", async (_name, make) => {
    const k = await makeKit();
    const token = await make(k);
    const res = await k.call("POST", "/register", { authorization: `Bearer ${token}` }, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
    const text = await res.text();
    expect(text).not.toContain(token.slice(0, 40) || "zzzz");
    expect(k.gh.calls.every((c) => c.url === JWKS_URL)).toBe(true); // nothing reached the GitHub API
  });

  it("accepts only RS256: an RS384 token from a valid RSA key (JWKS entry without alg) is refused", async () => {
    const k = await makeKit();
    const kit384 = await oidcKit("kid-384", "RS384", false);
    k.gh.state.jwks = kit384.jwks;
    const token = await mintOidc(kit384, "register.yml", {}, { alg: "RS384" });
    expect((await k.call("POST", "/register", { authorization: `Bearer ${token}` }, {})).status).toBe(401);
    // and the same kit with RS256 is fine, so the refusal is about the algorithm
    const kit256 = await oidcKit("kid-256", "RS256", false);
    k.gh.state.jwks = kit256.jwks;
    expect((await k.call("POST", "/register", { authorization: `Bearer ${await mintOidc(kit256, "register.yml")}` }, {})).status).toBe(200);
  });

  it("rejects a missing Authorization header", async () => {
    const k = await makeKit();
    expect((await k.call("POST", "/register", {}, {})).status).toBe(401);
  });

  it("refreshes the JWKS once for an unknown kid, then rejects", async () => {
    const k = await makeKit();
    const token = await mintOidc(k.oidc, "register.yml", {}, { kid: "rotated" });
    const res = await k.call("POST", "/register", { authorization: `Bearer ${token}` }, {});
    expect(res.status).toBe(401);
    expect(k.gh.state.jwksFetches).toBe(2); // one cached read, one refresh, no loop
  });

  it("accepts a rotated key found after the single refresh", async () => {
    const k = await makeKit();
    const rotated = await oidcKit("kid-2");
    k.gh.state.jwks = { keys: [...k.oidc.jwks.keys, ...rotated.jwks.keys] };
    const res = await k.call("POST", "/register", { authorization: `Bearer ${await mintOidc(rotated, "register.yml")}` }, {});
    expect(res.status).toBe(200);
  });

  it("maps a JWKS outage to a neutral 502", async () => {
    const k = await makeKit();
    k.gh.state.fail.push({ match: /jwks/, status: 503, body: "secret upstream body" });
    const res = await k.call("POST", "/register", await k.oidcFor("register.yml"), {});
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("secret upstream body");
  });

  it("rejects a register body that is not an empty object", async () => {
    const k = await makeKit();
    const res = await k.call("POST", "/register", await k.oidcFor("register.yml"), { repo: "bob/other" });
    expect(res.status).toBe(400);
    expect(k.gh.calls.filter((c) => c.url !== JWKS_URL)).toHaveLength(0);
  });

  it("never lets the request choose the repository", async () => {
    const k = await makeKit();
    const res = await k.call("POST", "/register?repo=bob/other-digest", await k.oidcFor("register.yml"), {});
    expect(at(await bodyOf(res), "repo")).toBe(REPO);
    expect(k.gh.calls.every((c) => !c.url.includes("bob"))).toBe(true);
  });
});
