// The gateway's summarizer prompt equals the hub's canonical copy and id file (Appendix C 82).
// The drift cases run on temporary copies (Windows and Linux); the real-hub case needs HUB_DIR or ../Axon.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/prompt-sync.js");
const MINE = readFileSync("prompts/summarizer_system.txt", "utf8").replace(/\r\n/g, "\n");
const idOf = (t: string): string => "p-" + createHash("sha256").update(t, "utf8").digest("hex").slice(0, 10);
const HUB = resolve(process.env["HUB_DIR"] ?? "../Axon");
const required = process.env["REQUIRE_HUB_PROMPTS"] === "1";

function hubCopy(opts: { text?: string | null; id?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "axon-hub-"));
  mkdirSync(join(root, "prompts"));
  const text = opts.text === undefined ? MINE : opts.text;
  const id = opts.id === undefined ? idOf(MINE) : opts.id;
  if (text !== null) writeFileSync(join(root, "prompts", "summarizer_system.txt"), text, "utf8");
  if (id !== null) writeFileSync(join(root, "prompts", "summarizer_system.version"), id + "\n", "utf8");
  return root;
}
function run(hub: string): { code: number; err: string; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "hub", hub], { encoding: "utf8" });
  return { code: r.status ?? -1, err: r.stderr, out: r.stdout };
}

describe("prompt:hub on temporary copies", () => {
  it("passes for an identical copy and prints the id", () => {
    const r = run(hubCopy());
    expect(r.code).toBe(0);
    expect(r.out).toContain(idOf(MINE));
  });
  it("treats CRLF in the hub copy as the same text", () => {
    const crlf = MINE.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(MINE);
    expect(run(hubCopy({ text: crlf })).code).toBe(0);
  });
  it("a one character edit is drift (exit 1)", () => {
    const edited = MINE.replace("e", "E");
    expect(edited).not.toBe(MINE);
    const r = run(hubCopy({ text: edited, id: idOf(edited) }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("DIFFERENT from the hub copy");
  });
  it("a stale id file is drift (exit 1)", () => {
    const r = run(hubCopy({ id: "p-0000000000" }));
    expect(r.code).toBe(1);
    expect(r.err).toContain("differs from the hub's p-0000000000");
  });
  it.each([
    ["the prompt text", { text: null }],
    ["the id file", { id: null }],
  ])("a missing %s exits 2", (_n, opts) => {
    const r = run(hubCopy(opts));
    expect(r.code).toBe(2);
    expect(r.err).toContain("hub prompt copy missing");
  });
  it("a hub folder that does not exist exits 2", () => {
    expect(run(join(tmpdir(), "axon-no-such-hub")).code).toBe(2);
  });
});

describe.skipIf(!existsSync(join(HUB, "prompts")) && !required)("prompt:hub on the real hub", () => {
  it("the gateway prompt matches the hub", () => {
    expect(existsSync(join(HUB, "prompts"))).toBe(true); // with REQUIRE_HUB_PROMPTS=1 a missing hub fails here
    const r = run(HUB);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
  });
});
