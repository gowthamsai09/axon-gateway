// Tier 3 core (spec 9.3, 8.2): start, status, cancel. Task ids are lowercase UUIDv7 generated here
// (decision D2): the creation time is inside the id, so "dispatched but not listed yet" and "unknown
// or expired" can be told apart with no database. Everything runs against the repository bound to the
// authenticated token; the caller never supplies a repository, branch, workflow or destination.
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GatewayError } from "../errors";
import { GithubApp } from "../github/app";
import { cancelRun, dispatchDigest, findRun, readRepoFile, type RunInfo } from "../github/runs";
import type { Gh } from "../github/http";
import { TaskResult, type TaskResultT } from "../schemas";
import type { RegistrationRecord, TokenRecordT } from "../tokens";
import { uuidv7, uuidv7Time } from "../util";
import type { Deps } from "./deps";

export { TaskResult } from "../schemas";

export const MAX_PARAMS_BYTES = 4096;
export const RESULT_MAX_BYTES = 256 * 1024;
export const PROFILE_MAX_BYTES = 64 * 1024;
export const RETENTION_MS = 7 * 86_400_000;
export const SUBMITTED_GRACE_MS = 120_000; // a run can take a while to show up in the runs list
export const RESULT_GRACE_MS = 90_000; // the state-branch push happens after the run is marked complete

export const StartInput = z.strictObject({
  max_items: z.number().int().min(1).max(20).optional().describe("Maximum items in the digest (1 to 20)."),
  delivery: z.enum(["return_only", "owner_channel"]).default("return_only").describe("owner_channel also sends it to the owner, only if the owner's profile allows it."),
});
export type StartInputT = z.infer<typeof StartInput>;
export const StatusInput = z.strictObject({ task_id: z.string().max(64) });

/** The workflow's `params` input, built from validated values only. */
export function buildParams(input: StartInputT): string {
  const params: Record<string, unknown> = { delivery: input.delivery };
  if (input.max_items !== undefined) params["max_items"] = input.max_items;
  const text = JSON.stringify(params);
  if (new TextEncoder().encode(text).length > MAX_PARAMS_BYTES) throw new GatewayError("internal_error", "Invalid parameters.");
  return text;
}

export type Tier3Ctx = { gh: Gh; app: GithubApp; reg: RegistrationRecord; token: TokenRecordT; deps: Deps };

/** Tolerant reader of the profile's agent_access block (unknown keys ignored). Contract-tested against profile.schema.json. */
export const AgentAccess = z.object({
  allow_inbound_agents: z.boolean().optional(),
  allowed_modes: z.array(z.string()).optional(),
  allow_owner_channel: z.boolean().optional(),
});
export type AgentAccessT = z.infer<typeof AgentAccess>;
export const AGENT_ACCESS_FIELDS = Object.keys(AgentAccess.shape);

export type Policy = { refusal: string | null; access: AgentAccessT | null };

/** Best-effort pre-check (D3). Parses only `agent_access`; any problem returns no opinion and the pipeline decides. */
export async function readPolicy(ctx: Tier3Ctx, installToken: string): Promise<Policy> {
  const none: Policy = { refusal: null, access: null };
  let text: string | null;
  try {
    text = await readRepoFile(ctx.gh, installToken, ctx.reg.repo, "profile.yaml", ctx.reg.default_branch, PROFILE_MAX_BYTES);
  } catch (e) {
    if (e instanceof GatewayError) return none;
    throw e;
  }
  if (text === null) return none;
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 0 });
  } catch {
    return none;
  }
  const parsed = AgentAccess.safeParse((doc as { agent_access?: unknown } | null)?.agent_access);
  if (!parsed.success) return none;
  const access = parsed.data;
  if (access.allow_inbound_agents === false) return { refusal: "owner_policy: inbound agents are disabled", access };
  if (access.allowed_modes !== undefined && !access.allowed_modes.includes("digest")) return { refusal: "owner_policy: digest mode is not allowed", access };
  return { refusal: null, access };
}

export type Started = { taskId: string; notice?: string };
export const OWNER_CHANNEL_NOTICE = "owner_channel is not enabled in the owner's profile (agent_access.allow_owner_channel); the digest will be returned only.";

export async function startDigest(ctx: Tier3Ctx, input: StartInputT): Promise<Started> {
  const installToken = await ctx.app.installationToken(ctx.token.installation_id, ctx.reg.repo);
  const policy = await readPolicy(ctx, installToken);
  if (policy.refusal !== null) throw new GatewayError("owner_policy", policy.refusal.replace(/^owner_policy: /, "Owner policy: "));
  const taskId = uuidv7(ctx.deps.now().getTime());
  await dispatchDigest(ctx.gh, installToken, ctx.reg.repo, ctx.reg.default_branch, taskId, buildParams(input));
  const downgraded = input.delivery === "owner_channel" && policy.access !== null && policy.access.allow_owner_channel !== true;
  return downgraded ? { taskId, notice: OWNER_CHANNEL_NOTICE } : { taskId };
}

export type TaskState = "submitted" | "working" | "completed" | "failed" | "rejected" | "canceled";
export type TaskStatus = { state: TaskState; message?: string; result?: TaskResultT };

/** Table-tested mapping (spec 8.2) from a run and its result file to an A2A state. */
export function mapRun(run: RunInfo | null, ageMs: number, result: { found: false } | { found: true; value: TaskResultT | "invalid" }, nowMs: number): TaskStatus {
  if (run === null) {
    // Not listed yet. Older than the grace period it is unknown (the caller turns that into TaskNotFound).
    if (ageMs >= SUBMITTED_GRACE_MS) throw new GatewayError("not_found", "Task not found.");
    return { state: "submitted" };
  }
  const status = run.status ?? "";
  if (status !== "completed") return { state: status === "in_progress" ? "working" : "submitted" };
  switch (run.conclusion) {
    case "success": {
      if (!result.found) {
        return nowMs - Date.parse(run.updated_at) < RESULT_GRACE_MS ? { state: "working" } : { state: "failed", message: "The run finished but wrote no result." };
      }
      if (result.value === "invalid") return { state: "failed", message: "The run wrote a result the gateway could not read." };
      if (result.value.status === "failed") {
        const refusal = result.value.warnings.find((w) => w.startsWith("owner_policy:"));
        return refusal !== undefined ? { state: "rejected", message: refusal, result: result.value } : { state: "failed", message: "The digest run failed.", result: result.value };
      }
      return { state: "completed", result: result.value };
    }
    case "cancelled":
      return { state: "canceled" };
    default:
      return { state: "failed", message: "The digest run failed. The owner can see details in the Actions log." };
  }
}

/** Validates the id, enforces retention and returns its creation time. Same error for every bad id. */
export function checkTaskId(id: string, nowMs: number): number {
  const created = uuidv7Time(id);
  if (created === null || created > nowMs + 60_000 || nowMs - created > RETENTION_MS) {
    throw new GatewayError("not_found", "Task not found.");
  }
  return created;
}

async function readResult(ctx: Tier3Ctx, installToken: string, taskId: string): Promise<{ found: false } | { found: true; value: TaskResultT | "invalid" }> {
  const text = await readRepoFile(ctx.gh, installToken, ctx.reg.repo, `tasks/${taskId}.json`, "state", RESULT_MAX_BYTES);
  if (text === null) return { found: false };
  try {
    const p = TaskResult.safeParse(JSON.parse(text));
    return { found: true, value: p.success && p.data.task_id === taskId ? p.data : "invalid" };
  } catch {
    return { found: true, value: "invalid" };
  }
}

export async function digestStatus(ctx: Tier3Ctx, taskId: string): Promise<TaskStatus> {
  const nowMs = ctx.deps.now().getTime();
  const created = checkTaskId(taskId, nowMs);
  const installToken = await ctx.app.installationToken(ctx.token.installation_id, ctx.reg.repo);
  const run = await findRun(ctx.gh, installToken, ctx.reg.repo, taskId, created);
  if (run === null) return mapRun(null, nowMs - created, { found: false }, nowMs);
  const needsResult = run.status === "completed" && run.conclusion === "success";
  const result = needsResult ? await readResult(ctx, installToken, taskId) : ({ found: false } as const);
  return mapRun(run, nowMs - created, result, nowMs);
}

export async function digestCancel(ctx: Tier3Ctx, taskId: string): Promise<"canceled" | "not_cancelable"> {
  const nowMs = ctx.deps.now().getTime();
  const created = checkTaskId(taskId, nowMs);
  const installToken = await ctx.app.installationToken(ctx.token.installation_id, ctx.reg.repo);
  const run = await findRun(ctx.gh, installToken, ctx.reg.repo, taskId, created);
  if (run === null) {
    if (nowMs - created < SUBMITTED_GRACE_MS) return "not_cancelable"; // not listed yet: nothing to cancel safely
    throw new GatewayError("not_found", "Task not found.");
  }
  if (run.status === "completed") return "not_cancelable";
  return (await cancelRun(ctx.gh, installToken, ctx.reg.repo, run.id)) ? "canceled" : "not_cancelable";
}
