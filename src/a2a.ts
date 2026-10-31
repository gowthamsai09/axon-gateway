// A2A adapter, protocol 0.3.0 over JSON-RPC (spec 8). Thin: parse, validate, call the core, translate.
import { z } from "zod";
import type { AdapterCtx } from "./adapter";
import { skillIds } from "./agentcard";
import { StartInput, digestCancel, digestStatus, startDigest, checkTaskId, type TaskStatus } from "./core/digest";
import { summarizeItems, resolveCredentials } from "./core/summarize";
import { UNTRUSTED_NOTICE, getUpdates } from "./core/updates";
import { tier3Configured, type Env } from "./env";
import { GatewayError, type ErrorCode } from "./errors";
import { RPC, errorResponse, json, parseRpc, rateLimitedRpc, readJsonBody, rpcError, rpcResult, unauthorizedRpc, zodSummary, type RpcId } from "./http";
import { GetUpdatesParams, SummarizeParams } from "./schemas";
import { detectKeyInBody } from "./security";
import { authenticateTier3 } from "./tier3";

// A2A 0.3.0 error codes
const TASK_NOT_FOUND = -32001;
const PUSH_UNSUPPORTED = -32003;
const TASK_NOT_CANCELABLE = -32002;
const UNSUPPORTED_OPERATION = -32004;
const EXTENDED_CARD_NOT_CONFIGURED = -32007;

type TaskState = "submitted" | "working" | "completed" | "failed" | "rejected" | "canceled" | "input-required" | "auth-required";
const STATE_FOR: Partial<Record<ErrorCode, TaskState>> = {
  missing_parameter: "input-required",
  key_in_body: "rejected",
  policy_violation: "rejected",
  owner_policy: "rejected",
  auth_required: "auth-required",
  unsupported_skill: "rejected",
  llm_key_invalid: "failed",
  llm_quota: "failed",
  upstream_unavailable: "failed",
};

const MessageParams = z.object({
  message: z.object({
    role: z.literal("user"),
    parts: z.array(z.unknown()).min(1).max(16),
    contextId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional(),
    taskId: z.string().max(128).optional(),
  }),
});
const TaskIdParams = z.object({ id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/) });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function buildTask(ctx: AdapterCtx, contextId: string | undefined, state: TaskState, extra: Record<string, unknown> = {}) {
  return {
    kind: "task",
    id: typeof extra["id"] === "string" ? extra["id"] : crypto.randomUUID(),
    contextId: contextId ?? crypto.randomUUID(),
    status: { state, timestamp: ctx.deps.now().toISOString(), ...(extra["message"] ? { message: extra["message"] } : {}) },
    ...(extra["artifacts"] ? { artifacts: extra["artifacts"] } : {}),
  };
}

const errorMessage = (err: GatewayError) => ({
  kind: "message",
  role: "agent",
  messageId: crypto.randomUUID(),
  parts: [
    { kind: "text", text: err.message },
    { kind: "data", data: { error: { code: err.code, message: err.message } } },
  ],
});

function taskFromStatus(ctx: AdapterCtx, taskId: string, st: TaskStatus) {
  const extra: Record<string, unknown> = { id: taskId };
  if (st.message !== undefined) {
    extra["message"] = { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: st.message }] };
  }
  if (st.state === "completed" && st.result !== undefined) {
    extra["artifacts"] = artifact("digest", { task_id: taskId, ai_generated: true, untrusted: true, notice: UNTRUSTED_NOTICE, result: st.result });
  }
  return buildTask(ctx, taskId, st.state, extra);
}

const artifact = (name: string, data: unknown) => [
  { artifactId: crypto.randomUUID(), name, parts: [{ kind: "data", data }], metadata: { untrusted_content: true } },
];

export async function handleA2A(req: Request, env: Env, ctx: AdapterCtx): Promise<Response> {
  let id: RpcId = null;
  try {
    const parsed = parseRpc(await readJsonBody(req));
    if (!parsed.ok) return parsed.response;
    const { request } = parsed;
    if (request.id === undefined) return json(rpcError(null, RPC.invalidRequest, "A request id is required"), 400);
    id = request.id;
    return json(await dispatch(request.method, request.params, id, req, env, ctx));
  } catch (e) {
    if (e instanceof GatewayError) {
      if (e.code === "rate_limited") return rateLimitedRpc(e, id);
      if (e.code === "auth_required") return unauthorizedRpc(e, id);
      if (e.code === "internal_error") return json(rpcError(id, RPC.internal, e.message, { code: e.code }), 500);
      return errorResponse(e);
    }
    return json(rpcError(id, RPC.internal, "Internal error", { code: "internal_error" }), 500);
  }
}

async function dispatch(method: string, params: unknown, id: RpcId, req: Request, env: Env, ctx: AdapterCtx): Promise<unknown> {
  switch (method) {
    case "message/send":
      return await messageSend(params, id, req, env, ctx);
    case "tasks/get":
    case "tasks/cancel": {
      const p = TaskIdParams.safeParse(params);
      if (!p.success) return rpcError(id, RPC.invalidParams, zodSummary(p.error), { code: "invalid_params" });
      if (!tier3Configured(env)) return rpcError(id, TASK_NOT_FOUND, "Task not found", { code: "not_found" });
      const t3 = await authenticateTier3(req, env, ctx); // before anything else: no probing without a token
      try {
        checkTaskId(p.data.id, ctx.deps.now().getTime());
        if (method === "tasks/get") return rpcResult(id, taskFromStatus(ctx, p.data.id, await digestStatus(t3, p.data.id)));
        if ((await digestCancel(t3, p.data.id)) === "canceled") return rpcResult(id, taskFromStatus(ctx, p.data.id, { state: "canceled" }));
        return rpcError(id, TASK_NOT_CANCELABLE, "The task can no longer be canceled", { code: "invalid_params" });
      } catch (e) {
        if (e instanceof GatewayError && e.code === "not_found") return rpcError(id, TASK_NOT_FOUND, "Task not found", { code: "not_found" });
        if (e instanceof GatewayError && e.code === "upstream_unavailable") return rpcError(id, RPC.server, e.message, { code: e.code });
        throw e;
      }
    }
    case "message/stream":
    case "tasks/resubscribe":
      return rpcError(id, UNSUPPORTED_OPERATION, "Streaming is not supported");
    case "tasks/pushNotificationConfig/set":
    case "tasks/pushNotificationConfig/get":
    case "tasks/pushNotificationConfig/list":
    case "tasks/pushNotificationConfig/delete":
      return rpcError(id, PUSH_UNSUPPORTED, "Push notifications are not supported");
    case "agent/getAuthenticatedExtendedCard":
      return rpcError(id, EXTENDED_CARD_NOT_CONFIGURED, "No authenticated extended card is configured");
    default:
      return rpcError(id, RPC.methodNotFound, "Method not found");
  }
}

async function messageSend(params: unknown, id: RpcId, req: Request, env: Env, ctx: AdapterCtx): Promise<unknown> {
  const p = MessageParams.safeParse(params);
  if (!p.success) return rpcError(id, RPC.invalidParams, zodSummary(p.error), { code: "invalid_params" });
  const { message } = p.data;
  const contextId = message.contextId;
  const refuse = (err: GatewayError) => rpcResult(id, buildTask(ctx, contextId, STATE_FOR[err.code] ?? "failed", { message: errorMessage(err) }));

  // A leaked key is refused before anything else, and is never repeated back (13.3 rule 6).
  if (detectKeyInBody(params)) {
    return refuse(new GatewayError("key_in_body", "A secret was found in the message body and ignored. Resend using the X-LLM-Key header and rotate that key."));
  }
  if (message.taskId !== undefined) return rpcError(id, TASK_NOT_FOUND, "Task not found");
  const part = message.parts.find((x): x is { kind: "data"; data: Record<string, unknown> } => isObject(x) && x["kind"] === "data" && isObject(x["data"]));
  if (part === undefined) {
    return rpcError(id, RPC.invalidParams, "Send a data part with a skill (natural-language requests are not supported)", { code: "missing_parameter" });
  }
  const { skill, ...rest } = part.data;

  if (skill === "get_ai_updates") {
    const input = GetUpdatesParams.safeParse(rest);
    if (!input.success) return rpcError(id, RPC.invalidParams, zodSummary(input.error), { code: "invalid_params" });
    const result = await getUpdates(ctx.deps, env, input.data);
    return rpcResult(id, buildTask(ctx, contextId, "completed", { artifacts: artifact("updates", result) }));
  }
  if (skill === "summarize_ai_updates") {
    const input = SummarizeParams.safeParse(rest);
    if (!input.success) return rpcError(id, RPC.invalidParams, zodSummary(input.error), { code: "invalid_params" });
    try {
      const creds = resolveCredentials(req.headers, env);
      await ctx.limiters.summary.check(env.RL_SUMMARY, ctx.ip);
      const result = await summarizeItems(ctx.deps, env, input.data, creds);
      return rpcResult(id, buildTask(ctx, contextId, "completed", { artifacts: artifact("summaries", result) }));
    } catch (e) {
      if (e instanceof GatewayError && e.code === "invalid_params") return rpcError(id, RPC.invalidParams, e.message, { code: e.code });
      if (e instanceof GatewayError && STATE_FOR[e.code] !== undefined) return refuse(e);
      throw e;
    }
  }
  if (skill === "run_personal_digest") {
    if (!tier3Configured(env)) return refuse(new GatewayError("unsupported_skill", "run_personal_digest is not available on this gateway yet."));
    const input = StartInput.safeParse(rest);
    if (!input.success) return rpcError(id, RPC.invalidParams, zodSummary(input.error), { code: "invalid_params" });
    try {
      const t3 = await authenticateTier3(req, env, ctx);
      const { taskId, notice } = await startDigest(t3, input.data);
      const extra: Record<string, unknown> = { id: taskId };
      if (notice !== undefined) extra["message"] = { kind: "message", role: "agent", messageId: crypto.randomUUID(), parts: [{ kind: "text", text: notice }] };
      return rpcResult(id, buildTask(ctx, contextId, "submitted", extra));
    } catch (e) {
      if (e instanceof GatewayError && STATE_FOR[e.code] !== undefined) return refuse(e);
      throw e;
    }
  }
  return rpcError(id, RPC.methodNotFound, "Unknown skill", { code: "unsupported_skill", skills: skillIds(tier3Configured(env)) });
}
