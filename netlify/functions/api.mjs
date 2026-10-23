import { verifyRequestOrigin } from "@netlify/identity";
import {
  analysisKey, aiConnectionStatus, getConfig, isRepoName, json, listAnalyses, listGithubRepositories, readJson,
  repoKey, requireUser, saveConfig, store, updateAnalysis, verifyAIKey, verifyGithubToken, writeJson,
  shouldKeepAISettings,
} from "./lib.js";

function apiPath(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith("/api/")) return path.slice(4);
  const prefix = "/.netlify/functions/api";
  return path.startsWith(prefix) ? (path.slice(prefix.length) || "/") : "/";
}

export default async function handler(request) {
  const user = await requireUser();
  if (!user) return json({ detail: "Please sign in to use your private dashboard." }, 401);
  const path = apiPath(request);

  if (request.method === "GET" && path === "/analyses") {
    return json(await listAnalyses(user.id));
  }

  if (request.method === "POST" && path === "/refresh") {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    const config = await getConfig(user.id);
    if (!config.githubToken || !config.repository) return json({ detail: "Connect GitHub Actions access and choose a repository before refreshing." }, 400);
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${config.repository}/actions/runs?per_page=50`, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${config.githubToken}` },
        signal: AbortSignal.timeout(25000),
      });
    } catch {
      return json({ detail: "Could not reach GitHub to refresh this repository's workflow runs." }, 502);
    }
    if (response.status === 401) return json({ detail: "GitHub rejected the saved token. Reconnect it and try again." }, 400);
    if ([403, 404].includes(response.status)) return json({ detail: `GitHub denied Actions access to ${config.repository}. Check repository selection and Actions: Read-only permission.` }, 400);
    if (!response.ok) return json({ detail: `GitHub could not refresh workflow runs (HTTP ${response.status}).` }, 502);
    let runs;
    try { runs = (await response.json()).workflow_runs || []; } catch { return json({ detail: "GitHub returned an unreadable workflow list." }, 502); }
    const failures = runs.filter(run => run.status === "completed" && run.conclusion === "failure");
    let queued = 0;
    let newRecords = 0;
    for (const run of failures) {
      if (newRecords >= 10) break;
      const runId = String(run.id || "");
      if (!/^\d+$/.test(runId)) continue;
      const key = analysisKey(user.id, runId);
      if (await readJson(key)) continue;
      const record = {
        repository: config.repository, repository_id: null, run_id: Number(runId),
        workflow: String(run.name || "Workflow").slice(0, 300), branch: run.head_branch || null,
        commit_sha: run.head_sha || null, run_url: run.html_url || null, status: "queued",
        conclusion: "failure", created_at: run.updated_at || new Date().toISOString(),
        summary: null, likely_causes: "[]", evidence: "[]", suggested_fix: null,
        verification_steps: "[]", uncertainty: null, error: null,
      };
      await writeJson(key, record);
      newRecords += 1;
      const jobSecret = process.env.BACKGROUND_JOB_SECRET || "";
      if (!jobSecret) {
        await updateAnalysis(user.id, runId, { status: "error", summary: "The failure was found, but analysis is not configured.",
          likely_causes: JSON.stringify(["The site's background processing secret is missing."]),
          suggested_fix: "Add BACKGROUND_JOB_SECRET to the site's environment settings, redeploy, then retry this saved diagnosis.",
          error: "The site's background processing secret is not configured." });
        continue;
      }
      try {
        const workerUrl = new URL("/.netlify/functions/analyze-failure-background", request.url);
        const worker = await fetch(workerUrl, {
          method: "POST", headers: { "content-type": "application/json", "x-background-job-secret": jobSecret },
          body: JSON.stringify({ userId: user.id, runId }), signal: AbortSignal.timeout(12000),
        });
        if (worker.status !== 202) throw new Error("The background analyzer did not accept the run.");
        queued += 1;
      } catch {
        await updateAnalysis(user.id, runId, { status: "error", summary: "The failure was found, but analysis could not start.",
          likely_causes: JSON.stringify(["The background analysis service could not be reached."]),
          suggested_fix: "Check the site's BACKGROUND_JOB_SECRET setting and retry this saved diagnosis.",
          error: "The background analysis service could not be reached." });
      }
    }
    return json({ repository: config.repository, failures_found: failures.length, new_analyses_queued: queued });
  }

  if (request.method === "GET" && path === "/settings/connections") {
    try {
      const config = await getConfig(user.id);
      const ai = config.aiKey
        ? { configured: true, connected: config.aiVerified, status: aiConnectionStatus(config.aiVerified, config.aiMessage), provider: config.aiProvider, model: config.aiModel,
            message: config.aiMessage || "AI key is saved but has not been verified. Click Check AI to test it." }
        : { configured: false, connected: false, provider: config.aiProvider, model: config.aiModel, status: "not_configured", message: "No AI provider key is saved." };
      const discovery = config.githubToken ? await listGithubRepositories(config.githubToken) : { repositories: [], error: null };
      const repositories = discovery.repositories;
      let repository = config.repository;
      if (!config.githubToken) {
        repository = "";
      } else if (discovery.error) {
        repository = "";
      } else if (repositories.length === 1) {
        repository = repositories[0];
      } else if (!repositories.includes(repository)) {
        repository = "";
      }
      const github = discovery.error
        ? { connected: false, message: discovery.error }
        : repository
          ? await verifyGithubToken(config.githubToken, repository)
          : { connected: false, message: config.githubToken ? "Choose a repository available to this token." : "No GitHub token is saved." };
      return json({ ai, ai_provider: config.aiProvider, ai_base_url: config.aiBaseUrl, ai_model: config.aiModel, github, repository, repositories });
    } catch (error) {
      return json({ detail: error.message || "Could not read connection settings." }, 500);
    }
  }

  if (request.method === "POST" && path === "/settings/connections") {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    let body;
    try { body = await request.json(); } catch { return json({ detail: "Enter the keys and repository in their matching fields." }, 400); }
    try {
      const old = await getConfig(user.id);
      const aiKey = String(body.ai_key || "").trim() || old.aiKey;
      const githubToken = String(body.github_token || "").trim() || old.githubToken;
      const aiProvider = String(body.ai_provider || old.aiProvider).trim().toLowerCase();
      const aiBaseUrl = aiProvider === "openai_compatible"
        ? String(body.ai_base_url ?? (old.aiProvider === aiProvider ? old.aiBaseUrl : "")).trim()
        : aiProvider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai"
          : aiProvider === "openai" ? "https://api.openai.com/v1"
            : aiProvider === "anthropic" ? "https://api.anthropic.com/v1" : "";
      const aiModel = String(body.ai_model ?? (aiProvider === old.aiProvider ? old.aiModel : "")).trim();
      if (aiKey.length > 500 || /[\r\n]/.test(aiKey)) return json({ detail: "The AI provider key format is invalid." }, 400);
      if (githubToken.length > 500 || /[\r\n]/.test(githubToken)) return json({ detail: "The GitHub token format is invalid." }, 400);

      const ai = await verifyAIKey(aiKey, aiProvider, aiBaseUrl, aiModel);
      const discovery = githubToken ? await listGithubRepositories(githubToken) : { repositories: [], error: null };
      const repositories = discovery.repositories;
      let repository = String(body.repository || "").trim();
      if (!repository && repositories.length === 1) repository = repositories[0];
      if (!repository && repositories.includes(old.repository)) repository = old.repository;
      let github;
      if (!githubToken) github = { connected: false, message: "No GitHub token was entered or saved." };
      else if (discovery.error) github = { connected: false, message: discovery.error };
      else if (!repository) github = { connected: false, message: repositories.length ? "Choose the repository you want to monitor." : "This token did not return repositories. Check its repository selection and Metadata: Read access." };
      else if (!isRepoName(repository) || !repositories.some(item => item.toLowerCase() === repository.toLowerCase())) {
        github = { connected: false, message: "Choose a repository shown in the detected list." };
      } else github = await verifyGithubToken(githubToken, repository);

      const keepAI = shouldKeepAISettings(ai);
      const newConfig = {
        aiKey: keepAI ? aiKey : old.aiKey,
        githubToken: github.connected ? githubToken : old.githubToken,
        repository: github.connected ? repository : old.repository,
        aiProvider: keepAI ? aiProvider : old.aiProvider,
        aiBaseUrl: keepAI ? aiBaseUrl : old.aiBaseUrl,
        aiModel: keepAI ? aiModel : old.aiModel,
        aiVerified: ai.connected ? true : (keepAI ? false : old.aiVerified),
        aiMessage: keepAI ? ai.message : old.aiMessage,
      };
      if (keepAI || github.connected || (aiKey === old.aiKey && aiProvider === old.aiProvider && aiBaseUrl === old.aiBaseUrl && aiModel === old.aiModel)) await saveConfig(user.id, newConfig);

      if (github.connected) {
        if (old.repository && old.repository.toLowerCase() !== repository.toLowerCase()) {
          const oldMapping = await readJson(repoKey(old.repository));
          if (oldMapping?.userId === user.id) await store.delete(repoKey(old.repository));
        }
        await writeJson(repoKey(repository), { userId: user.id, repository, updatedAt: new Date().toISOString() });
      }

      const responseAI = { ...ai, configured: Boolean(newConfig.aiKey), status: aiConnectionStatus(ai.connected, ai.message), saved: keepAI };
      return json({ ai: responseAI, ai_attempt: Object.prototype.hasOwnProperty.call(body, "ai_key") || Object.prototype.hasOwnProperty.call(body, "ai_provider") ? responseAI : undefined,
        ai_provider: newConfig.aiProvider, ai_base_url: newConfig.aiBaseUrl, ai_model: newConfig.aiModel,
        github, repository: github.connected ? repository : "", repositories });
    } catch (error) {
      return json({ detail: error.message || "Could not save the connection settings." }, 500);
    }
  }

  if (request.method === "POST" && path === "/settings/ai/check") {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    try {
      const config = await getConfig(user.id);
      if (!config.aiKey) return json({ configured: false, connected: false, status: "not_configured", message: "No AI provider key is saved." });
      const result = await verifyAIKey(config.aiKey, config.aiProvider, config.aiBaseUrl, config.aiModel);
      const updated = { ...config, aiVerified: result.connected, aiMessage: result.message };
      await saveConfig(user.id, updated);
      return json({ ...result, configured: true, provider: config.aiProvider, model: config.aiModel,
        status: aiConnectionStatus(result.connected, result.message), saved: shouldKeepAISettings(result) });
    } catch (error) {
      return json({ detail: error.message || "Could not check the AI provider." }, 500);
    }
  }

  if (request.method === "DELETE" && path === "/settings/ai") {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    try {
      const config = await getConfig(user.id);
      await saveConfig(user.id, { ...config, aiKey: "", aiVerified: false, aiMessage: "No AI provider key is saved." });
      return json({ disconnected: true, ai: { configured: false, connected: false, status: "not_configured", message: "No AI provider key is saved." } });
    } catch (error) {
      return json({ detail: error.message || "Could not disconnect the AI provider key." }, 500);
    }
  }

  if (request.method === "DELETE" && path === "/settings/connections") {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    try {
      const config = await getConfig(user.id);
      if (config.repository) {
        const mapping = await readJson(repoKey(config.repository));
        if (mapping?.userId === user.id) await store.delete(repoKey(config.repository));
      }
      await store.delete(`users/${user.id}/connections`);
      return json({ disconnected: true, history_kept: true });
    } catch (error) {
      return json({ detail: error.message || "Could not disconnect the saved keys." }, 500);
    }
  }

  const retryMatch = request.method === "POST" && path.match(/^\/analyses\/(\d+)\/retry$/);
  if (retryMatch) {
    try { verifyRequestOrigin(request); } catch { return json({ detail: "This request did not come from this website. Reload and try again." }, 403); }
    const runId = retryMatch[1];
    const record = await readJson(analysisKey(user.id, runId));
    if (!record) return json({ detail: "This saved workflow run was not found." }, 404);
    const config = await getConfig(user.id);
    if (!config.githubToken || !config.aiKey) return json({ detail: "Connect GitHub Actions and an AI provider before retrying." }, 400);
    if (config.repository.toLowerCase() !== String(record.repository || "").toLowerCase()) {
      return json({ detail: `This run belongs to ${record.repository}. Reconnect that repository before retrying.` }, 400);
    }
    if (["queued", "running"].includes(record.status)) return json({ accepted: true, run_id: runId, status: record.status }, 202);
    const jobSecret = process.env.BACKGROUND_JOB_SECRET || "";
    if (!jobSecret) return json({ detail: "The site's background processing secret is not configured." }, 503);
    await writeJson(analysisKey(user.id, runId), { ...record, status: "queued", error: null });
    try {
      const workerUrl = new URL("/.netlify/functions/analyze-failure-background", request.url);
      const response = await fetch(workerUrl, {
        method: "POST", headers: { "content-type": "application/json", "x-background-job-secret": jobSecret },
        body: JSON.stringify({ userId: user.id, runId }), signal: AbortSignal.timeout(12000),
      });
      if (response.status !== 202) throw new Error("The background analyzer did not accept the retry.");
    } catch {
      await updateAnalysis(user.id, runId, { status: "error", error: "Could not start the background analysis. Try again." });
      return json({ detail: "Could not start the analysis retry." }, 503);
    }
    return json({ accepted: true, run_id: runId, status: "queued" }, 202);
  }

  return json({ detail: "Not Found" }, 404);
}
