# Deploying the gateway (Cloudflare Workers)

The `deploy` workflow publishes the Worker after `ci` succeeds on `main`. It needs the
`production` environment on GitHub, two secrets and a real `wrangler.toml`.

## One-time setup (done by the maintainer, never by an assistant)
1. Cloudflare account (Free plan, no card). The account has a `workers.dev` subdomain.
2. A KV namespace for the `TOKENS` binding. Its id goes into `wrangler.toml`. Namespace ids
   are public and bound to the account.
3. An account API token from the "Edit Cloudflare Workers" template, limited to the one
   account. Stored as the environment secret `CLOUDFLARE_API_TOKEN`. The account id is stored
   as `CLOUDFLARE_ACCOUNT_ID`. Neither is ever written to a file or pasted into chat.
4. GitHub: Settings > Environments > `production`, with a required reviewer (yourself) and
   deployment branches limited to `main`. Do not tick "Prevent self-review" if you are the
   only reviewer.

## What the workflow checks before it deploys
`scripts/check-deploy-config.js` refuses placeholders in `PUBLIC_URL` and `FEED_BASE`, a KV id
that is not 32 lowercase hex characters, local-development overrides, and enabled observability.
Tier 3 may stay off: a placeholder `GITHUB_APP_ID` is allowed.

## Deploy
Push to `main`. After `ci` is green, `deploy` waits for your approval ("Review deployments"),
then runs `npx wrangler deploy`. The log prints the Worker address.
Rollback: `npx wrangler rollback` from a machine that is logged in, or redeploy an older commit.

## Token notes
- The template token is broader than the deploy needs (KV, other products). After the first
  successful deploy, try a narrower token and record what it needed.
- The maintainer chose no expiry on 2026-11-27. Rotate by creating a new token, replacing the
  environment secret and deleting the old token in the Cloudflare dashboard.
- If a token is ever pasted into chat, a log or a file: delete it in Cloudflare first, then replace it.

## Pause deploys
Actions > `deploy` > the "..." menu > Disable workflow. Enable it again before the next release.
