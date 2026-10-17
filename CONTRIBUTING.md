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

## Rules

- Keep files small and typed; add tests for every model or rule.
- No secrets anywhere. Untrusted input reaches code through `env:` only, never `${{ }}` inside `run:`.
- Pin third-party GitHub Actions to commit SHAs (see the hub's `docs/pinning-actions.md`).
- Open a PR against `main`; CI must be green.
