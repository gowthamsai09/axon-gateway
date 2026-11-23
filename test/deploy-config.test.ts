import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/check-deploy-config.js");
const GOOD = `name = "axon-gateway"
[vars]
FEED_BASE = "https://gowthamsai09.github.io/axon-feed/feed"
PUBLIC_URL = "https://axon-gateway.example.workers.dev"
GITHUB_APP_ID = "<app id>"   # Tier 3 may stay off
[[kv_namespaces]]
binding = "TOKENS"
id = "0123456789abcdef0123456789abcdef"
[observability]
enabled = false
`;

function run(toml: string): { code: number; err: string } {
  const file = join(mkdtempSync(join(tmpdir(), "axon-deploy-")), "wrangler.toml");
  writeFileSync(file, toml, "utf8");
  try {
    execFileSync("node", [SCRIPT, file], { stdio: "pipe" });
    return { code: 0, err: "" };
  } catch (e) {
    const x = e as { status?: number; stderr?: Buffer };
    return { code: x.status ?? -1, err: x.stderr?.toString() ?? "" };
  }
}

describe("check-deploy-config", () => {
  it("accepts a real configuration (Tier 3 may stay off)", () => {
    expect(run(GOOD)).toEqual({ code: 0, err: "" });
  });
  it("blocks the repository's own wrangler.toml until the placeholders are replaced (first push)", () => {
    const r = run(readFileSync("wrangler.toml", "utf8"));
    expect(r.code).toBe(1);
    expect(r.err).toContain("PUBLIC_URL is still a placeholder");
    expect(r.err).toContain("KV namespace id");
  });
  const bad: [string, (t: string) => string, string][] = [
    ["PUBLIC_URL placeholder", (t) => t.replace("axon-gateway.example.workers.dev", "axon-gateway.<account>.workers.dev"), "PUBLIC_URL is still a placeholder"],
    ["PUBLIC_URL http", (t) => t.replace('"https://axon-gateway', '"http://axon-gateway'), "PUBLIC_URL must be an https URL"],
    ["PUBLIC_URL with credentials", (t) => t.replace("https://axon", "https://user:pw@axon"), "PUBLIC_URL must be an https URL"],
    ["PUBLIC_URL missing", (t) => t.replace(/PUBLIC_URL.*\n/, ""), "PUBLIC_URL is missing"],
    ["FEED_BASE http", (t) => t.replace('"https://gowthamsai09', '"http://gowthamsai09'), "FEED_BASE must be an https URL"],
    ["FEED_BASE placeholder", (t) => t.replace("gowthamsai09", "<org>"), "FEED_BASE is still a placeholder"],
    ["KV id placeholder", (t) => t.replace("0123456789abcdef0123456789abcdef", "<kv id>"), "not a real id"],
    ["KV id uppercase", (t) => t.replace("0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789ABCDEF"), "not a real id"],
    ["KV id short", (t) => t.replace("0123456789abcdef0123456789abcdef", "0123"), "not a real id"],
    ["KV binding missing", (t) => t.replace(/\[\[kv_namespaces\]\][^[]*/, ""), "KV namespace id is missing"],
    ["ENVIRONMENT override", (t) => t.replace("[[kv", 'ENVIRONMENT = "development"\n[[kv'), "ENVIRONMENT is a local-development override"],
    ["GITHUB_API_BASE override", (t) => t.replace("[[kv", 'GITHUB_API_BASE = "http://127.0.0.1:1"\n[[kv'), "GITHUB_API_BASE is a local-development override"],
    ["observability enabled", (t) => t.replace("enabled = false", "enabled = true"), "observability must stay disabled"],
  ];
  it.each(bad)("blocks: %s", (_n, edit, message) => {
    const r = run(edit(GOOD));
    expect(r.code).toBe(1);
    expect(r.err).toContain(message);
  });
  it("is not fooled by a forbidden name that only appears in a comment", () => {
    const commented = GOOD.replace("[[kv", "# ENVIRONMENT = development\n[[kv");
    expect(run(commented).code).toBe(0);
  });
  it("exits 2 when the file cannot be read", () => {
    let code = 0;
    try {
      execFileSync("node", [SCRIPT, join(tmpdir(), "no-such-dir", "wrangler.toml")], { stdio: "pipe" });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).toBe(2);
  });
});
