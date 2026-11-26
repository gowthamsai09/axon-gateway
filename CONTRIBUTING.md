# Contributing to axon-gateway

`docs/axon-architecture.md` in the hub repo (https://github.com/gowthamsai09/Axon) is the single source of
truth. If code and spec disagree, open an issue or PR that changes the spec first; do not
deviate silently.

## Setup and checks

```bash
nvm use            # Node version is in .nvmrc (22)
npm ci --ignore-scripts
npm run lint && npm run typecheck && npm test
```
Schema contract tests read the hub's JSON Schemas from `../Axon/schemas` (override with
`HUB_SCHEMAS_DIR`; set `REQUIRE_HUB_SCHEMAS=1` to fail instead of skip when missing).

## Prompt sync

`prompts/summarizer_system.txt` must stay byte-identical to the template's copy (spec 4.4). After editing it in
the template, copy it here, run `npm run prompt:generate`, update the pinned id in `test/prompt.test.ts`, and check
with `npm run prompt:compare -- <path to the template file>`.

## Rules

- Keep files small and typed; add tests for every model or rule.
- No secrets anywhere. Untrusted input reaches code through `env:` only, never `${{ }}` inside `run:`.
- Pin third-party GitHub Actions to commit SHAs (see the hub's `docs/pinning-actions.md`).
- Open a PR against `main`; CI must be green.

## License of contributions

By submitting a pull request you agree that your contribution is
licensed under the Apache License 2.0 (see `LICENSE`), as in section 5 of that license.
