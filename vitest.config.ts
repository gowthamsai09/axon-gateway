import { defineConfig } from "vitest/config";

// Phase 0: plain Node runner. A workerd-based pool can be evaluated in Phase 3.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
