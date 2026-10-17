import { z } from "zod";

// Keep in sync with axon-feed (models/common.py) and axon-template (digest/profile.py).
// Hub CI checks enum parity across the exported JSON Schemas.
export const TOPIC_SLUGS = [
  "llm-releases",
  "open-source-llms",
  "small-local-models",
  "multimodal",
  "agents-tooling",
  "rag",
  "fine-tuning-training",
  "research-papers",
  "mlops-infra",
  "ai-hardware",
  "evals-benchmarks",
  "safety-alignment",
  "ai-policy-regulation",
  "ai-products-apps",
  "datasets",
  "robotics",
] as const;

export const TopicSlug = z.enum(TOPIC_SLUGS);
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ITEM_ID = /^[a-f0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

// Spec 7.5, tightened (see Spec deltas): topics/entities become shard file names, so they are
// slugs, not free strings; `language` is interpolated into the summarizer task block.
export const GetUpdatesInput = z.object({
  topics: z.array(TopicSlug).max(10).default([]),
  entities: z.array(z.string().max(64).regex(SLUG)).max(10).default([]),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

export const SummarizeInput = z.object({
  item_ids: z.array(z.string().regex(ITEM_ID)).min(1).max(10),
  depth: z.enum(["headlines", "brief", "detailed"]).default("brief"),
  language: z.string().regex(LANGUAGE).default("en"),
});

// Spec 9.3b, plus fallback_snippet (spec 6.3 step 7). Mirrors digest/task_result.py.
const TaskItemSummary = z.strictObject({
  one_line: z.string().max(200),
  key_points: z.array(z.string().max(240)).max(6),
  why_it_matters: z.string().max(300),
  tags: z.array(TopicSlug).max(4),
});

const TaskItem = z
  .strictObject({
    id: z.string().regex(ITEM_ID),
    title: z.string().min(1).max(500),
    url: z.string().min(8).max(2048),
    summary: TaskItemSummary.optional(),
    fallback_snippet: z.string().max(300).optional(),
  })
  .refine((i) => (i.summary === undefined) !== (i.fallback_snippet === undefined), {
    message: "provide exactly one of summary or fallback_snippet",
  });

export const TaskResult = z.strictObject({
  task_id: z.string().regex(UUID),
  status: z.enum(["completed", "failed"]),
  finished_at: z.iso.datetime({ offset: true }),
  items: z.array(TaskItem).max(25),
  model: z.strictObject({
    provider: z.enum(["deepseek", "huggingface", "openai_compatible"]),
    model: z.string().min(1).max(100),
  }),
  warnings: z.array(z.string().max(500)).max(100),
});

export type GetUpdatesInputT = z.infer<typeof GetUpdatesInput>;
export type SummarizeInputT = z.infer<typeof SummarizeInput>;
export type TaskResultT = z.infer<typeof TaskResult>;
