import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUMMARIZER_SYSTEM_PROMPT } from "../src/prompts/summarizer.generated";
import { promptVersion, promptVersionOf } from "../src/summarizer/prompting";

// Pinned: the template's `prompt_version()` must produce the same id for the same text (spec 4.4, D4).
// If you edit the prompt, change it in the template first, run `npm run prompt:generate`, update this pin.
export const PINNED_PROMPT_VERSION = "p-56a22986b1";

describe("summarizer prompt sync (spec 4.4)", () => {
  const file = readFileSync("prompts/summarizer_system.txt", "utf8");
  it("generated module is byte-identical to the prompt file", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toBe(file.replace(/\r\n/g, "\n"));
  });
  it("prompt_version matches the pinned value", async () => {
    expect(await promptVersion()).toBe(PINNED_PROMPT_VERSION);
  });
  it("prompt_version uses the template formula: p- + first 10 hex of sha256", async () => {
    const expected = "p-" + createHash("sha256").update(SUMMARIZER_SYSTEM_PROMPT, "utf8").digest("hex").slice(0, 10);
    expect(await promptVersionOf(SUMMARIZER_SYSTEM_PROMPT)).toBe(expected);
  });
  it("any edit changes the version", async () => {
    expect(await promptVersionOf(SUMMARIZER_SYSTEM_PROMPT + " ")).not.toBe(PINNED_PROMPT_VERSION);
  });
  it("contains the nonce placeholder twice and no code fences", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT.split("{{NONCE}}")).toHaveLength(3);
    expect(SUMMARIZER_SYSTEM_PROMPT).not.toContain("```");
  });
  it("keeps the trust rules and the output contract", () => {
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain("TRUST RULES (highest priority");
    expect(SUMMARIZER_SYSTEM_PROMPT).toContain('"injection_flag": boolean');
  });
});
