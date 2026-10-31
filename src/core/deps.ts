import type { FetchFn } from "../budget";

/** Everything with a side effect is injected so the core is testable offline (guidelines 2.2). */
export type Deps = {
  fetch: FetchFn;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  rng: () => number;
  nonce?: () => string;
};

export const defaultDeps = (): Deps => ({
  // Wrapped: calling a detached `fetch` throws "Illegal invocation" in Workers.
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => new Date(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rng: () => Math.random(),
});
