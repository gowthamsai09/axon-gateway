// Shared hostile-document corpus (hub corpus/injection, spec 11.3) against the REAL sanitizer, prompt
// assembly and output validation of the gateway. No LLM. Same cases as the template's tests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_DOC_CHARS, documentFor, expectedSourceUrl, sanitizeText, userMessage,
} from "../src/summarizer/prompting";
import type { SourceItem } from "../src/summarizer/types";
import { SummaryValidationError, parseJsonObject, validateSummary } from "../src/summarizer/validation";
import { NONCE } from "./helpers";

const dir = resolve(process.env["HUB_CORPUS_DIR"] ?? "../Axon/corpus/injection");
const required = process.env["REQUIRE_HUB_CORPUS"] === "1";
const present = existsSync(dir);
if (!present && required) throw new Error(`hub corpus required but missing: ${dir}`);

const Expect = z.object({
  outcome: z.string(),
  forbid_ci: z.array(z.string()).default([]),
  require: z.array(z.string()).default([]),
  reason: z.string().optional(),
});
const Doc = z.object({ id: z.string(), kind: z.literal("document"), title: z.string(), text: z.string(), text_repeat: z.number().int().min(1), expect: Expect });
const Meta = z.object({ id: z.string(), kind: z.literal("meta"), title: z.string(), text: z.string(), url: z.string(), source_name: z.string(), published_at: z.string() });
const Out = z.object({
  id: z.string(), kind: z.literal("output"), depth: z.enum(["headlines", "brief", "detailed"]),
  patch: z.record(z.string(), z.unknown()), raw_text: z.string().nullable(), expect: Expect,
});
const Base = z.object({ kind: z.literal("base"), source_url: z.string(), source_text: z.string(), good_summary: z.record(z.string(), z.unknown()) });

const files = present ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : [];
const raw = files.map((f) => JSON.parse(readFileSync(resolve(dir, f), "utf8")) as { kind?: string });
const pick = <T extends z.ZodType>(kind: string, schema: T): z.infer<T>[] => raw.filter((c) => c.kind === kind).map((c) => schema.parse(c));
const docs = pick("document", Doc);
const metas = pick("meta", Meta);
const outs = pick("output", Out);
const base = pick("base", Base)[0];

const TAGS = /<\s*\/?\s*(?:untrusted_document|task)\b/i;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/u;
const hidden = (t: string): string[] => Array.from(t).filter((c) => c !== "\n" && c !== "\t" && HIDDEN.test(c));
const itemOf = (text: string, title = "Corpus case"): SourceItem => ({
  id: "a".repeat(16), title, url: "https://example.com/a", sourceName: "hn-ai", publishedAt: "2026-10-20T00:00:00Z", text,
});
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;

describe.skipIf(!present)("injection corpus", () => {
  it("was really loaded", () => {
    expect(docs.length).toBeGreaterThanOrEqual(30);
    expect(outs.length).toBeGreaterThanOrEqual(6);
    expect(metas).toHaveLength(1);
    expect(base).toBeDefined();
  });

  it.each(docs.map((d) => [d.id, d] as const))("document case %s", (_id, c) => {
    const rawText = c.text.repeat(c.text_repeat);
    const it = itemOf(rawText, c.title);
    const document = documentFor(it);
    const msg = userMessage(it, "brief", "en", NONCE, document);
    expect(TAGS.test(document)).toBe(false);
    expect(hidden(document)).toEqual([]);
    expect(Array.from(document).length).toBeLessThanOrEqual(MAX_DOC_CHARS);
    expect(count(msg, `<untrusted_document nonce="${NONCE}">`)).toBe(1);
    expect(count(msg, `</untrusted_document nonce="${NONCE}">`)).toBe(1);
    expect(count(msg, "<task>")).toBe(1);
    expect(count(msg, "</task>")).toBe(1);
    const head = msg.slice(0, msg.indexOf("<untrusted_document"));
    expect([...head.matchAll(/^source_url: (.*)$/gm)].map((m) => m[1])).toEqual([expectedSourceUrl(it)]);
    for (const needle of c.expect.forbid_ci) expect(document.toLowerCase()).not.toContain(needle.toLowerCase());
    for (const needle of c.expect.require) {
      expect(document).toContain(needle);
      expect(msg.slice(msg.indexOf("<untrusted_document"))).toContain(needle);
    }
    if (c.expect.outcome === "sanitized") expect(document).not.toBe(rawText.trim());
    if (c.expect.outcome === "truncated") {
      expect(Array.from(rawText).length).toBeGreaterThan(MAX_DOC_CHARS);
      expect(Array.from(document).length).toBe(MAX_DOC_CHARS);
    }
  });

  it.each(metas.map((m) => [m.id, m] as const))("hostile task-block fields stay single line: %s", (_id, c) => {
    const it: SourceItem = { id: "a".repeat(16), title: c.title, url: c.url, sourceName: c.source_name, publishedAt: c.published_at, text: c.text };
    const msg = userMessage(it, "brief", "en", NONCE, documentFor(it));
    const head = msg.slice(0, msg.indexOf("\n\n<untrusted_document"));
    const lines = head.split("\n");
    expect(lines[0]).toBe("<task>");
    expect(lines.at(-1)).toBe("</task>");
    expect(lines).toHaveLength(8);
    expect(count(head, "<")).toBe(2);
    expect(count(head, ">")).toBe(2);
    expect(lines.slice(4, -1).every((l) => !l.includes('"'))).toBe(true);
    expect(lines.slice(1, -1).map((l) => l.split(":")[0])).toEqual(["depth", "language", "allowed_tags", "source_url", "source_name", "published_at"]);
  });

  it.each(outs.map((o) => [o.id, o] as const))("output case %s", (_id, c) => {
    if (base === undefined) throw new Error("no base case");
    const run = (): unknown => {
      let rawOut: Record<string, unknown>;
      if (c.raw_text !== null) rawOut = parseJsonObject(c.raw_text.replace("{JSON}", JSON.stringify(base.good_summary)));
      else {
        rawOut = { ...base.good_summary };
        for (const [k, v] of Object.entries(c.patch)) {
          if (v === null) delete rawOut[k];
          else rawOut[k] = v;
        }
      }
      return validateSummary(rawOut, { depth: c.depth, expectedUrl: base.source_url, sourceText: base.source_text });
    };
    if (c.expect.outcome === "accepted") expect(run()).toBeTruthy();
    else {
      expect(run).toThrow(SummaryValidationError);
      expect(run).toThrow(c.expect.reason ?? "");
    }
  });

  it("delimiter stripping fuzz: random splices never leave a delimiter or hidden character (3000 runs)", () => {
    let seed = 20261101;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const frags = ["<", "</", "/", ">", " ", "\n", "untrusted_document", "UNTRUSTED_DOCUMENT", "task", "Task", ' nonce="x"', "nonce=", "<task>", "</task>", "</untrusted_document>", "\u200b", "\u202e", "ab", "x", "<ta", "sk>", "<untr", "usted_document>"];
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 2 + rnd(13) }, () => frags[rnd(frags.length)] ?? "").join("");
      const out = sanitizeText(text);
      expect(TAGS.test(out), JSON.stringify(text)).toBe(false);
      expect(hidden(out), JSON.stringify(text)).toEqual([]);
    }
  });
});
