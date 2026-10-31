// Free-plan Workers allow 50 subrequests per request (Appendix B item 3, verified 2026-10-25).
// Every outbound fetch goes through one budget so the limit is never hit by surprise.
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export class BudgetExhaustedError extends Error {
  constructor() {
    super("subrequest budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export const DEFAULT_SUBREQUEST_BUDGET = 45; // 50 minus a safety margin

export class SubrequestBudget {
  #left: number;
  constructor(total: number = DEFAULT_SUBREQUEST_BUDGET) {
    this.#left = total;
  }
  get remaining(): number {
    return this.#left;
  }
  take(): void {
    if (this.#left <= 0) throw new BudgetExhaustedError();
    this.#left -= 1;
  }
}

export function budgeted(base: FetchFn, budget: SubrequestBudget): FetchFn {
  return async (input, init) => {
    budget.take();
    return await base(input, init);
  };
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Name-based so it also works across module instances and in tests. */
export const isBudgetError = (e: unknown): boolean => e instanceof Error && e.name === "BudgetExhaustedError";
