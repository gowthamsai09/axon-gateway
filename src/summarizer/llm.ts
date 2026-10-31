// Port of digest/summarizers/llm.py `_one` (single pass only; the Worker never map-reduces).
import {
  RETRY_REMINDER, documentFor, expectedSourceUrl, newNonce, systemMessage, userMessage,
} from "./prompting";
import { addUsage, type ChatClient, type Depth, type SourceItem, type Usage } from "./types";
import {
  SummaryValidationError, dropOverlongKeyPoints, parseJsonObject, validateSummary, type Summary,
} from "./validation";

export async function summarizeOne(
  client: ChatClient,
  item: SourceItem,
  depth: Depth,
  language: string,
  usage: Usage,
  notes: string[],
  nonce: () => string = newNonce,
  forbidden: readonly string[] = [],
): Promise<Summary> {
  const document = documentFor(item);
  const expectedUrl = expectedSourceUrl(item);
  let reminder = "";
  let last: SummaryValidationError | undefined;
  let lastRaw: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const n = nonce();
    const result = await client.complete(systemMessage(n), userMessage(item, depth, language, n, document, reminder));
    addUsage(usage, result.usage);
    try {
      // Defense in depth for the zero-custody rule: a secret the caller sent must never come back out.
      if (forbidden.some((f) => f.length > 0 && result.text.includes(f))) {
        throw new SummaryValidationError("output contains a secret");
      }
      lastRaw = parseJsonObject(result.text);
      return validateSummary(lastRaw, { depth, expectedUrl, sourceText: document });
    } catch (e) {
      if (!(e instanceof SummaryValidationError)) throw e;
      last = e;
      reminder = RETRY_REMINDER(`The previous output was rejected: ${e.message}.`);
    }
  }
  if (last === undefined) throw new Error("unreachable");
  if (last.repairable && lastRaw !== undefined) {
    try {
      const repaired = validateSummary(dropOverlongKeyPoints(lastRaw, depth), { depth, expectedUrl, sourceText: document });
      notes.push(`${item.id}: dropped key point(s) over the length limit (${last.message})`);
      return repaired;
    } catch (e) {
      if (!(e instanceof SummaryValidationError)) throw e;
      throw last;
    }
  }
  throw last;
}
