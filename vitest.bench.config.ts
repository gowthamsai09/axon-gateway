import { defineConfig } from "vitest/config";

// `npm run bench`: timing runs, kept out of `npm test`.
export default defineConfig({ test: { include: ["bench/**/*.bench.ts"] } });
