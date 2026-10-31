// Tolerant reader of the published feed (spec 5.4, guidelines 2.1): unknown fields ignored, invalid
// items skipped and counted. The feed-item schema is never copied; contract is feed-item.schema.json.
import { z } from "zod";
import { isBudgetError, type FetchFn } from "../budget";
import { GatewayError } from "../errors";
import { ITEM_ID, SLUG, TOPIC_SLUGS } from "../schemas";
import { truncate } from "../summarizer/prompting";

export const MAX_SHARD_BYTES = 5_000_000;
export const EDGE_CACHE_SECONDS = 300;
const TOPICS = new Set<string>(TOPIC_SLUGS);
const REL = /^(?:meta\.json|latest\.json|(?:tags|entities)\/[a-z0-9]+(?:-[a-z0-9]+)*\.json|items\/[a-f0-9]{16}\.json)$/;

const FeedItemView = z.object({
  id: z.string().regex(ITEM_ID),
  canonical_url: z.string().min(8).max(2048).regex(/^https?:\/\//i),
  title: z.string().min(1).max(500),
  source_id: z.string().min(1).max(64),
  published_at: z.iso.datetime({ offset: true }),
  snippet: z.string().default(""),
  excerpt: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  base_score: z.number().min(0).max(1).default(0),
});
export type FeedItem = z.infer<typeof FeedItemView>;

export type PublicItem = {
  id: string;
  title: string;
  url: string;
  source: string;
  tags: string[];
  entities: string[];
  published_at: string;
  snippet: string;
  score: number;
};

export const toPublic = (i: FeedItem): PublicItem => ({
  id: i.id,
  title: i.title,
  url: i.canonical_url,
  source: i.source_id,
  tags: i.tags.filter((t) => TOPICS.has(t)),
  entities: i.entities,
  published_at: i.published_at,
  snippet: truncate(i.snippet, 300),
  score: i.base_score,
});

/** Same slug rule as the template (digest/feed_client.py entity_slug). */
export const entitySlug = (name: string): string | null => {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return SLUG.test(slug) ? slug : null;
};

export type Read = { status: "ok"; data: unknown } | { status: "missing" };

export class FeedReader {
  constructor(
    private readonly base: string,
    private readonly fetchFn: FetchFn,
  ) {}

  /** `rel` is built only from validated slugs and ids; re-checked here as defense in depth. */
  async read(rel: string): Promise<Read> {
    if (!REL.test(rel)) throw new GatewayError("internal_error", "The gateway built an invalid feed path.");
    let resp: Response;
    try {
      resp = await this.fetchFn(`${this.base}/${rel}`, {
        method: "GET",
        headers: { accept: "application/json" },
        // Edge cache for public feed data only: no subrequest beyond the fetch itself (Appendix C 48).
        cf: { cacheTtl: EDGE_CACHE_SECONDS, cacheEverything: true },
      });
    } catch (e) {
      if (isBudgetError(e)) throw e;
      throw new GatewayError("upstream_unavailable", "The feed could not be reached.");
    }
    if (resp.status === 404 || resp.status === 410) return { status: "missing" };
    if (resp.status !== 200) throw new GatewayError("upstream_unavailable", "The feed returned an error.");
    const declared = Number(resp.headers.get("content-length") ?? "0");
    if (declared > MAX_SHARD_BYTES) throw new GatewayError("upstream_unavailable", "The feed file is too large.");
    try {
      const text = await resp.text();
      if (text.length > MAX_SHARD_BYTES) throw new Error("too large");
      return { status: "ok", data: JSON.parse(text) as unknown };
    } catch {
      throw new GatewayError("upstream_unavailable", "The feed returned unreadable data.");
    }
  }
}

export function parseItems(data: unknown): { items: FeedItem[]; skipped: number } {
  const entries = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(entries)) return { items: [], skipped: 0 };
  const items: FeedItem[] = [];
  let skipped = 0;
  for (const e of entries) {
    const r = FeedItemView.safeParse(e);
    if (r.success) items.push(r.data);
    else skipped += 1;
  }
  return { items, skipped };
}

export function parseItemFile(data: unknown): FeedItem | null {
  const r = FeedItemView.safeParse(data);
  return r.success ? r.data : null;
}

export function generatedAt(data: unknown): string | null {
  const v = (data as { generated_at?: unknown } | null)?.generated_at;
  return typeof v === "string" && z.iso.datetime({ offset: true }).safeParse(v).success ? v : null;
}
