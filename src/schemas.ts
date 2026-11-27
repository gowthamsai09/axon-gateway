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
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ITEM_ID = /^[a-f0-9]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Z]{2})?$/;

// Spec 7.5, tightened (see Spec deltas): topics/entities become shard file names, so they are
// slugs, not free strings; `language` is interpolated into the summarizer task block.
export const GetUpdatesInput = z.object({
  topics: z.array(TopicSlug).max(10).default([]).describe("Topic slugs to filter by (see the Agent Card)."),
  entities: z
    .array(z.string().max(64).regex(SLUG))
    .max(10)
    .default([])
    .describe("Entity slugs, lowercase with hyphens (for example qwen, llama-cpp)."),
  since: z.iso.datetime({ offset: true }).optional().describe("Only items published at or after this ISO 8601 time."),
  limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of items (1 to 50)."),
});

export const SummarizeInput = z.object({
  item_ids: z.array(z.string().regex(ITEM_ID)).min(1).max(10).describe("Feed item ids from get_ai_updates (1 to 10)."),
  depth: z.enum(["headlines", "brief", "detailed"]).default("brief"),
  language: z.string().regex(LANGUAGE).default("en").describe("Language code such as en or pt-BR."),
});

// Protocol adapters accept only the documented parameters: unknown keys are errors, not ignored.
export const GetUpdatesParams = GetUpdatesInput.strict();
export const SummarizeParams = SummarizeInput.strict();

// Spec 7.5 plus decision D1 (Appendix C 46): optional model header. The value only ever goes into a
// JSON body field, never into a URL, and the charset is restricted anyway.
export const ModelHeader = z
  .string()
  .regex(/^[A-Za-z0-9._:/-]{1,100}$/)
  .refine((m) => !m.includes("..") && !m.includes("//") && !m.startsWith("/") && !m.endsWith("/"));
export const ApiKeyHeader = z.string().regex(/^[A-Za-z0-9._~+/=:-]{8,512}$/);

// Spec 9.3b, plus fallback_snippet (spec 6.3 step 7). Mirrors digest/task_result.py.
const TaskItemSummary = z.strictObject({
  one_line: z.string().max(200),
  key_points: z.array(z.string().max(240)).max(6),
  why_it_matters: z.string().max(300),
  tags: z.array(TopicSlug).max(4),
});

// The template writes the unused one of the two fields as JSON null (pydantic default), and the hub JSON
// Schema allows null for both. Drop those two nulls before validating so the result still means "exactly one".
const dropNullChoices = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const item: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const key of ["summary", "fallback_snippet"]) if (item[key] === null) delete item[key];
  return item;
};

const TaskItem = z.preprocess(
  dropNullChoices,
  z
    .strictObject({
      id: z.string().regex(ITEM_ID),
      title: z.string().min(1).max(500),
      url: z.string().min(8).max(2048),
      summary: TaskItemSummary.optional(),
      fallback_snippet: z.string().max(300).optional(),
    })
    .refine((i) => (i.summary === undefined) !== (i.fallback_snippet === undefined), {
      message: "provide exactly one of summary or fallback_snippet",
    }),
);

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
