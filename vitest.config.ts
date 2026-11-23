import { defineConfig } from "vitest/config";

// Plain Node runner (Appendix C 57: the workerd pool was not adopted; real-runtime checks use `wrangler dev`).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Several suites generate RSA keys; a loaded Windows laptop needs more than the 5 s default.
    testTimeout: 30_000,
  },
});
