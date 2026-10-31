import { afterEach, describe, expect, it, vi } from "vitest";
import { at, bodyOf } from "./helpers";
import { JWKS_URL, OTHER_REPO, REPO, makeKit, mintOidc } from "./t3-helpers";

afterEach(() => vi.restoreAllMocks());

describe("token issue", () => {
  it("returns a 256-bit axn_ token once and stores only its hash", async () => {
    const k = await makeKit();
    await k.register();
    const { res, token, body } = await k.issue("research agent", 30);
    expect(res.status).toBe(201);
    expect(token).toMatch(/^axn_[A-Za-z0-9_-]{43}$/);
    expect(at(body, "scopes")).toEqual(["digest"]);
    expect(k.kv.all()).not.toContain(token);
    const keys = [...k.kv.data.keys()];
    expect(keys.some((x) => /^tok:[a-f0-9]{64}$/.test(x))).toBe(true);
    expect(keys.some((x) => /^tokid:alice\/axon-digest:tk_[a-f0-9]{16}$/.test(x))).toBe(true);
  });

  it("stores the spec record with an expiry and a KV TTL", async () => {
    const k = await makeKit();
    await k.register();
    const { id } = await k.issue("x", 2);
    const tokKey = [...k.kv.data.keys()].find((x) => x.startsWith("tok:")) as string;
    const rec = JSON.parse(k.kv.data.get(tokKey) as string) as Record<string, unknown>;
    expect(rec).toMatchObject({ id, repo: REPO, installation_id: 777001, label: "x", scopes: ["digest"] });
    expect(Date.parse(rec["expires_at"] as string) - Date.parse(rec["created_at"] as string)).toBe(2 * 86_400_000);
    expect(k.kv.ttls.get(tokKey)).toBe(2 * 86_400);
  });

  it("defaults to 90 days", async () => {
    const k = await makeKit();
    await k.register();
    const { body } = await k.issue("d");
    const days = (Date.parse(at(body, "expires_at") as string) - k.getNow().getTime()) / 86_400_000;
    expect(days).toBe(90);
  });

  it.each(["", "a".repeat(65), "bad/label", "<script>", "semi;colon", "new\nline"])("rejects label %j", async (label) => {
    const k = await makeKit();
    await k.register();
    expect((await k.issue(label)).res.status).toBe(400);
  });

  it.each([0, -1, 366, 1.5])("rejects expires_in_days %s", async (d) => {
    const k = await makeKit();
    await k.register();
    expect((await k.issue("ok", d)).res.status).toBe(400);
  });

  it("rejects unknown fields (strict body)", async () => {
    const k = await makeKit();
    await k.register();
    const res = await k.call("POST", "/tokens", await k.oidcFor("issue-token.yml"), { label: "a", repo: "bob/x" });
    expect(res.status).toBe(400);
  });

  it("refuses to issue for an unregistered repository", async () => {
    const k = await makeKit();
    const res = await k.call("POST", "/tokens", await k.oidcFor("issue-token.yml"), { label: "a" });
    expect(res.status).toBe(403);
  });

  it("requires the issue-token workflow identity", async () => {
    const k = await makeKit();
    await k.register();
    const res = await k.call("POST", "/tokens", await k.oidcFor("register.yml"), { label: "a" });
    expect(res.status).toBe(401);
  });

  it("caps active tokens per repository at 10", async () => {
    const k = await makeKit();
    await k.register();
    for (let i = 0; i < 10; i++) expect((await k.issue(`t${i}`)).res.status).toBe(201);
    const eleventh = await k.issue("t11");
    expect(eleventh.res.status).toBe(403);
    expect(eleventh.token).toBe("");
  });

  it("sets no-store on the issuing response", async () => {
    const k = await makeKit();
    await k.register();
    expect((await k.issue()).res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("token use", () => {
  it("authenticates a valid token", async () => {
    const k = await makeKit();
    await k.register();
    const { token } = await k.issue();
    const res = await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    expect(at(await bodyOf(res), "result.status.state")).toBe("submitted");
  });

  it("makes unknown, expired, revoked and malformed tokens indistinguishable", async () => {
    const k = await makeKit();
    await k.register();
    const good = await k.issue("g", 1);
    const gone = await k.issue("r");
    await k.call("DELETE", `/tokens/${gone.id}`, await k.oidcFor("revoke-token.yml"));
    k.setNow(new Date(k.getNow().getTime() + 2 * 86_400_000));
    const probes = ["axn_" + "A".repeat(43), good.token, gone.token, "garbage", "axn_short"];
    const answers = await Promise.all(probes.map(async (t) => {
      const res = await k.send({ skill: "run_personal_digest" }, k.bearer(t));
      return JSON.stringify(await res.json()).replace(/"(id|contextId|timestamp|messageId)":"[^"]*"/g, "");
    }));
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toContain("auth-required");
  });

  it("expires by the explicit expiry check, not only the KV TTL", async () => {
    const k = await makeKit();
    await k.register();
    const { token } = await k.issue("e", 1);
    k.setNow(new Date(k.getNow().getTime() + 86_400_000 + 1000));
    const res = await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    expect(at(await bodyOf(res), "result.status.state")).toBe("auth-required");
  });

  it("does not accept a token in the query string or without the Bearer scheme", async () => {
    const k = await makeKit();
    await k.register();
    const { token } = await k.issue();
    const body = { jsonrpc: "2.0", id: "1", method: "message/send", params: { message: { role: "user", messageId: "m", parts: [{ kind: "data", data: { skill: "run_personal_digest" } }] } } };
    expect(at(await bodyOf(await k.call("POST", `/a2a?token=${token}`, {}, body)), "result.status.state")).toBe("auth-required");
    expect(at(await bodyOf(await k.call("POST", "/a2a", { authorization: token }, body)), "result.status.state")).toBe("auth-required");
    expect(at(await bodyOf(await k.call("POST", "/a2a", { authorization: `Basic ${token}` }, body)), "result.status.state")).toBe("auth-required");
  });

  it("refuses a token placed in the message body (key_in_body) without echoing it", async () => {
    const k = await makeKit();
    await k.register();
    const { token } = await k.issue();
    const res = await k.send({ skill: "run_personal_digest", note: `use ${token}` });
    const text = await res.text();
    expect(text).toContain("key_in_body");
    expect(text).not.toContain(token);
  });
});

describe("revocation", () => {
  it("is immediate within one store", async () => {
    const k = await makeKit();
    await k.register();
    const { token, id } = await k.issue();
    const rev = await k.call("DELETE", `/tokens/${id}`, await k.oidcFor("revoke-token.yml"));
    expect(rev.status).toBe(200);
    expect(at(await bodyOf(await k.send({ skill: "run_personal_digest" }, k.bearer(token))), "result.status.state")).toBe("auth-required");
    expect([...k.kv.data.keys()].filter((x) => x.startsWith("tok"))).toHaveLength(0);
  });

  it("can lag on another replica: a frozen replica still accepts the token (documented behaviour)", async () => {
    const k = await makeKit();
    await k.register();
    const { token, id } = await k.issue();
    k.kv.freeze();
    await k.call("DELETE", `/tokens/${id}`, await k.oidcFor("revoke-token.yml"));
    const stale = await k.send({ skill: "run_personal_digest" }, k.bearer(token));
    expect(at(await bodyOf(stale), "result.status.state")).toBe("submitted");
    k.kv.replica = null; // the replica catches up
    expect(at(await bodyOf(await k.send({ skill: "run_personal_digest" }, k.bearer(token))), "result.status.state")).toBe("auth-required");
  });

  it.each(["tk_zzzz", "../x", "tk_0000000000000000", "TK_0000000000000000"])("returns 404 or 400 for token id %s", async (id) => {
    const k = await makeKit();
    await k.register();
    const res = await k.call("DELETE", `/tokens/${encodeURIComponent(id)}`, await k.oidcFor("revoke-token.yml"));
    expect([400, 404]).toContain(res.status);
  });

  it("cannot revoke another repository's token", async () => {
    const k = await makeKit();
    await k.register();
    const { token, id } = await k.issue();
    const otherHeaders = { authorization: `Bearer ${await mintOidc(k.oidc, "revoke-token.yml", { repository: OTHER_REPO, repository_owner: "bob", repository_id: "9002", job_workflow_ref: `${OTHER_REPO}/.github/workflows/revoke-token.yml@refs/heads/main` })}` };
    const res = await k.call("DELETE", `/tokens/${id}`, otherHeaders);
    expect(res.status).toBe(404);
    expect(at(await bodyOf(await k.send({ skill: "run_personal_digest" }, k.bearer(token))), "result.status.state")).toBe("submitted");
  });

  it("requires the revoke-token workflow identity", async () => {
    const k = await makeKit();
    await k.register();
    const { id } = await k.issue();
    expect((await k.call("DELETE", `/tokens/${id}`, await k.oidcFor("issue-token.yml"))).status).toBe(401);
  });

  it("frees a slot under the per-repository cap", async () => {
    const k = await makeKit();
    await k.register();
    const first = await k.issue("first");
    for (let i = 1; i < 10; i++) await k.issue(`t${i}`);
    expect((await k.issue("over")).res.status).toBe(403);
    await k.call("DELETE", `/tokens/${first.id}`, await k.oidcFor("revoke-token.yml"));
    expect((await k.issue("again")).res.status).toBe(201);
  });
});

describe("secret hygiene", () => {
  it("never logs, and the token appears only in the issuing response", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const k = await makeKit();
    await k.register();
    const { token, body } = await k.issue();
    const seen: string[] = [];
    for (const res of [await k.send({ skill: "run_personal_digest" }, k.bearer(token)), await k.rpc("tasks/get", { id: "nope" }, k.bearer(token))]) seen.push(await res.text());
    expect(seen.join("")).not.toContain(token);
    expect(JSON.stringify(body)).toContain(token);
    expect(k.kv.all()).not.toContain(token);
    expect(JSON.stringify(k.gh.calls)).not.toContain(token);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("JWKS is the only non-API outbound host", async () => {
    const k = await makeKit();
    await k.ready();
    const hosts = new Set(k.gh.urls().map((u) => new URL(u).host));
    expect([...hosts].sort()).toEqual(["api.github.com", "token.actions.githubusercontent.com"]);
    expect(k.gh.urls()).toContain(JWKS_URL);
  });
});
