// Refuses to deploy placeholder or unsafe configuration (Appendix C 81).
//   node scripts/check-deploy-config.js [path/to/wrangler.toml]     exit 0 ok, 1 problems, 2 unreadable
// Tier 3 may stay off (GITHUB_APP_ID placeholder is fine); the rest must be real.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FORBIDDEN_VARS = ["ENVIRONMENT", "GITHUB_API_BASE", "GITHUB_OIDC_ISSUER", "GITHUB_JWKS_URL"];

export function checkConfig(toml) {
  const text = toml.replace(/#.*$/gm, "");
  const problems = [];
  const value = (name) => new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m").exec(text)?.[1];
  for (const name of ["PUBLIC_URL", "FEED_BASE"]) {
    const v = value(name);
    if (v === undefined) problems.push(`${name} is missing`);
    else if (/[<>]/.test(v)) problems.push(`${name} is still a placeholder`);
    else if (!/^https:\/\/[^/@\s?#]+(\/[^\s?#]*)?$/.test(v)) problems.push(`${name} must be an https URL without credentials, query or fragment`);
  }
  const kv = /\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*"([^"]*)"/.exec(text)?.[1];
  if (kv === undefined) problems.push("the TOKENS KV namespace id is missing");
  else if (!/^[0-9a-f]{32}$/.test(kv)) problems.push("the TOKENS KV namespace id is not a real id (32 lowercase hex characters)");
  for (const name of FORBIDDEN_VARS) {
    if (new RegExp(`^\\s*${name}\\s*=`, "m").test(text)) problems.push(`${name} is a local-development override and must not be deployed`);
  }
  if (/\[observability\][^[]*\benabled\s*=\s*true/.test(text)) problems.push("observability must stay disabled (Tier 2 headers carry caller keys)");
  return problems;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let toml;
  try {
    toml = readFileSync(process.argv[2] ?? "wrangler.toml", "utf8");
  } catch {
    console.error("cannot read wrangler.toml");
    process.exit(2);
  }
  const problems = checkConfig(toml);
  for (const p of problems) console.error(`deploy blocked: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log("deploy configuration looks real");
}
