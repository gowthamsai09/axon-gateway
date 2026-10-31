import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parseItems } from "../src/core/feed";
import { TOPIC_SLUGS } from "../src/schemas";
import { FIXTURES } from "./helpers";

const hubDir = resolve(process.env.HUB_SCHEMAS_DIR ?? "../Axon/schemas");
const feedSchemaPath = resolve(hubDir, "feed-item.schema.json");
const required = process.env.REQUIRE_HUB_SCHEMAS === "1";
const fixtureItems = (): unknown[] => {
  const files = ["latest.json", "tags/agents-tooling.json", "tags/open-source-llms.json", "entities/llama-cpp.json"];
  return files.flatMap((f) => (JSON.parse(readFileSync(resolve(FIXTURES, f), "utf8")) as { items: unknown[] }).items);
};

describe("slug parity", () => {
  it("the A2A prompt lists exactly the 16 topic slugs", () => {
    const text = readFileSync("prompts/a2a_agent_system.txt", "utf8");
    const line = /Allowed topic slugs: ([^.]+)\./.exec(text)?.[1] ?? "";
    expect(line.split(", ")).toEqual([...TOPIC_SLUGS]);
  });
  it("the template onboarding list and this list agree (checked from the pinned copy of the summarizer prompt's tags)", () => {
    expect(new Set(TOPIC_SLUGS).size).toBe(16);
  });
});

describe("feed fixtures", () => {
  it("every fixture item is readable by the tolerant consumer view", () => {
    const items = fixtureItems();
    const parsed = parseItems({ items });
    expect(parsed.skipped).toBe(0);
    expect(parsed.items).toHaveLength(items.length);
  });
  it("fixtures cover the shapes that matter: empty tags, empty snippet, no entities, an excerpt file", () => {
    const items = fixtureItems() as { tags: string[]; snippet: string; entities: string[] }[];
    expect(items.some((i) => i.tags.length === 0)).toBe(true);
    expect(items.some((i) => i.snippet === "")).toBe(true);
    expect(items.some((i) => i.entities.length === 0)).toBe(true);
    expect(readdirSync(resolve(FIXTURES, "items"))).toContain("6a23445afa1896da.json");
  });
});

describe("hub feed-item JSON Schema (published contract)", () => {
  it("is available when required", () => {
    if (required) expect(existsSync(feedSchemaPath), `missing ${feedSchemaPath}`).toBe(true);
  });
  const run = existsSync(feedSchemaPath) ? describe : describe.skip;
  run("agreement", () => {
    const schema = JSON.parse(readFileSync(feedSchemaPath, "utf8")) as { properties: { tags: { items: { enum: string[] } } } };
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats.default(ajv);
    const validate = ajv.compile(schema);
    it("the tag enum equals the gateway's topic slugs, in order", () => {
      expect(schema.properties.tags.items.enum).toEqual([...TOPIC_SLUGS]);
    });
    it("every fixture item validates against the published schema", () => {
      for (const item of fixtureItems()) expect(validate(item), JSON.stringify(validate.errors)).toBe(true);
    });
    it("the item file with an excerpt validates too", () => {
      expect(validate(JSON.parse(readFileSync(resolve(FIXTURES, "items/6a23445afa1896da.json"), "utf8")))).toBe(true);
    });
  });
});
