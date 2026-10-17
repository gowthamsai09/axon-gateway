import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Workflow security lint (spec section 10). Mirrors tests/test_workflows.py in the Python repos.
const dir = resolve(".github/workflows");
const files = readdirSync(dir).filter((f) => f.endsWith(".yml"));
const SECRETS_OK = new Set(["GITHUB_TOKEN"]); // the gateway repo has no secrets in Phase 0
const UNTRUSTED = /\$\{\{\s*(inputs\.|github\.event|github\.head_ref|vars\.)/;

type Step = { uses?: string; run?: string };
type Doc = { permissions?: unknown; on?: Record<string, unknown>; jobs: Record<string, { steps: Step[] }> };

describe.each(files)("%s", (file) => {
  const text = readFileSync(resolve(dir, file), "utf8");
  const doc = parse(text) as Doc;
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps);

  it("has explicit top-level permissions and no pull_request_target", () => {
    expect(typeof doc.permissions).toBe("object");
    expect(Object.keys(doc.on ?? {})).not.toContain("pull_request_target");
  });
  it("pins third-party actions to a SHA (or the placeholder)", () => {
    for (const s of steps) {
      if (s.uses && !s.uses.startsWith("./")) {
        expect(s.uses).toMatch(/@(?:[0-9a-f]{40}|<pin-to-commit-sha>)$/);
      }
    }
  });
  it("keeps untrusted expressions out of run:", () => {
    for (const s of steps) expect(s.run ?? "").not.toMatch(UNTRUSTED);
  });
  it("references no unknown secrets and has no deploy step", () => {
    const names = [...JSON.stringify(doc).matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]!);
    for (const n of names) expect(SECRETS_OK.has(n)).toBe(true);
    expect(JSON.stringify(doc)).not.toMatch(/wrangler|npm publish|pages deploy/);
  });
});
