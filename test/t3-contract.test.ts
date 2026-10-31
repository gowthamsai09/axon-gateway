// Contract tests: the gateway's tolerant agent_access reader against the exported profile schema,
// and TaskResult fixtures against task-result.schema.json (same skip rule as the Phase 3 contract tests).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_ACCESS_FIELDS, AgentAccess, OWNER_CHANNEL_NOTICE } from "../src/core/digest";
import { TaskResult } from "../src/schemas";
import { at, bodyOf } from "./helpers";
import { makeKit } from "./t3-helpers";

const dir = resolve(process.env["HUB_SCHEMAS_DIR"] ?? "../Axon/schemas");
const have = existsSync(resolve(dir, "profile.schema.json"));
if (!have && process.env["REQUIRE_HUB_SCHEMAS"] === "1") throw new Error("hub schemas required but missing");
const load = (n: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(dir, n), "utf8")) as Record<string, unknown>;

describe.skipIf(!have)("agent_access reader vs profile.schema.json", () => {
  const profile = () => load("profile.schema.json");
  const accessProps = () => ((profile()["$defs"] as Record<string, { properties: Record<string, unknown> }>)["AgentAccess"] as { properties: Record<string, unknown> }).properties;

  it("every field the gateway reads exists in the profile schema, with the same type", () => {
    const props = accessProps() as Record<string, { type?: string }>;
    for (const f of AGENT_ACCESS_FIELDS) expect(Object.keys(props)).toContain(f);
    expect(props["allow_owner_channel"]?.type).toBe("boolean");
    expect(props["allow_inbound_agents"]?.type).toBe("boolean");
  });

  it("a block the schema accepts is read without loss", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const check = ajv.compile(profile());
    const doc = {
      version: 1,
      interests: { topics: ["rag"], follow_entities: [], keywords_include: [], keywords_exclude: [] },
      sources: { use_shared_feed: true, extra_rss: [] },
      delivery: { channel: "email", frequency: "daily", send_time_local: "07:30", timezone: "UTC", depth: "brief", max_items: 5, language: "en" },
      summarizer: { provider: "deepseek", model: "deepseek-v4-flash" },
      agent_access: { allow_inbound_agents: true, allowed_modes: ["data", "digest"], max_tier3_runs_per_day: 5, allow_owner_channel: true },
    };
    expect(check(doc)).toBe(true);
    expect(AgentAccess.parse(doc.agent_access)).toMatchObject({ allow_inbound_agents: true, allowed_modes: ["data", "digest"], allow_owner_channel: true });
  });

  it("an old profile without the flag still validates", () => {
    const props = accessProps();
    expect(Object.keys(props)).toContain("allow_owner_channel");
    expect((profile()["$defs"] as Record<string, { required?: string[] }>)["AgentAccess"]?.required ?? []).not.toContain("allow_owner_channel");
  });

  it("TaskResult accepts what the template schema accepts and refuses what it refuses", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const check = ajv.compile(load("task-result.schema.json"));
    const good = { task_id: "01a18b17-aff2-7e5b-ac28-6d150dd0950c", status: "completed", finished_at: "2026-10-20T06:00:00Z", items: [{ id: "0123456789abcdef", title: "t", url: "https://example.com/a", fallback_snippet: "s" }], model: { provider: "deepseek", model: "m" }, warnings: [] };
    // "exactly one of summary or fallback_snippet" is a pydantic validator the exported JSON Schema cannot express, so use an extra key.
    const bad = { ...good, extra: 1 };
    expect(check(good)).toBe(true);
    expect(TaskResult.safeParse(good).success).toBe(true);
    expect(check(bad)).toBe(false);
    expect(TaskResult.safeParse(bad).success).toBe(false);
  });
});

describe("owner_channel notice", () => {
  const profile = (flag: string) => `agent_access:\n  allow_inbound_agents: true\n  allowed_modes: [data, summary, digest]\n${flag}`;
  it.each([
    ["flag absent", "", true],
    ["flag false", "  allow_owner_channel: false\n", true],
    ["flag true", "  allow_owner_channel: true\n", false],
  ])("A2A start with owner_channel and %s", async (_n, flag, notice) => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.gh.state.files.set("main:profile.yaml", profile(flag));
    const body = await bodyOf(await k.send({ skill: "run_personal_digest", delivery: "owner_channel" }, k.bearer(token)));
    expect(at(body, "result.status.state")).toBe("submitted");
    expect(JSON.stringify(at(body, "result.status.message") ?? "").includes("allow_owner_channel")).toBe(notice);
    const d = k.gh.calls.find((c) => c.path.endsWith("/dispatches"));
    expect((d?.body as { inputs: { params: string } }).inputs.params).toContain("owner_channel"); // still forwarded: the pipeline decides
  });

  it("gives no notice for return_only, nor when the profile cannot be read", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.gh.state.files.set("main:profile.yaml", profile(""));
    expect(at(await bodyOf(await k.send({ skill: "run_personal_digest" }, k.bearer(token))), "result.status.message")).toBeUndefined();
    k.gh.state.files.delete("main:profile.yaml");
    expect(at(await bodyOf(await k.send({ skill: "run_personal_digest", delivery: "owner_channel" }, k.bearer(token))), "result.status.message")).toBeUndefined();
  });

  it("MCP start_digest carries the same notice", async () => {
    const k = await makeKit();
    const { token } = await k.ready();
    k.gh.state.files.set("main:profile.yaml", profile(""));
    const res = await k.call("POST", "/mcp", k.bearer(token), { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "start_digest", arguments: { delivery: "owner_channel" } } });
    expect(at(await bodyOf(res), "result.structuredContent.notice")).toBe(OWNER_CHANNEL_NOTICE);
  });
});
