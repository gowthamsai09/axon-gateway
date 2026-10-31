// CPU check for Tier 1 (brief 4.2.6, Appendix B item 3: free Workers get 10 ms CPU per request).
// The real shards are not in the repo, so synthetic ones are built to the real sizes from real fixture items:
// latest.json about 128 KB (150 items), tags/agents-tooling.json about 96 KB. Run: npm run bench (prints timings)
// This measures Node, not workerd: use it for relative cost, and check real CPU time after deploy.
import { describe, it } from "vitest";
import { getUpdates } from "../src/core/updates";
import { GetUpdatesInput } from "../src/schemas";
import { deps, itemFile, makeFetch, idN } from "../test/helpers";

const shard = (n: number) => ({
  schema_version: 1,
  generated_at: "2026-10-20T03:47:55.762003Z",
  items: Array.from({ length: n }, (_, i) =>
    itemFile(idN(i + 1), {
      snippet: "x".repeat(280),
      tags: ["agents-tooling", "research-papers"],
      entities: ["Qwen"],
      base_score: (i % 100) / 100,
      published_at: `2026-10-${10 + (i % 10)}T10:00:00Z`,
      also_covered_by: [{ source_id: "hn-ai", url: "https://news.ycombinator.com/item?id=1" }],
    }),
  ),
});
const latest = shard(150);
const tag = shard(115);
const bytes = (v: unknown) => JSON.stringify(v).length;
const fx = makeFetch({ files: { "latest.json": latest, "tags/agents-tooling.json": tag } });
const run = (input: Record<string, unknown>) => getUpdates(deps(fx), { FEED_BASE: "https://feed.test/feed", PUBLIC_URL: "https://x.test", ALLOWED_PROVIDERS: "deepseek" }, GetUpdatesInput.parse(input));

async function time(label: string, input: Record<string, unknown>, rounds = 200): Promise<void> {
  for (let i = 0; i < 20; i++) await run(input); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    await run(input);
    samples.push(performance.now() - t);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number) => (samples[Math.min(samples.length - 1, Math.floor(samples.length * q))] ?? 0).toFixed(2);
  console.log(`${label.padEnd(58)} median ${at(0.5)} ms   p95 ${at(0.95)} ms   max ${at(1)} ms`);
}

describe(`getUpdates (latest.json ${Math.round(bytes(latest) / 1024)} KB, tag shard ${Math.round(bytes(tag) / 1024)} KB)`, () => {
  it("measures", async () => {
    await time("no filter: parse + validate + sort latest.json", {});
    await time("one topic: parse + validate + sort tags/agents-tooling.json", { topics: ["agents-tooling"] });
    await time("since + limit 50", { since: "2026-10-15T00:00:00Z", limit: 50 });
  }, 60_000);
});
