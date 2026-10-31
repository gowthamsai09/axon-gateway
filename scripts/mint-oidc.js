// Mints a local test OIDC token for the mock: node scripts/mint-oidc.js <register.yml|issue-token.yml|revoke-token.yml> [owner/repo]
import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

const [, , workflow, repo = "alice/axon-digest"] = process.argv;
if (!["register.yml", "issue-token.yml", "revoke-token.yml"].includes(workflow ?? "")) {
  console.error("usage: node scripts/mint-oidc.js register.yml|issue-token.yml|revoke-token.yml [owner/repo]");
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(".mock-github.json", "utf8"));
const port = process.env.MOCK_PORT ?? "8790";
const key = await importPKCS8(cfg.oidcPrivatePem, "RS256");
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({
  repository: repo,
  repository_id: "9001",
  repository_owner: repo.split("/")[0],
  event_name: "workflow_dispatch",
  job_workflow_ref: `${repo}/.github/workflows/${workflow}@refs/heads/main`,
})
  .setProtectedHeader({ alg: "RS256", kid: "local-1" })
  .setIssuer(`http://127.0.0.1:${port}`)
  .setAudience(process.env.PUBLIC_URL ?? "http://localhost:8787")
  .setIssuedAt(now)
  .setExpirationTime(now + 300)
  .sign(key);
process.stdout.write(token);
