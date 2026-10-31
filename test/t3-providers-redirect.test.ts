// Phase 4 replacement for the Phase 3 assertion `redirect === "error"`: workerd rejects that value
// (Appendix C 74), so the client sends "manual" and must itself refuse to follow a 3xx.
import { describe, expect, it } from "vitest";
import { ProviderClient } from "../src/providers";
import { BadResponseError } from "../src/summarizer/types";
import { KEY } from "./helpers";

const make = (handler: (url: string, init?: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const client = new ProviderClient({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    key: KEY,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
    sleep: async () => undefined,
    rng: () => 0.5,
  });
  return { client, calls };
};

describe("provider redirects", () => {
  it('sends redirect: "manual" (the only non-following value workerd accepts)', async () => {
    const { client, calls } = make(() => new Response(JSON.stringify({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), { status: 200 }));
    await client.complete("s", "u");
    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  it.each([301, 302, 303, 307, 308])("a %s is a bad response and the key is never sent to the Location", async (status) => {
    const { client, calls } = make(() => new Response("", { status, headers: { location: "https://evil.example/steal" } }));
    await expect(client.complete("s", "u")).rejects.toBeInstanceOf(BadResponseError);
    expect(calls).toHaveLength(1); // no second request, nowhere else
    expect(calls.every((c) => c.url === "https://api.deepseek.com/chat/completions")).toBe(true);
  });
});
