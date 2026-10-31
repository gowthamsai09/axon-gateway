import { z } from "zod";
import { GatewayError, errorBody, HTTP_STATUS } from "./errors";

export const MAX_BODY_BYTES = 16 * 1024;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(err: GatewayError): Response {
  const headers: Record<string, string> = {};
  if (err.retryAfter !== undefined) headers["retry-after"] = String(err.retryAfter);
  if (err.code === "auth_required") headers["www-authenticate"] = "Bearer";
  return json(errorBody(err.code, err.message), HTTP_STATUS[err.code], headers);
}

export type Body = { kind: "ok"; value: unknown } | { kind: "parse_error" };

/** Content type, size cap and JSON syntax. Throws GatewayError for 415 and 413. */
export async function readJsonBody(req: Request, maxBytes: number = MAX_BODY_BYTES): Promise<Body> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    throw new GatewayError("unsupported_media_type", "Content-Type must be application/json.");
  }
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) {
    throw new GatewayError("payload_too_large", "The request body is too large.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body !== null) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new GatewayError("payload_too_large", "The request body is too large.");
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { kind: "parse_error" };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown };
  } catch {
    return { kind: "parse_error" };
  }
}

// ---- JSON-RPC 2.0 ------------------------------------------------------------------------
export type RpcId = string | number | null;
export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  server: -32000, // implementation-defined (A2A and MCP both leave -32000 to implementations)
} as const;

export const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(256), z.number().int()]).optional(),
  method: z.string().min(1).max(128),
  params: z.unknown().optional(),
});
export type RpcRequestT = z.infer<typeof RpcRequest>;

export const rpcResult = (id: RpcId, result: unknown): unknown => ({ jsonrpc: "2.0", id, result });
export const rpcError = (id: RpcId, code: number, message: string, data?: unknown): unknown => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/** Parses one JSON-RPC request. Batches and malformed envelopes get a 400 with a JSON-RPC error. */
export function parseRpc(body: Body): { ok: true; request: RpcRequestT } | { ok: false; response: Response } {
  if (body.kind === "parse_error") {
    return { ok: false, response: json(rpcError(null, RPC.parse, "Parse error"), 400) };
  }
  if (Array.isArray(body.value)) {
    return {
      ok: false,
      response: json(rpcError(null, RPC.invalidRequest, "JSON-RPC batches are not supported"), 400),
    };
  }
  const parsed = RpcRequest.safeParse(body.value);
  if (!parsed.success) {
    return { ok: false, response: json(rpcError(null, RPC.invalidRequest, "Invalid request"), 400) };
  }
  return { ok: true, request: parsed.data };
}

export function rateLimitedRpc(err: GatewayError, id: RpcId): Response {
  return json(rpcError(id, RPC.server, err.message, { code: err.code }), 429, {
    "retry-after": String(err.retryAfter ?? 60),
  });
}

export function zodSummary(error: z.ZodError): string {
  const paths = [...new Set(error.issues.map((i) => i.path.join(".") || "<root>"))].slice(0, 5);
  return "Invalid params in: " + paths.join(", ");
}

/** 401 for a JSON-RPC endpoint: a JSON-RPC error body plus WWW-Authenticate. */
export function unauthorizedRpc(err: GatewayError, id: RpcId): Response {
  return json(rpcError(id, RPC.server, err.message, { code: err.code }), 401, { "www-authenticate": "Bearer" });
}
