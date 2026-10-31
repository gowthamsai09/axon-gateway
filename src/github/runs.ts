// Repository-scoped GitHub operations for Tier 3 (spec 9.3). Every path is built from a validated
// repository name, a fixed workflow file name or a UUID; nothing comes from the caller.
import { z } from "zod";
import { GatewayError } from "../errors";
import { UUID_V7 } from "../util";
import { assertRepo, failFor, ghRequest, parseJson, type Gh } from "./http";

export const WORKFLOW_FILE = "digest.yml";
export const runTitle = (taskId: string): string => `digest task ${taskId}`;

export async function dispatchDigest(gh: Gh, token: string, repo: string, ref: string, taskId: string, params: string): Promise<void> {
  assertRepo(repo);
  if (!UUID_V7.test(taskId)) throw new GatewayError("internal_error", "Invalid task id.");
  const r = await ghRequest(gh, { method: "POST", path: `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, token, body: { ref, inputs: { task_id: taskId, params } } });
  if (r.status !== 204 && r.status !== 200) {
    if (r.status === 422) throw new GatewayError("upstream_unavailable", "The digest workflow could not be started. Check that digest.yml exists on the default branch.");
    throw failFor(r.status);
  }
}

const Run = z.object({
  id: z.number().int().positive(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  display_title: z.string(),
  event: z.string(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type RunInfo = z.infer<typeof Run>;

/** Finds the run whose display title is `digest task <id>` (the template's run-name). */
export async function findRun(gh: Gh, token: string, repo: string, taskId: string, createdAfterMs: number): Promise<RunInfo | null> {
  assertRepo(repo);
  const day = new Date(createdAfterMs - 86_400_000).toISOString().slice(0, 10);
  const r = await ghRequest(gh, { method: "GET", path: `/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=50&created=%3E%3D${day}`, token });
  if (r.status !== 200) throw failFor(r.status);
  const runs = (parseJson(r.text) as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(runs)) throw failFor(502);
  for (const raw of runs) {
    const p = Run.safeParse(raw);
    if (p.success && p.data.event === "workflow_dispatch" && p.data.display_title === runTitle(taskId)) return p.data;
  }
  return null;
}

/** Raw file from the repository at `ref`; null when it does not exist. */
export async function readRepoFile(gh: Gh, token: string, repo: string, path: string, ref: string, maxBytes: number): Promise<string | null> {
  assertRepo(repo);
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(path) || path.includes("..")) throw new GatewayError("internal_error", "Invalid path.");
  const r = await ghRequest(gh, { method: "GET", path: `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, token, accept: "application/vnd.github.raw+json", maxBytes });
  if (r.status === 404) return null;
  if (r.status !== 200) throw failFor(r.status);
  return r.text;
}

/** true when GitHub accepted the cancellation; false when the run can no longer be cancelled. */
export async function cancelRun(gh: Gh, token: string, repo: string, runId: number): Promise<boolean> {
  assertRepo(repo);
  const r = await ghRequest(gh, { method: "POST", path: `/repos/${repo}/actions/runs/${runId}/cancel`, token });
  if (r.status === 202) return true;
  if (r.status === 409) return false;
  throw failFor(r.status);
}
