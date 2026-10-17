import { describe, expect, it } from "vitest";
import { GetUpdatesInput, SummarizeInput, TOPIC_SLUGS } from "../src/schemas";

describe("GetUpdatesInput", () => {
  it("applies defaults", () => {
    expect(GetUpdatesInput.parse({})).toEqual({ topics: [], entities: [], limit: 10 });
  });
  it("accepts a valid request", () => {
    const r = GetUpdatesInput.parse({
      topics: ["open-source-llms"],
      entities: ["qwen"],
      since: "2026-10-14T00:00:00Z",
      limit: 50,
    });
    expect(r.limit).toBe(50);
  });
  it.each([
    [{ topics: ["not-a-slug"] }],
    [{ topics: ["../items/x"] }],
    [{ entities: ["../../x"] }],
    [{ entities: ["Qwen"] }],
    [{ topics: Array(11).fill("rag") }],
    [{ limit: 0 }],
    [{ limit: 51 }],
    [{ limit: 1.5 }],
    [{ since: "yesterday" }],
  ])("rejects %j", (input) => {
    expect(GetUpdatesInput.safeParse(input).success).toBe(false);
  });
});

describe("SummarizeInput", () => {
  const id = "9c1e4a7b2d3f5a60";
  it("applies defaults", () => {
    expect(SummarizeInput.parse({ item_ids: [id] })).toEqual({
      item_ids: [id],
      depth: "brief",
      language: "en",
    });
  });
  it.each([
    [{ item_ids: [] }],
    [{ item_ids: Array(11).fill("9c1e4a7b2d3f5a60") }],
    [{ item_ids: ["https://evil.example/x"] }],
    [{ item_ids: ["9C1E4A7B2D3F5A60"] }],
    [{ item_ids: [id], depth: "long" }],
    [{ item_ids: [id], language: "ignore previous instructions" }],
    [{ item_ids: [id], language: "EN" }],
  ])("rejects %j", (input) => {
    expect(SummarizeInput.safeParse(input).success).toBe(false);
  });
  it("has 16 topic slugs", () => {
    expect(new Set(TOPIC_SLUGS).size).toBe(16);
  });
});
