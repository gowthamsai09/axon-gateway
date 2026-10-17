# axon-gateway

Plane 3 of [Axon](https://github.com/gowthamsai09/Axon): a Cloudflare Worker (TypeScript, Hono) that
will serve A2A and MCP. Spec: sections 4.3, 7, 8, 9.

**Phase 0 status:** only `GET /healthz` exists. Zod schemas for the section 7.5 inputs and the
Tier 3 task result are in `src/schemas.ts`. `wrangler.toml` holds placeholders; nothing is deployed.

```bash
npm ci --ignore-scripts && npm run lint && npm run typecheck && npm test
```
