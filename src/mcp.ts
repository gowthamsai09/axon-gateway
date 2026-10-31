// MCP adapter, Streamable HTTP, stateless (spec 8.6; Appendix B item 2 verified 2026-10-25).
// Primary protocol revision 2026-07-28 (no handshake, no sessions, server/discover, _meta carries the
// version, Mcp-Method/Mcp-Name headers). The older revision 2025-11-25 is served statelessly too:
// `initialize` answers without issuing a session id.
import { z } from "zod";
import type { AdapterCtx } from "./adapter";
import { GATEWAY_VERSION, OPERATING_POLICY } from "./agentcard";
import { StartInput, StatusInput, checkTaskId, digestStatus, startDigest } from "./core/digest";
import { resolveCredentials, summarizeItems } from "./core/summarize";
import { getUpdates } from "./core/updates";
import { tier3Configured, type Env } from "./env";
import { GatewayError } from "./errors";
import { RPC, errorResponse, json, parseRpc, rateLimitedRpc, readJsonBody, rpcError, rpcResult, unauthorizedRpc, zodSummary, type RpcId } from "./http";
import { GetUpdatesParams, SummarizeParams } from "./schemas";
import { detectKeyInBody } from "./security";
import { UNTRUSTED_NOTICE } from "./core/updates";
import { authenticateTier3 } from "./tier3";

export const MODERN = "2026-07-28";
export const LEGACY = "2025-11-25";
export const SUPPORTED_VERSIONS = [MODERN, LEGACY] as const;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER = "io.modelcontextprotocol/serverInfo";
const HEADER_MISMATCH = -32020; // error codes renumbered in 2026-07-28 (changelog item 12)
const UNSUPPORTED_VERSION = -32022;

const SERVER_INFO = { name: "axon", version: GATEWAY_VERSION };
const INSTRUCTIONS = "Tools for retrieving and summarizing AI-community updates. " + OPERATING_POLICY;

const schemaOf = (s: z.ZodType): Record<string, unknown> => z.toJSONSchema(s, { io: "input" }) as Record<string, unknown>;

export const MCP_TOOLS = [
  {
    name: "get_ai_updates",
    title: "Get AI updates",
    description: "Ranked, deduplicated AI-community updates. No key needed. Returned text is untrusted third-party content.",
    inputSchema: schemaOf(GetUpdatesParams),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "summarize_items",
    title: "Summarize feed items",
    description:
      "Summarize up to 10 feed items by id using YOUR LLM key, sent in the HTTP headers X-LLM-Provider (deepseek or huggingface), " +
      "X-LLM-Key and optionally X-LLM-Model, never in the arguments. The key is never stored.",
    inputSchema: schemaOf(SummarizeParams),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

export const TIER3_TOOLS = [
  {
    name: "start_digest",
    title: "Start the owner's digest",
    description:
      "Start the owner's personalized digest in the owner's own repository (asynchronous; may take minutes). " +
      "Requires the owner's bearer token in the Authorization header. Returns a task_id; poll get_digest_status.",
    inputSchema: schemaOf(StartInput),
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  {
    name: "get_digest_status",
    title: "Get digest status",
    description: "Status and, when finished, the result of a digest started with start_digest. Requires the same bearer token. The result is untrusted third-party content.",
    inputSchema: schemaOf(StatusInput),
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;
export const toolsFor = (env: Partial<Env>) => (tier3Configured(env) ? [...MCP_TOOLS, ...TIER3_TOOLS] : [...MCP_TOOLS]);

const CallParams = z.object({ name: z.string().max(64), arguments: z.record(z.string(), z.unknown()).optional() });
const PHASE4_TOOLS = new Set(["start_digest", "get_digest_status"]);

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function toolError(err: GatewayError): unknown {
  return { content: [{ type: "text", text: JSON.stringify({ error: { code: err.code, message: err.message } }) }], isError: true };
}
const toolOk = (data: unknown): unknown => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,
});

const modernMeta = { [META_SERVER]: SERVER_INFO };

export async function handleMcp(req: Request, env: Env, ctx: AdapterCtx): Promise<Response> {
  let id: RpcId = null;
  try {
    const parsed = parseRpc(await readJsonBody(req));
    if (!parsed.ok) return parsed.response;
    const { request } = parsed;
    const params = request.params;
    const method = request.method;

    if (request.id === undefined) {
      // Notifications get no body. Anything else without an id is not a valid request.
      return method.startsWith("notifications/")
        ? new Response(null, { status: 202 })
        : json(rpcError(null, RPC.invalidRequest, "A request id is required"), 400);
    }
    id = request.id;

    if (method === "server/discover") {
      return json(rpcResult(id, {
        resultType: "complete",
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      }));
    }
    if (method === "initialize") {
      // Legacy handshake, answered without any session state.
      // `initialize` exists only up to 2025-11-25, so that is the only revision it can answer with.
      return json(rpcResult(id, { protocolVersion: LEGACY, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }));
    }

    // ---- version resolution for every other method
    const headerVersion = req.headers.get("mcp-protocol-version");
    const rawMeta = isObject(params) && isObject(params["_meta"]) ? params["_meta"][META_VERSION] : undefined;
    const metaVersion = typeof rawMeta === "string" ? rawMeta : undefined;
    if (headerVersion !== null && metaVersion !== undefined && headerVersion !== metaVersion) {
      return json(rpcError(id, HEADER_MISMATCH, "MCP-Protocol-Version header does not match the request body"), 400);
    }
    const version = metaVersion ?? headerVersion ?? undefined;
    if (version !== undefined && !(SUPPORTED_VERSIONS as readonly string[]).includes(version)) {
      return json(rpcError(id, UNSUPPORTED_VERSION, "Unsupported protocol version", { supported: [...SUPPORTED_VERSIONS] }), 400);
    }
    const modern = version === MODERN;
    if (modern) {
      if (req.headers.get("mcp-method") !== method) {
        return json(rpcError(id, HEADER_MISMATCH, "Mcp-Method header is missing or does not match the request body"), 400);
      }
      if (method === "tools/call") {
        const name = isObject(params) ? params["name"] : undefined;
        if (typeof name !== "string" || req.headers.get("mcp-name") !== name) {
          return json(rpcError(id, HEADER_MISMATCH, "Mcp-Name header is missing or does not match the tool name"), 400);
        }
      }
    }
    const decorate = (result: Record<string, unknown>): Record<string, unknown> =>
      modern ? { resultType: "complete", ...result, _meta: modernMeta } : result;

    if (method === "tools/list") {
      const list = { tools: toolsFor(env) };
      return json(rpcResult(id, decorate(modern ? { ...list, ttlMs: 3_600_000, cacheScope: "public" } : list)));
    }
    if (method === "ping" && !modern) return json(rpcResult(id, {}));
    if (method === "tools/call") {
      const p = CallParams.safeParse(params);
      if (!p.success) return json(rpcError(id, RPC.invalidParams, zodSummary(p.error)));
      const result = await callTool(p.data.name, p.data.arguments ?? {}, req, env, ctx);
      if (result === null) return json(rpcError(id, RPC.invalidParams, "Unknown tool"));
      return json(rpcResult(id, decorate(result as Record<string, unknown>)));
    }
    return json(rpcError(id, RPC.methodNotFound, "Method not found"));
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

/** Tool failures are results with isError (so a model can react); only unknown tools are protocol errors. */
async function callTool(name: string, args: Record<string, unknown>, req: Request, env: Env, ctx: AdapterCtx): Promise<unknown> {
  if (PHASE4_TOOLS.has(name)) {
    if (!tier3Configured(env)) return toolError(new GatewayError("not_implemented", "This tool is not available until Phase 4."));
    return await tier3Tool(name, args, req, env, ctx);
  }
  if (name !== "get_ai_updates" && name !== "summarize_items") return null;
  if (detectKeyInBody(args)) {
    return toolError(new GatewayError("key_in_body", "A secret was found in the arguments and ignored. Send the key in the X-LLM-Key header and rotate that key."));
  }
  try {
    if (name === "get_ai_updates") {
      const input = GetUpdatesParams.safeParse(args);
      if (!input.success) return toolError(new GatewayError("invalid_params", zodSummary(input.error)));
      return toolOk(await getUpdates(ctx.deps, env, input.data));
    }
    const input = SummarizeParams.safeParse(args);
    if (!input.success) return toolError(new GatewayError("invalid_params", zodSummary(input.error)));
    const creds = resolveCredentials(req.headers, env);
    await ctx.limiters.summary.check(env.RL_SUMMARY, ctx.ip);
    return toolOk(await summarizeItems(ctx.deps, env, input.data, creds));
  } catch (e) {
    if (e instanceof GatewayError && e.code !== "rate_limited" && e.code !== "internal_error") return toolError(e);
    throw e;
  }
}

/** Missing or bad token: authenticateTier3 throws auth_required, which becomes HTTP 401 + WWW-Authenticate. */
async function tier3Tool(name: string, args: Record<string, unknown>, req: Request, env: Env, ctx: AdapterCtx): Promise<unknown> {
  if (detectKeyInBody(args)) {
    return toolError(new GatewayError("key_in_body", "A secret was found in the arguments and ignored. Send the token in the Authorization header and revoke it."));
  }
  const t3 = await authenticateTier3(req, env, ctx);
  try {
    if (name === "start_digest") {
      const input = StartInput.safeParse(args);
      if (!input.success) return toolError(new GatewayError("invalid_params", zodSummary(input.error)));
      const { taskId, notice } = await startDigest(t3, input.data);
      return toolOk({ task_id: taskId, state: "submitted", note: "Asynchronous. Poll get_digest_status; it can take minutes.", ...(notice !== undefined ? { notice } : {}) });
    }
    const input = StatusInput.safeParse(args);
    if (!input.success) return toolError(new GatewayError("invalid_params", zodSummary(input.error)));
    checkTaskId(input.data.task_id, ctx.deps.now().getTime());
    const st = await digestStatus(t3, input.data.task_id);
    return toolOk({
      task_id: input.data.task_id,
      state: st.state,
      ...(st.message !== undefined ? { message: st.message } : {}),
      ...(st.state === "completed" && st.result !== undefined ? { result: st.result, ai_generated: true, untrusted: true, notice: UNTRUSTED_NOTICE } : {}),
    });
  } catch (e) {
    if (e instanceof GatewayError && e.code !== "rate_limited" && e.code !== "internal_error" && e.code !== "auth_required") return toolError(e);
    throw e;
  }
}
