import { describe, expect, it } from "vitest";
import { summarizeOne } from "../src/summarizer/llm";
import { newUsage, type ChatClient, type SourceItem } from "../src/summarizer/types";
import { SummaryValidationError } from "../src/summarizer/validation";
import { ITEM_URL, NONCE, goodSummary } from "./helpers";

const item: SourceItem = {
  id: "6a23445afa1896da", title: "Launch HN: Laminar", url: ITEM_URL, sourceName: "hn-ai",
  publishedAt: "2026-10-19T16:00:18Z", text: "Laminar says flow-1 matches GPT-6-sol while being 23x cheaper.",
};
function fake(outputs: (string | Record<string, unknown>)[]): ChatClient & { prompts: { system: string; user: string }[] } {
  const prompts: { system: string; user: string }[] = [];
  let i = 0;
  return {
    provider: "deepseek", model: "m", prompts,
    async complete(system, user) {
      prompts.push({ system, user });
      const out = outputs[Math.min(i++, outputs.length - 1)] as string | Record<string, unknown>;
      return { text: typeof out === "string" ? out : JSON.stringify(out), usage: { prompt_tokens: 10, completion_tokens: 5, calls: 1 } };
    },
  };
}
const go = (c: ChatClient, notes: string[] = [], usage = newUsage()) => summarizeOne(c, item, "brief", "en", usage, notes, () => NONCE);

describe("summarizeOne", () => {
  it("returns a valid summary on the first try with one call", async () => {
    const c = fake([goodSummary()]);
    const usage = newUsage();
    expect((await go(c, [], usage)).status).toBe("ok");
    expect(c.prompts).toHaveLength(1);
    expect(usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, calls: 1 });
  });
  it("uses the nonce in both system and user messages", async () => {
    const c = fake([goodSummary()]);
    await go(c);
    expect(c.prompts[0]?.system).toContain(NONCE);
    expect(c.prompts[0]?.user).toContain(`<untrusted_document nonce="${NONCE}">`);
  });
  it("retries once with a reminder that names the exact limit", async () => {
    const c = fake([goodSummary({ one_line: "x".repeat(250) }), goodSummary()]);
    const usage = newUsage();
    expect((await go(c, [], usage)).status).toBe("ok");
    expect(c.prompts).toHaveLength(2);
    expect(c.prompts[1]?.user).toContain("return valid JSON only");
    expect(c.prompts[1]?.user).toContain("one_line is too long (limit 200 characters)");
    expect(usage.calls).toBe(2);
  });
  it("retries when the output is not JSON", async () => {
    const c = fake(["I cannot do that", goodSummary()]);
    expect((await go(c)).status).toBe("ok");
    expect(c.prompts).toHaveLength(2);
  });
  it("gives up after the second bad output (never a third call)", async () => {
    const c = fake([goodSummary({ tags: ["bad"] })]);
    await expect(go(c)).rejects.toBeInstanceOf(SummaryValidationError);
    expect(c.prompts).toHaveLength(2);
  });
  it("repairs by deleting over-long key points and records a note (Appendix C 43)", async () => {
    const long = goodSummary({ key_points: ["ok point", "x".repeat(300)] });
    const c = fake([long]);
    const notes: string[] = [];
    const s = await go(c, notes);
    expect(s.key_points).toEqual(["ok point"]);
    expect(notes[0]).toContain("dropped key point(s) over the length limit");
    expect(c.prompts).toHaveLength(2);
  });
  it("does not repair other violations", async () => {
    await expect(go(fake([goodSummary({ one_line: "x".repeat(300), key_points: ["x".repeat(300)] })]))).rejects.toThrow(/too long|too many/);
  });
  it("fails when the repaired output is still invalid", async () => {
    const bad = goodSummary({ key_points: ["x".repeat(300)], source_url: "https://other.example" });
    await expect(go(fake([bad]))).rejects.toBeInstanceOf(SummaryValidationError);
  });
  it("treats output that contains a forbidden secret as invalid: retried, then refused", async () => {
    const leaky = goodSummary({ one_line: "the key is SECRET-VALUE-123" });
    const c = fake([leaky, goodSummary()]);
    const s = await summarizeOne(c, item, "brief", "en", newUsage(), [], () => NONCE, ["SECRET-VALUE-123"]);
    expect(s.one_line).not.toContain("SECRET");
    expect(c.prompts).toHaveLength(2);
    const stuck = fake([leaky]);
    await expect(summarizeOne(stuck, item, "brief", "en", newUsage(), [], () => NONCE, ["SECRET-VALUE-123"])).rejects.toThrow(/contains a secret/);
  });
  it("the retry reminder after a secret never repeats the secret", async () => {
    const c = fake([goodSummary({ one_line: "SECRET-VALUE-123" }), goodSummary()]);
    await summarizeOne(c, item, "brief", "en", newUsage(), [], () => NONCE, ["SECRET-VALUE-123"]);
    expect(c.prompts[1]?.user).not.toContain("SECRET-VALUE-123");
  });
  it("passes transport errors through untouched", async () => {
    const c: ChatClient = { provider: "p", model: "m", complete: () => Promise.reject(new Error("transport")) };
    await expect(go(c)).rejects.toThrow("transport");
  });
});
