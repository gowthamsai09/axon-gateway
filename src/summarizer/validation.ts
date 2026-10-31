// Port of digest/summarizers/validation.py: nothing trusts the model. JSON shape, caps, depth rules,
// URL allow-list, figures grounded in the source. Messages carry field names and numbers only.
import { z } from "zod";
import { TopicSlug } from "../schemas";
import type { Depth } from "./types";

const URL_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)[^\s"'<>]+/g;
const MARKUP = /```|<\/?[A-Za-z][^>]*>|\]\(|^\s{0,3}#{1,6}\s|\*\*/m;
const TRAIL = new Set(".,;:)]}'\"".split(""));
const DEPTH_LIMITS: Record<Depth, [number, number]> = { headlines: [0, 0], brief: [3, 160], detailed: [6, 240] };
const FIELD_LIMITS: Record<string, number> = { title: 300, one_line: 200, why_it_matters: 300 };

export class SummaryValidationError extends Error {
  readonly repairable: boolean;
  constructor(message: string, repairable = false) {
    super(message);
    this.name = "SummaryValidationError";
    this.repairable = repairable;
  }
}

const Str = (max: number) => z.string().max(max);
export const SummarySchema = z.strictObject({
  status: z.enum(["ok", "insufficient_content", "suspected_injection"]),
  title: Str(300),
  one_line: Str(200),
  key_points: z.array(Str(240)).max(6),
  why_it_matters: Str(300),
  tags: z.array(TopicSlug).max(4),
  entities: z.array(Str(100)).max(8),
  notable_figures: z.array(z.strictObject({ value: Str(200), context: Str(200) })).max(10),
  source_url: Str(2048),
  injection_flag: z.boolean(),
});
export type Summary = z.infer<typeof SummarySchema>;

const cpLen = (s: string): number => Array.from(s).length;
const rstripTrail = (s: string): string => {
  let end = s.length;
  while (end > 0 && TRAIL.has(s.charAt(end - 1))) end -= 1;
  return s.slice(0, end);
};

export function parseJsonObject(text: string): Record<string, unknown> {
  let body = text.trim();
  if (body.startsWith("```")) body = body.replace(/^```[A-Za-z]*\s*|\s*```$/g, "").trim();
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) throw new SummaryValidationError("output is not JSON");
    try {
      data = JSON.parse(body.slice(start, end + 1));
    } catch {
      throw new SummaryValidationError("output is not valid JSON");
    }
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new SummaryValidationError("output is not a JSON object");
  }
  return data as Record<string, unknown>;
}

function lengthChecks(raw: Record<string, unknown>, depth: Depth): void {
  for (const [name, limit] of Object.entries(FIELD_LIMITS)) {
    const v = raw[name];
    if (typeof v === "string" && cpLen(v) > limit) {
      throw new SummaryValidationError(`${name} is too long (limit ${limit} characters)`);
    }
  }
  const points = raw["key_points"];
  if (!Array.isArray(points)) return;
  const [maxPoints, maxLen] = DEPTH_LIMITS[depth];
  if (points.length > maxPoints) {
    throw new SummaryValidationError(
      `too many key_points for depth ${depth} (limit ${maxPoints}, got ${points.length})`,
      true,
    );
  }
  const longest = Math.max(0, ...points.filter((p): p is string => typeof p === "string").map(cpLen));
  if (longest > maxLen) {
    throw new SummaryValidationError(
      `a key point is too long for depth ${depth} (limit ${maxLen} characters, longest is ${longest})`,
      true,
    );
  }
}

/** Last resort after the retry (Appendix C 43): delete over-long and surplus key points; never edit. */
export function dropOverlongKeyPoints(raw: Record<string, unknown>, depth: Depth): Record<string, unknown> {
  const points = raw["key_points"];
  if (!Array.isArray(points)) return raw;
  const [maxPoints, maxLen] = DEPTH_LIMITS[depth];
  const kept = points.filter((p): p is string => typeof p === "string" && cpLen(p) <= maxLen).slice(0, maxPoints);
  return { ...raw, key_points: kept };
}

export function validateSummary(
  raw: Record<string, unknown>,
  opts: { depth: Depth; expectedUrl: string; sourceText: string },
): Summary {
  lengthChecks(raw, opts.depth);
  const parsed = SummarySchema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "<root>"))].sort();
    throw new SummaryValidationError("schema violation in: " + fields.slice(0, 5).join(", "));
  }
  const s = parsed.data;
  if (s.source_url !== opts.expectedUrl) throw new SummaryValidationError("source_url differs from the task block");
  if (s.status !== "ok") {
    if (s.title || s.one_line || s.why_it_matters || s.key_points.length || s.tags.length || s.notable_figures.length) {
      throw new SummaryValidationError("content fields must be empty when status is not ok");
    }
    return s;
  }
  if (!s.one_line.trim()) throw new SummaryValidationError("one_line is empty");
  const strings = [s.title, s.one_line, s.why_it_matters, ...s.key_points, ...s.entities];
  for (const f of s.notable_figures) strings.push(f.value, f.context);
  for (const text of strings) {
    if (MARKUP.test(text)) throw new SummaryValidationError("markup in a plain-text field");
    for (const match of text.match(URL_RE) ?? []) {
      if (rstripTrail(match) !== rstripTrail(opts.expectedUrl)) {
        throw new SummaryValidationError("output contains a URL other than source_url");
      }
    }
  }
  for (const f of s.notable_figures) {
    if (!opts.sourceText.includes(f.value)) throw new SummaryValidationError("a notable figure does not appear in the source");
  }
  return s;
}
