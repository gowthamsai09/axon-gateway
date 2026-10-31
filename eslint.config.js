import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", ".wrangler/", "hub/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.js"], languageOptions: { globals: { process: "readonly", console: "readonly", fetch: "readonly", setTimeout: "readonly" } } },
  // The Worker must never log: headers and caller keys flow through it (spec 7.2, guidelines 2.2).
  { files: ["src/**/*.ts"], rules: { "no-console": "error" } },
);
