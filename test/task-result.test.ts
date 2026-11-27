import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { TaskResult } from "../src/schemas";

const valid = () => ({
  task_id: "123e4567-e89b-12d3-a456-426614174000",
  status: "completed",
  finished_at: "2026-10-15T07:31:12Z",
  items: [
    {
      id: "9c1e4a7b2d3f5a60",
      title: "t",
      url: "https://example.com/post",
      summary: { one_line: "x", key_points: ["a"], why_it_matters: "y", tags: ["rag"] },
    },
  ],
  model: { provider: "deepseek", model: "deepseek-chat" },
  warnings: [],
});

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const mutations: Record<string, (r: ReturnType<typeof valid>) => unknown> = {
  extraTopLevelKey: (r) => ({ ...r, extra: 1 }),
  badStatus: (r) => ({ ...r, status: "queued" }),
  badUuid: (r) => ({ ...r, task_id: "nope" }),
  naiveDatetime: (r) => ({ ...r, finished_at: "2026-10-15T07:31:12" }),
  badProvider: (r) => ({ ...r, model: { provider: "openai", model: "x" } }),
  tooManyItems: (r) => ({ ...r, items: Array(26).fill(r.items[0]) }),
  badTag: (r) => ({ ...r, items: [{ ...r.items[0]!, summary: { ...r.items[0]!.summary, tags: ["x"] } }] }),
  extraInSummary: (r) => ({
    ...r,
    items: [{ ...r.items[0]!, summary: { ...r.items[0]!.summary, injected: true } }],
  }),
  missingWarnings: (r) => {
    const rest: Record<string, unknown> = { ...r };
    delete rest.warnings;
    return rest;
  },
};

describe("TaskResult (zod)", () => {
  it("accepts valid results, including an extractive fallback item", () => {
    expect(TaskResult.safeParse(valid()).success).toBe(true);
    const fb = clone(valid());
    fb.items = [{ id: "9c1e4a7b2d3f5a60", title: "t", url: "https://example.com/p", fallback_snippet: "s" } as never];
    expect(TaskResult.safeParse(fb).success).toBe(true);
  });
  it("requires exactly one of summary / fallback_snippet", () => {
    const both = clone(valid());
    (both.items[0] as Record<string, unknown>).fallback_snippet = "s";
    expect(TaskResult.safeParse(both).success).toBe(false);
    const neither = clone(valid());
    delete (neither.items[0] as Record<string, unknown>).summary;
    expect(TaskResult.safeParse(neither).success).toBe(false);
  });
  it("accepts the file exactly as the template writes it: JSON null for the unused field", () => {
    const withNulls = clone(valid());
    (withNulls.items[0] as Record<string, unknown>).fallback_snippet = null;
    const parsed = TaskResult.safeParse(withNulls);
    expect(parsed.success).toBe(true);
    expect(parsed.success && "fallback_snippet" in (parsed.data.items[0] ?? {})).toBe(false);
    const snippet = clone(valid());
    snippet.items = [{ id: "9c1e4a7b2d3f5a60", title: "t", url: "https://example.com/p", summary: null, fallback_snippet: "s" } as never];
    expect(TaskResult.safeParse(snippet).success).toBe(true);
  });
  it("still needs exactly one: both null, and a null in any other field, are refused", () => {
    const neither = clone(valid());
    Object.assign(neither.items[0] as object, { summary: null, fallback_snippet: null });
    expect(TaskResult.safeParse(neither).success).toBe(false);
    const nullTitle = clone(valid());
    Object.assign(nullTitle.items[0] as object, { title: null, fallback_snippet: null });
    expect(TaskResult.safeParse(nullTitle).success).toBe(false);
  });
  it.each(Object.keys(mutations))("rejects %s", (name) => {
    expect(TaskResult.safeParse(mutations[name]!(clone(valid()))).success).toBe(false);
  });
});

// Contract test: zod and the pydantic-exported JSON Schema (hub) must agree.
// Locally the hub is expected at ../Axon/schemas. CI sets HUB_SCHEMAS_DIR and REQUIRE_HUB_SCHEMAS=1.
const hubDir = resolve(process.env.HUB_SCHEMAS_DIR ?? "../Axon/schemas");
const schemaPath = resolve(hubDir, "task-result.schema.json");
const required = process.env.REQUIRE_HUB_SCHEMAS === "1";

describe("TaskResult zod <-> hub JSON Schema", () => {
  it("hub schema is available when required", () => {
    if (required) expect(existsSync(schemaPath), `missing ${schemaPath}`).toBe(true);
  });
  const run = existsSync(schemaPath) ? describe : describe.skip;
  run("agreement", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
    it("agrees on the valid example", () => {
      expect(validate(valid())).toBe(true);
    });
    it("agrees on the file as the template writes it (null for the unused field)", () => {
      const doc = clone(valid());
      (doc.items[0] as Record<string, unknown>).fallback_snippet = null;
      expect(validate(doc)).toBe(true);
      expect(TaskResult.safeParse(doc).success).toBe(true);
    });
    it.each(Object.keys(mutations))("agrees on invalid case %s", (name) => {
      const bad = mutations[name]!(clone(valid()));
      expect(validate(bad)).toBe(false);
      expect(TaskResult.safeParse(bad).success).toBe(false);
    });
  });
});
