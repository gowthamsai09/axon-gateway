import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Workflow security lint (spec section 10). Phase 5 relaxes the Phase 0 rule "no wrangler anywhere"
// DELIBERATELY (Appendix C 81): `wrangler deploy` only in deploy.yml, `wrangler deploy --dry-run` only
// in ci.yml, and the two Cloudflare secrets only in deploy.yml. Everything else is as strict as before.
const dir = resolve(".github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
const UNTRUSTED = /\$\{\{\s*(inputs\.|github\.event|github\.head_ref|vars\.)/;
const DEPLOY_SECRETS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; environment?: string; steps: Step[]; ["timeout-minutes"]?: number };
type Doc = { permissions?: Record<string, string>; on?: Record<string, unknown>; jobs: Record<string, Job> };
const load = (f: string): { text: string; doc: Doc; steps: Step[] } => {
  const text = readFileSync(resolve(dir, f), "utf8");
  const doc = parse(text) as Doc;
  return { text, doc, steps: Object.values(doc.jobs).flatMap((j) => j.steps) };
};
const allowedSecrets = (f: string): string[] => ["GITHUB_TOKEN", ...(f === "deploy.yml" ? DEPLOY_SECRETS : [])];

describe("workflow files", () => {
  it("includes the expected set", () => expect(files.sort()).toEqual(["ci.yml", "deploy.yml"]));
});

describe.each(files)("%s", (file) => {
  const { text, doc, steps } = load(file);

  it("has explicit top-level permissions and no pull_request_target", () => {
    expect(typeof doc.permissions).toBe("object");
    expect(Object.keys(doc.on ?? {})).not.toContain("pull_request_target");
  });
  it("pins every third-party action to a commit SHA (no placeholders remain)", () => {
    for (const s of steps) if (s.uses && !s.uses.startsWith("./")) expect(s.uses).toMatch(/@[0-9a-f]{40}$/);
  });
  it("keeps untrusted expressions out of run:", () => {
    for (const s of steps) expect(s.run ?? "").not.toMatch(UNTRUSTED);
  });
  it("references only the secrets this file may use", () => {
    const names = [...JSON.stringify(doc).matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1] as string);
    for (const n of names) expect(allowedSecrets(file)).toContain(n);
  });
  it("uses wrangler only where allowed", () => {
    const lines = text.split("\n").filter((l) => /wrangler/.test(l.replace(/#.*$/, "")));
    if (file === "deploy.yml") for (const l of lines) expect(l).toMatch(/wrangler deploy\s*$/);
    else if (file === "ci.yml") for (const l of lines) expect(l).toMatch(/wrangler deploy --dry-run\s*$/);
    else expect(lines).toEqual([]);
    expect(JSON.stringify(doc)).not.toMatch(/npm publish|pages deploy/);
  });
  it("only deploy.yml reacts to workflow_run", () => {
    expect(Object.keys(doc.on ?? {}).includes("workflow_run")).toBe(file === "deploy.yml");
  });
  it("checkouts do not persist credentials", () => {
    for (const s of steps) if (s.uses?.startsWith("actions/checkout")) expect(s.with?.["persist-credentials"]).toBe(false);
  });
});

describe("deploy.yml gates", () => {
  const { doc, steps } = load("deploy.yml");
  const job = doc.jobs["deploy"] as Job;
  it("is read-only for the repository and waits for CI on main", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.on).toEqual({ workflow_run: { workflows: ["ci"], types: ["completed"], branches: ["main"] } });
  });
  it("only runs for a green, same-repository push", () => {
    const cond = job.if ?? "";
    expect(cond).toContain("github.repository == 'gowthamsai09/axon-gateway'");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(cond).toContain("github.event.workflow_run.event == 'push'");
    expect(cond).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
  });
  it("uses the protected production environment and a timeout", () => {
    expect(job.environment).toBe("production");
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(15);
  });
  it("checks out the commit CI tested", () => {
    const co = steps.find((s) => s.uses?.startsWith("actions/checkout"));
    expect(co?.with?.["ref"]).toBe("${{ github.event.workflow_run.head_sha }}");
  });
  it("guards the config before deploying, and deploys last", () => {
    const guard = steps.findIndex((s) => s.run === "node scripts/check-deploy-config.js");
    const deploy = steps.findIndex((s) => s.run === "npx wrangler deploy");
    expect(guard).toBeGreaterThan(-1);
    expect(deploy).toBe(steps.length - 1);
    expect(guard).toBeLessThan(deploy);
  });
  it("gives the Cloudflare credentials to the deploy step only, through env", () => {
    const deploy = steps[steps.length - 1] as Step;
    expect(deploy.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}",
      CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    });
    for (const s of steps.slice(0, -1)) expect(JSON.stringify(s)).not.toContain("CLOUDFLARE");
    for (const s of steps) expect(s.run ?? "").not.toContain("${{");
  });
  it("installs without running dependency scripts", () => {
    expect(steps.some((s) => s.run === "npm ci --ignore-scripts")).toBe(true);
  });
});

describe("ci.yml dry-run", () => {
  const { steps } = load("ci.yml");
  it("bundles the Worker without any Cloudflare credentials", () => {
    const dry = steps.find((s) => s.run === "npx wrangler deploy --dry-run");
    expect(dry).toBeDefined();
    expect(JSON.stringify(dry)).not.toContain("secrets.");
  });
});
