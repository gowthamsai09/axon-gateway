import type { Deps } from "./core/deps";
import type { InstallationCache } from "./github/app";
import type { Limiters } from "./ratelimit";

export type AdapterCtx = { deps: Deps; limiters: Limiters; ip: string; cache: InstallationCache };
