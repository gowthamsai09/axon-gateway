// Spec 7.2, Appendix B item 4 (verified 2026-10-25): Workers Rate Limiting binding, `[[ratelimits]]`
// syntax, period 10 or 60 seconds, counters per Cloudflare location and approximate. When the binding
// is absent (local tests) or throws, an in-isolate fixed-window counter is used instead. That fallback
// is per isolate and resets on eviction: it is a safety net, not strict abuse prevention.
import type { RateLimitBinding } from "./env";
import { GatewayError } from "./errors";

const MAX_KEYS = 5000;

class WindowCounter {
  #hits = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly limit: number,
    private readonly periodMs: number,
    private readonly now: () => number,
  ) {}
  allow(key: string): boolean {
    const t = this.now();
    const entry = this.#hits.get(key);
    if (!entry || t - entry.start >= this.periodMs) {
      if (this.#hits.size >= MAX_KEYS) this.#hits.clear();
      this.#hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

export class Limiter {
  readonly #fallback: WindowCounter;
  constructor(
    limit: number,
    private readonly periodSeconds: number,
    now: () => number,
  ) {
    this.#fallback = new WindowCounter(limit, periodSeconds * 1000, now);
  }
  /** Uses the Cloudflare binding when present; falls back to the in-isolate counter. */
  async check(binding: RateLimitBinding | undefined, key: string): Promise<void> {
    let allowed: boolean;
    if (binding) {
      try {
        allowed = (await binding.limit({ key })).success;
      } catch {
        allowed = this.#fallback.allow(key);
      }
    } else {
      allowed = this.#fallback.allow(key);
    }
    if (!allowed) {
      throw new GatewayError("rate_limited", "Too many requests. Retry later.", this.periodSeconds);
    }
  }
}

export type Limiters = { pub: Limiter; summary: Limiter; tier3: Limiter };

/** Fallback limits mirror wrangler.toml: 60 per 60 s public, 10 per 60 s for Tier 2. */
export const createLimiters = (now: () => number): Limiters => ({
  pub: new Limiter(60, 60, now),
  summary: new Limiter(10, 60, now),
  tier3: new Limiter(30, 60, now),
});

export const clientKey = (req: Request): string => req.headers.get("cf-connecting-ip")?.slice(0, 64) || "unknown";
