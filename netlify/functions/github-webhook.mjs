import { createHmac, timingSafeEqual } from "node:crypto";
import { analysisKey, json, readJson, repoKey, store, updateAnalysis, writeJson } from "./lib.js";

function validSignature(body, signature, secret) {
  if (!secret || !signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export default async function handler(request) {
  if (request.method !== "POST") return json({ detail: "Method not allowed." }, 405);
  const secret = process.env.GITHUB_WEBHOOK_SECRET || "";
  const raw = Buffer.from(await request.arrayBuffer());
  if (!validSignature(raw, request.headers.get("x-hub-signature-256"), secret)) {
    return json({ detail: "Invalid webhook signature. Check the secret configured in GitHub and Netlify." }, 401);
  }
  if (request.headers.get("x-github-event") !== "workflow_run") return json({ accepted: true, ignored: "unsupported event" }, 202);

  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { return json({ detail: "Malformed GitHub event." }, 400); }
  const run = payload?.workflow_run;
  const repository = payload?.repository?.full_name;
  if (!run || !repository || !Number.isSafeInteger(Number(run.id))) return json({ detail: "Malformed workflow run event." }, 400);
  if (run.status !== "completed" || run.conclusion !== "failure") return json({ accepted: true, ignored: "run is not a completed failure" }, 202);

  const mapping = await readJson(repoKey(repository));
  if (!mapping?.userId) return json({ accepted: true, ignored: "repository is not connected" }, 202);
  const runId = String(run.id);
  const key = analysisKey(mapping.userId, runId);
  const existing = await readJson(key);
  if (existing) return json({ accepted: true, duplicate: true, run_id: runId }, 202);

  const record = {
    repository, repository_id: payload.repository.id ?? null, run_id: Number(runId),
    workflow: String(run.name || "Workflow").slice(0, 300), branch: run.head_branch || null,
    commit_sha: run.head_sha || null, run_url: run.html_url || null, status: "queued",
    conclusion: "failure", created_at: run.updated_at || new Date().toISOString(),
    summary: null, likely_causes: "[]", evidence: "[]", suggested_fix: null,
    verification_steps: "[]", uncertainty: null, error: null,
  };
  await writeJson(key, record);

  const jobSecret = process.env.BACKGROUND_JOB_SECRET || "";
  if (!jobSecret) {
    await updateAnalysis(mapping.userId, runId, { status: "error", error: "The site's background processing secret is not configured." });
    return json({ detail: "The analysis service is not fully configured." }, 503);
  }
  try {
    const backgroundUrl = new URL("/.netlify/functions/analyze-failure-background", request.url);
    const response = await fetch(backgroundUrl, {
      method: "POST", headers: { "content-type": "application/json", "x-background-job-secret": jobSecret },
      body: JSON.stringify({ userId: mapping.userId, runId }), signal: AbortSignal.timeout(12000),
    });
    if (response.status !== 202) {
      await updateAnalysis(mapping.userId, runId, { status: "error", error: "The background analysis service did not accept this run." });
      return json({ detail: "Could not start workflow analysis." }, 503);
    }
  } catch {
    await updateAnalysis(mapping.userId, runId, { status: "error", error: "The background analysis service could not be reached." });
    return json({ detail: "Could not start workflow analysis." }, 503);
  }
  return json({ accepted: true, run_id: runId }, 202);
}
