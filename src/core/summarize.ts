// Tier 2 (spec 7.5, 7.6, 13.1, brief 4.3): summaries with the CALLER's key. The key is read from headers
// by the adapters, passed in as a plain value, held for this one request and never stored anywhere.
import { SubrequestBudget, isBudgetError, budgeted, mapPool } from "../budget";
import { DEFAULT_DEEPSEEK_MODEL, allowedProviders, feedBase, hfDefaultModel, type Env, type ProviderName } from "../env";
import { GatewayError } from "../errors";
import { ProviderClient, deprecationWarning } from "../providers";
import { ApiKeyHeader, ModelHeader, SummarizeInput } from "../schemas";
import { summarizeOne } from "../summarizer/llm";
import { promptVersion, truncate } from "../summarizer/prompting";
import { BadResponseError, newUsage, addUsage, type SourceItem, type Usage } from "../summarizer/types";
import { SummaryValidationError, type Summary } from "../summarizer/validation";
import type { z } from "zod";
import type { Deps } from "./deps";
import { FeedReader, parseItemFile } from "./feed";
import { UNTRUSTED_NOTICE } from "./updates";

export type SummarizeParams = z.infer<typeof SummarizeInput>;
export type Credentials = { provider: ProviderName; key: string; model: string };

export const CONCURRENCY = 3;
export const MAX_TRANSIENT_FAILURES = 2;

/** Reads X-LLM-Provider, X-LLM-Key and optional X-LLM-Model. Never echoes a header value. */
export function resolveCredentials(headers: Headers, env: Partial<Env>): Credentials {
  const providers = allowedProviders(env);
  const rawProvider = headers.get("x-llm-provider");
  if (rawProvider === null) throw new GatewayError("missing_parameter", "The X-LLM-Provider header is required.");
  const provider = rawProvider === rawProvider.trim()
    ? providers.find((p) => p === rawProvider.toLowerCase())
    : undefined;
  if (provider === undefined) {
    throw new GatewayError("invalid_params", `X-LLM-Provider must be one of: ${providers.join(", ") || "(none enabled)"}.`);
  }
  const rawKey = headers.get("x-llm-key");
  if (rawKey === null || rawKey.trim() === "") throw new GatewayError("missing_parameter", "The X-LLM-Key header is required.");
  const key = rawKey.trim();
  if (!ApiKeyHeader.safeParse(key).success) {
    throw new GatewayError("llm_key_invalid", "X-LLM-Key must be a single, well-formed API key.");
  }
  const rawModel = headers.get("x-llm-model");
  let model = provider === "deepseek" ? DEFAULT_DEEPSEEK_MODEL : hfDefaultModel(env);
  if (rawModel !== null) {
    const parsed = ModelHeader.safeParse(rawModel.trim());
    if (!parsed.success) throw new GatewayError("invalid_params", "X-LLM-Model contains characters that are not allowed.");
    model = parsed.data;
  }
  return { provider, key, model };
}

export type ItemStatus = "ok" | "insufficient_content" | "suspected_injection" | "not_summarized" | "not_found";
export type ItemResult = {
  id: string;
  status: ItemStatus;
  title?: string;
  url?: string;
  source?: string;
  summary?: Omit<Summary, "status" | "title" | "source_url">;
  snippet?: string;
  reason?: string;
};

export type SummarizeResult = {
  results: ItemResult[];
  provider: ProviderName;
  model: string;
  prompt_version: string;
  depth: string;
  language: string;
  usage: Usage;
  ai_generated: true;
  warnings: string[];
  untrusted: true;
  notice: string;
};

const extractive = (snippet: string, text: string): string => {
  const raw = (snippet || text).split(/\s+/).filter(Boolean).join(" ");
  return raw.length > 300 ? truncate(raw, 297) + "..." : raw || "(no preview available)";
};

export async function summarizeItems(
  deps: Deps,
  env: Partial<Env>,
  input: SummarizeParams,
  creds: Credentials,
): Promise<SummarizeResult> {
  const budget = new SubrequestBudget();
  const fetchFn = budgeted(deps.fetch, budget);
  const reader = new FeedReader(feedBase(env), fetchFn);
  const client = new ProviderClient({
    provider: creds.provider,
    model: creds.model,
    key: creds.key,
    fetch: fetchFn,
    sleep: deps.sleep,
    rng: deps.rng,
  });
  const usage = newUsage();
  const warnings: string[] = [];
  const legacy = deprecationWarning(creds.provider, creds.model);
  if (legacy) warnings.push(legacy);

  let fatal: GatewayError | undefined;
  let transient = 0;
  let produced = 0;
  const ids = [...new Set(input.item_ids)];

  const one = async (id: string): Promise<ItemResult> => {
    const skip = (reason: string): ItemResult => ({ id, status: "not_summarized", reason });
    if (fatal !== undefined) return skip("skipped_after_key_or_quota_error");
    if (transient >= MAX_TRANSIENT_FAILURES) return skip("skipped_after_upstream_errors");
    let file;
    try {
      const read = await reader.read(`items/${id}.json`);
      if (read.status === "missing") return { id, status: "not_found", reason: "no such item in the feed" };
      file = parseItemFile(read.data);
    } catch (e) {
      if (isBudgetError(e)) return skip("subrequest_budget");
      if (e instanceof GatewayError) {
        transient += 1;
        return skip("feed_unavailable");
      }
      throw e;
    }
    if (file === null) return skip("invalid_feed_item");
    const text = file.excerpt?.trim() ? file.excerpt : file.snippet;
    const source: SourceItem = {
      id,
      title: file.title,
      url: file.canonical_url,
      sourceName: file.source_id,
      publishedAt: file.published_at,
      text,
    };
    const base = { id, title: file.title, url: file.canonical_url, source: file.source_id };
    const fallback = { snippet: extractive(file.snippet, text) };
    try {
      const local = newUsage();
      let summary: Summary;
      try {
        summary = await summarizeOne(client, source, input.depth, input.language, local, warnings, deps.nonce, [creds.key]);
      } finally {
        addUsage(usage, local);
      }
      produced += 1;
      if (summary.status !== "ok") {
        if (summary.status === "suspected_injection") warnings.push(`${id}: suspected prompt injection in the source`);
        return { ...base, status: summary.status, ...fallback };
      }
      if (summary.injection_flag) warnings.push(`${id}: injection flag set by the summarizer`);
      return {
        ...base,
        status: "ok",
        summary: {
          one_line: summary.one_line,
          key_points: summary.key_points,
          why_it_matters: summary.why_it_matters,
          tags: summary.tags,
          entities: summary.entities,
          notable_figures: summary.notable_figures,
          injection_flag: summary.injection_flag,
        },
      };
    } catch (e) {
      if (e instanceof GatewayError) {
        if (e.code === "llm_key_invalid" || e.code === "llm_quota") {
          fatal ??= e;
          return { ...base, status: "not_summarized", reason: e.code, ...fallback };
        }
        transient += 1;
        return { ...base, status: "not_summarized", reason: "upstream_unavailable", ...fallback };
      }
      if (isBudgetError(e)) return { ...base, status: "not_summarized", reason: "subrequest_budget", ...fallback };
      if (e instanceof BadResponseError) return { ...base, status: "not_summarized", reason: "provider_bad_response", ...fallback };
      if (e instanceof SummaryValidationError) {
        warnings.push(`${id}: summary rejected (${e.message})`);
        return { ...base, status: "not_summarized", reason: "invalid_model_output", ...fallback };
      }
      throw e;
    }
  };

  const results = await mapPool(ids, CONCURRENCY, one);
  if (fatal !== undefined) throw fatal;
  if (produced === 0 && transient > 0) {
    throw new GatewayError("upstream_unavailable", "The summarizer or the feed was unavailable. Retry later.");
  }
  return {
    results,
    provider: creds.provider,
    model: creds.model,
    prompt_version: await promptVersion(),
    depth: input.depth,
    language: input.language,
    usage,
    ai_generated: true,
    warnings: warnings.slice(0, 50).map((w) => w.slice(0, 300)),
    untrusted: true,
    notice: UNTRUSTED_NOTICE,
  };
}
