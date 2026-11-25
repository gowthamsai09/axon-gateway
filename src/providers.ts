// Tier 2 provider adapter (spec 7.6, Appendix C 32). Provider names map to FIXED base URLs: callers
// can never supply a URL. The key lives in a private field and only in the Authorization header of
// the upstream request; no message below ever contains it or any request header.
import { isBudgetError, type FetchFn } from "./budget";
import type { ProviderName } from "./env";
import { GatewayError } from "./errors";
import { BadResponseError, type ChatClient, type ChatResult } from "./summarizer/types";

export const PROVIDER_BASE_URLS: Record<ProviderName, string> = {
  deepseek: "https://api.deepseek.com",
  huggingface: "https://router.huggingface.co/v1",
};
export const LEGACY_DEEPSEEK_MODELS = new Set(["deepseek-chat", "deepseek-reasoner"]);
const MAX_RETRY_AFTER_S = 5; // a Worker request should not sit idle for long
const MAX_ATTEMPTS = 3;

export function deprecationWarning(provider: ProviderName, model: string): string | null {
  return provider === "deepseek" && LEGACY_DEEPSEEK_MODELS.has(model)
    ? `model ${model} was retired by DeepSeek on 2026-07-24; use deepseek-flash`
    : null;
}

export type ClientOptions = {
  provider: ProviderName;
  model: string;
  key: string;
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  maxTokens?: number;
};

export class ProviderClient implements ChatClient {
  readonly provider: string;
  readonly model: string;
  readonly #key: string;
  readonly #url: string;
  readonly #opts: ClientOptions;
  #jsonMode = true;

  constructor(opts: ClientOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.#key = opts.key;
    this.#url = PROVIDER_BASE_URLS[opts.provider] + "/chat/completions";
    this.#opts = opts;
  }

  toJSON(): unknown {
    return { provider: this.provider, model: this.model };
  }

  #payload(system: string, user: string): string {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: this.#opts.maxTokens ?? 1500,
      temperature: 0.2,
      stream: false,
    };
    if (this.#jsonMode) body["response_format"] = { type: "json_object" };
    if (this.provider === "deepseek" && this.model.startsWith("deepseek-v4")) body["thinking"] = { type: "disabled" };
    return JSON.stringify(body);
  }

  async complete(system: string, user: string): Promise<ChatResult> {
    let last: GatewayError | undefined;
    let attempt = 0;
    let jsonRetryUsed = false;
    while (attempt < MAX_ATTEMPTS) {
      let resp: Response | undefined;
      try {
        resp = await this.#opts.fetch(this.#url, {
          method: "POST",
          headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json" },
          body: this.#payload(system, user),
          redirect: "manual",
        });
      } catch (e) {
        if (isBudgetError(e)) throw e;
        last = new GatewayError("upstream_unavailable", `${this.provider}: network error`);
      }
      if (resp !== undefined) {
        const code = resp.status;
        if (code === 200) return await this.#parse(resp);
        if (code === 401 || code === 403) throw new GatewayError("llm_key_invalid", `${this.provider}: the API key was rejected.`);
        if (code === 402) throw new GatewayError("llm_quota", `${this.provider}: the account balance is exhausted.`);
        if ((code === 400 || code === 422) && this.#jsonMode && !jsonRetryUsed) {
          jsonRetryUsed = true;
          this.#jsonMode = false; // some models reject JSON mode; validation never depends on it
          continue;
        }
        if (code === 429) last = new GatewayError("upstream_unavailable", `${this.provider}: rate limited by the provider.`);
        else if (code >= 500) last = new GatewayError("upstream_unavailable", `${this.provider}: HTTP ${code}.`);
        else throw new BadResponseError(`${this.provider}: HTTP ${code}`);
      }
      attempt += 1;
      if (attempt < MAX_ATTEMPTS) await this.#backoff(attempt, resp);
    }
    throw last ?? new GatewayError("upstream_unavailable", `${this.provider}: unavailable.`);
  }

  async #backoff(attempt: number, resp: Response | undefined): Promise<void> {
    let delay = Math.min(4, 2 ** attempt * 0.5) * (0.5 + this.#opts.rng());
    const retryAfter = resp?.headers.get("retry-after");
    if (retryAfter && /^\d{1,4}$/.test(retryAfter)) delay = Math.max(delay, Math.min(Number(retryAfter), MAX_RETRY_AFTER_S));
    await this.#opts.sleep(delay * 1000);
  }

  async #parse(resp: Response): Promise<ChatResult> {
    let data: unknown;
    try {
      data = await resp.json();
    } catch {
      throw new BadResponseError(`${this.provider}: unexpected response shape`);
    }
    const choice = (data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] } | null)?.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new BadResponseError(`${this.provider}: empty or malformed completion`);
    if (choice?.finish_reason === "length") throw new BadResponseError(`${this.provider}: output truncated`);
    const raw = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
      text,
      usage: { prompt_tokens: num(raw?.prompt_tokens), completion_tokens: num(raw?.completion_tokens), calls: 1 },
    };
  }
}
