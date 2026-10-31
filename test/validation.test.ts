import { describe, expect, it } from "vitest";
import { SummaryValidationError, dropOverlongKeyPoints, parseJsonObject, validateSummary } from "../src/summarizer/validation";
import { ITEM_URL, goodSummary } from "./helpers";

const SOURCE = "Laminar says flow-1 matches GPT-6-sol while being 23x cheaper. See https://news.ycombinator.com/item?id=50154029";
const run = (raw: Record<string, unknown>, depth: "headlines" | "brief" | "detailed" = "brief") =>
  validateSummary(raw, { depth, expectedUrl: ITEM_URL, sourceText: SOURCE });
const rejects = (raw: Record<string, unknown>, message: RegExp, depth: "headlines" | "brief" | "detailed" = "brief") =>
  expect(() => run(raw, depth)).toThrow(message);
const empty = { title: "", one_line: "", key_points: [], why_it_matters: "", tags: [], notable_figures: [], entities: [] };

describe("parseJsonObject", () => {
  it("parses plain JSON", () => expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 }));
  it("tolerates a wrapping code fence", () => expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it("extracts the object from surrounding prose", () => expect(parseJsonObject('Sure! {"a":1} done')).toEqual({ a: 1 }));
  it.each([["no braces", "hello"], ["broken JSON", "{a:1}"], ["an array", "[1,2]"], ["null", "null"], ["a number", "5"]])(
    "rejects %s",
    (_n, text) => expect(() => parseJsonObject(text)).toThrow(SummaryValidationError),
  );
});

describe("validateSummary: accepts", () => {
  it("a good summary", () => expect(run(goodSummary()).status).toBe("ok"));
  it("an insufficient_content verdict with empty fields", () =>
    expect(run({ ...goodSummary(), ...empty, status: "insufficient_content" }).status).toBe("insufficient_content"));
  it("a suspected_injection verdict with the flag set", () =>
    expect(run({ ...goodSummary(), ...empty, status: "suspected_injection", injection_flag: true }).injection_flag).toBe(true));
  it("source_url mentioned with trailing punctuation", () =>
    expect(run(goodSummary({ why_it_matters: `See ${ITEM_URL}.` })).status).toBe("ok"));
});

describe("validateSummary: rejects", () => {
  it.each([
    ["an extra key", { ...goodSummary(), extra: 1 }, /schema violation in: <root>/],
    ["a missing key", (() => { const g: Record<string, unknown> = goodSummary(); delete g["why_it_matters"]; return g; })(), /schema violation in: why_it_matters/],
    ["a bad tag", goodSummary({ tags: ["not-a-slug"] }), /schema violation in: tags/],
    ["5 tags", goodSummary({ tags: ["rag", "datasets", "robotics", "multimodal", "agents-tooling"] }), /schema violation in: tags/],
    ["a non-boolean injection_flag", goodSummary({ injection_flag: "false" }), /schema violation in: injection_flag/],
    ["more than 8 entities", goodSummary({ entities: Array(9).fill("x") }), /schema violation in: entities/],
    ["a wrong source_url", goodSummary({}, "https://evil.example/x"), /source_url differs/],
    ["an empty one_line", goodSummary({ one_line: "  " }), /one_line is empty/],
    ["content with a non-ok status", { ...goodSummary(), status: "insufficient_content" }, /must be empty/],
    ["markup (bold)", goodSummary({ one_line: "**Big** news" }), /markup/],
    ["markup (html tag)", goodSummary({ one_line: "see <b>this</b>" }), /markup/],
    ["markup (link syntax)", goodSummary({ why_it_matters: "[a](b)" }), /markup/],
    ["markup (code fence)", goodSummary({ key_points: ["```x```"] }), /markup/],
    ["markup (heading)", goodSummary({ one_line: "# Title" }), /markup/],
    ["a foreign URL", goodSummary({ why_it_matters: "More at https://evil.example/steal?x=1" }), /URL other than source_url/],
    ["a www URL", goodSummary({ one_line: "see www.evil.example" }), /URL other than source_url/],
    ["a notable figure absent from the source", goodSummary({ notable_figures: [{ value: "99x", context: "c" }] }), /does not appear in the source/],
  ])("%s", (_n, raw, message) => rejects(raw as Record<string, unknown>, message));
});

describe("validateSummary: length and depth rules name the exact limit", () => {
  it("one_line over 200 characters", () => rejects(goodSummary({ one_line: "x".repeat(201) }), /one_line is too long \(limit 200 characters\)/));
  it("title over 300", () => rejects(goodSummary({ title: "x".repeat(301) }), /title is too long \(limit 300/));
  it("why_it_matters over 300", () => rejects(goodSummary({ why_it_matters: "x".repeat(301) }), /why_it_matters is too long \(limit 300/));
  it("brief: 4 key points", () => rejects(goodSummary({ key_points: ["a", "b", "c", "d"] }), /too many key_points for depth brief \(limit 3, got 4\)/));
  it("brief: a 161-character key point", () =>
    rejects(goodSummary({ key_points: ["x".repeat(161)] }), /limit 160 characters, longest is 161/));
  it("detailed allows 6 points of 240", () =>
    expect(run(goodSummary({ key_points: Array(6).fill("x".repeat(240)), notable_figures: [] }), "detailed").key_points).toHaveLength(6));
  it("detailed: 7 key points", () => rejects(goodSummary({ key_points: Array(7).fill("a") }), /limit 6, got 7/, "detailed"));
  it("headlines: any key point", () => rejects(goodSummary({ key_points: ["a"] }), /too many key_points for depth headlines \(limit 0/, "headlines"));
  it("counts code points, not UTF-16 units", () =>
    expect(run(goodSummary({ key_points: ["😀".repeat(160)], notable_figures: [] })).key_points).toHaveLength(1));
  it("marks only the key point violations as repairable", () => {
    for (const [raw, repairable] of [
      [goodSummary({ key_points: ["x".repeat(200)] }), true],
      [goodSummary({ key_points: ["a", "b", "c", "d"] }), true],
      [goodSummary({ one_line: "x".repeat(300) }), false],
      [goodSummary({ tags: ["bad"] }), false],
    ] as const) {
      try {
        run(raw);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SummaryValidationError);
        expect((e as SummaryValidationError).repairable).toBe(repairable);
      }
    }
  });
  it("error messages never contain model text", () => {
    try {
      run(goodSummary({ key_points: ["SECRET-MODEL-TEXT ".repeat(20)] }));
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET-MODEL-TEXT");
    }
  });
});

describe("dropOverlongKeyPoints", () => {
  it("deletes over-long points and keeps the first ones within the count limit", () => {
    const out = dropOverlongKeyPoints({ key_points: ["a", "x".repeat(200), "b", "c", "d"] }, "brief");
    expect(out["key_points"]).toEqual(["a", "b", "c"]);
  });
  it("never edits the text of what it keeps", () => {
    expect(dropOverlongKeyPoints({ key_points: ["keep me"] }, "brief")["key_points"]).toEqual(["keep me"]);
  });
  it("leaves a non-array alone", () => expect(dropOverlongKeyPoints({ key_points: "x" }, "brief")).toEqual({ key_points: "x" }));
});
