// Port of digest/summarizers/prompting.py (template). Same hygiene: nonce, delimiter stripping
// until stable, control and invisible Unicode removal, truncation, task block layout.
import { SUMMARIZER_SYSTEM_PROMPT } from "../prompts/summarizer.generated";
import { TOPIC_SLUGS } from "../schemas";
import type { Depth, SourceItem } from "./types";

export const MAX_DOC_CHARS = 6000; // the feed excerpt is at most 2,200 characters: single pass only
export const RETRY_REMINDER = (why: string): string =>
  `Reminder: return valid JSON only, exactly matching the schema. ${why}`;

const DELIMITER = /<\s*\/?\s*(?:untrusted_document|task)\b[^>]*>?/gi;
const BLANKS = /\n{3,}/g;
const SPACES = /\s+/g;
const HIDDEN = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;

/** Python's `text[:n]` counts code points; so does this. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

export const stripHidden = (text: string): string => text.replace(HIDDEN, (ch) => (ch === "\n" || ch === "\t" ? ch : ""));

export function sanitizeText(text: string, maxChars: number = MAX_DOC_CHARS): string {
  let t = stripHidden(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  let previous: string | null = null;
  while (previous !== t) {
    previous = t;
    t = t.replace(DELIMITER, "");
  }
  return truncate(t.replace(BLANKS, "\n\n").trim(), maxChars);
}

export function sanitizeMeta(value: string, maxChars = 300): string {
  const cleaned = stripHidden(value).replace(SPACES, " ").trim();
  return truncate(cleaned.replace(/</g, "").replace(/>/g, "").replace(/"/g, ""), maxChars);
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const systemMessage = (nonce: string): string => SUMMARIZER_SYSTEM_PROMPT.replaceAll("{{NONCE}}", nonce);

/** Python json.dumps(list) uses ", " separators; keep the prompt text identical. */
export const allowedTagsJson = (): string => "[" + TOPIC_SLUGS.map((s) => JSON.stringify(s)).join(", ") + "]";

export const expectedSourceUrl = (item: SourceItem): string => sanitizeMeta(item.url, 2048);
export const documentFor = (item: SourceItem): string => sanitizeText(`${item.title}\n\n${item.text}`);

export function userMessage(
  item: SourceItem,
  depth: Depth,
  language: string,
  nonce: string,
  document: string,
  reminder = "",
): string {
  if (!/^[a-z]{2,3}(-[A-Z]{2})?$/.test(language)) throw new Error("invalid language"); // defense in depth
  const parts = [
    "<task>",
    `depth: ${depth}`,
    `language: ${language}`,
    `allowed_tags: ${allowedTagsJson()}`,
    `source_url: ${expectedSourceUrl(item)}`,
    `source_name: ${sanitizeMeta(item.sourceName, 64)}`,
    `published_at: ${sanitizeMeta(item.publishedAt, 40)}`,
    "</task>",
    "",
    `<untrusted_document nonce="${nonce}">`,
    document,
    `</untrusted_document nonce="${nonce}">`,
  ];
  if (reminder) parts.push("", reminder);
  return parts.join("\n");
}

export async function promptVersionOf(template: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(template));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return "p-" + hex.slice(0, 10);
}

let cached: Promise<string> | undefined;
/** `p-` + first 10 hex of sha256(prompt text): identical to the template's prompt_version(). */
export const promptVersion = (): Promise<string> => (cached ??= promptVersionOf(SUMMARIZER_SYSTEM_PROMPT));
