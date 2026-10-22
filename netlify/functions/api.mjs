import { verifyRequestOrigin } from "@netlify/identity";
import {
  getConfig, isRepoName, json, listAnalyses, listGithubRepositories, readJson,
  repoKey, requireUser, saveConfig, store, verifyAIKey, verifyGithubToken, writeJson,
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

  if (request.method === "GET" && path === "/settings/connections") {
    try {
      const config = await getConfig(user.id);
      const ai = await verifyAIKey(config.aiKey);
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
      return json({ ai, github, repository, repositories });
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
      if (aiKey.length > 500 || /[\r\n]/.test(aiKey)) return json({ detail: "The OpenAI key format is invalid." }, 400);
      if (githubToken.length > 500 || /[\r\n]/.test(githubToken)) return json({ detail: "The GitHub token format is invalid." }, 400);

      const ai = await verifyAIKey(aiKey);
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

      const newConfig = {
        aiKey: ai.connected ? aiKey : old.aiKey,
        githubToken: github.connected ? githubToken : old.githubToken,
        repository: github.connected ? repository : old.repository,
      };
      if (ai.connected || github.connected) await saveConfig(user.id, newConfig);

      if (github.connected) {
        if (old.repository && old.repository.toLowerCase() !== repository.toLowerCase()) {
          const oldMapping = await readJson(repoKey(old.repository));
          if (oldMapping?.userId === user.id) await store.delete(repoKey(old.repository));
        }
        await writeJson(repoKey(repository), { userId: user.id, repository, updatedAt: new Date().toISOString() });
      }

      return json({ ai, github, repository: github.connected ? repository : "", repositories });
    } catch (error) {
      return json({ detail: error.message || "Could not save the connection settings." }, 500);
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

  return json({ detail: "Not Found" }, 404);
}
