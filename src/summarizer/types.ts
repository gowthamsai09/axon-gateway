export type Depth = "headlines" | "brief" | "detailed";

export type Usage = { prompt_tokens: number; completion_tokens: number; calls: number };
export const newUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, calls: 0 });
export function addUsage(into: Usage, other: Usage): void {
  into.prompt_tokens += other.prompt_tokens;
  into.completion_tokens += other.completion_tokens;
  into.calls += other.calls;
}

export type ChatResult = { text: string; usage: Usage };
export interface ChatClient {
  readonly provider: string;
  readonly model: string;
  complete(system: string, user: string): Promise<ChatResult>;
}

/** The provider answered but the answer is unusable (truncated, empty, wrong shape, HTTP 4xx). */
export class BadResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadResponseError";
  }
}

export type SourceItem = {
  id: string;
  title: string;
  url: string;
  sourceName: string;
  publishedAt: string;
  text: string;
};
