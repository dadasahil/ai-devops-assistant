import { getStore } from "@netlify/blobs";
import { getUser } from "@netlify/identity";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const store = getStore("pipeline-pulse-data");

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export async function requireUser() {
  try {
    const user = await getUser();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

function encryptionKey() {
  const value = process.env.CREDENTIAL_ENCRYPTION_KEY || "";
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("The site's credential encryption setting is missing or invalid.");
  return key;
}

export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString("base64url")).join(".");
}

export function decrypt(value) {
  if (!value) return "";
  const [iv, tag, ciphertext] = value.split(".").map(part => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("Stored connection data could not be read.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export async function readJson(key) {
  const value = await store.get(key);
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export async function writeJson(key, value) {
  await store.set(key, JSON.stringify(value), { metadata: { contentType: "application/json" } });
}

export function repoKey(repository) {
  return `repositories/${repository.toLowerCase()}`;
}

export function userConfigKey(userId) {
  return `users/${userId}/connections`;
}

export function analysisKey(userId, runId) {
  return `analyses/${userId}/${runId}`;
}

export function isRepoName(value) {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value || "");
}

export async function getConfig(userId) {
  const stored = await readJson(userConfigKey(userId));
  if (!stored) return { githubToken: "", aiKey: "", repository: "", aiBaseUrl: process.env.LLM_BASE_URL || "https://api.openai.com/v1", aiModel: process.env.LLM_MODEL || "gpt-4o-mini", aiVerified: false, aiMessage: "No AI provider key is saved." };
  return {
    githubToken: decrypt(stored.githubToken || ""),
    aiKey: decrypt(stored.aiKey || ""),
    repository: stored.repository || "",
    aiBaseUrl: stored.aiBaseUrl || process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    aiModel: stored.aiModel || process.env.LLM_MODEL || "gpt-4o-mini",
    aiVerified: stored.aiVerified === true,
    aiMessage: stored.aiMessage || "AI key is saved but has not been verified. Click Connect both to test it.",
  };
}

export async function saveConfig(userId, config) {
  await writeJson(userConfigKey(userId), {
    githubToken: config.githubToken ? encrypt(config.githubToken) : "",
    aiKey: config.aiKey ? encrypt(config.aiKey) : "",
    repository: config.repository || "",
    aiBaseUrl: config.aiBaseUrl || process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    aiModel: config.aiModel || process.env.LLM_MODEL || "gpt-4o-mini",
    aiVerified: config.aiVerified === true,
    aiMessage: config.aiMessage || "",
    updatedAt: new Date().toISOString(),
  });
}

export async function listAnalyses(userId, limit = 100) {
  const { blobs = [] } = await store.list({ prefix: `analyses/${userId}/` });
  const rows = await Promise.all(blobs.map(async ({ key }) => readJson(key)));
  return rows.filter(Boolean).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, limit);
}

export async function updateAnalysis(userId, runId, updates) {
  const key = analysisKey(userId, runId);
  const row = await readJson(key);
  if (!row) return null;
  const updated = { ...row, ...updates };
  await writeJson(key, updated);
  return updated;
}

export function safeErrorMessage(error, fallback) {
  const status = Number(error?.status || error?.statusCode || 0);
  if (status === 401) return "The provider rejected this key. Check that it is correct and active.";
  if (status === 403) return "The provider denied access. Check the key's permissions and account access.";
  if (status === 404) return "The requested repository, model, or workflow run was not found.";
  if (status === 429) return "The provider has no available quota or is rate-limiting requests. Check billing or wait and retry.";
  if (status >= 500) return "The provider is temporarily unavailable. Try again later.";
  return fallback;
}

export function redact(text) {
  return String(text || "")
    .replace(/(authorization\s*:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/(\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*[^\s]+/gi, "[REDACTED_SECRET_VARIABLE]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

export async function verifyAIKey(apiKey, baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1", model = process.env.LLM_MODEL || "gpt-4o-mini") {
  if (!apiKey) return { connected: false, message: "No AI provider API key is saved." };
  let endpoint;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid URL");
    endpoint = parsed.toString().replace(/\/$/, "");
  } catch {
    return { connected: false, message: "Enter a valid HTTPS AI API URL." };
  }
  if (!model || model.length > 160 || /[\r\n]/.test(model)) return { connected: false, message: "Enter a valid model name." };
  try {
    // This one-token probe confirms that the account can actually generate a response.
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 2, messages: [{ role: "user", content: "Reply OK." }] }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      let detail = "";
      try { const data = await response.json(); detail = `${data?.error?.code || ""} ${data?.error?.message || ""}`.toLowerCase(); } catch {}
      const status = response.status;
      const message = status === 401 ? "The AI provider rejected this key. Check that it is valid and active."
        : status === 403 ? "The AI provider denied this key. Check its permissions and account access."
          : status === 404 ? "The AI endpoint or model was not found. Check the API URL and model name."
            : status === 429 && /quota|billing|credit|insufficient/.test(detail) ? "The key was accepted, but the AI provider has no available quota or credits. Add credits or use a provider key with available quota."
              : status === 429 ? "The AI provider is rate-limiting requests. Wait a moment and try again."
                : status >= 500 ? "The AI provider is temporarily unavailable. Try again later."
                  : `The AI provider could not verify this connection (HTTP ${status}).`;
      return { connected: false, message };
    }
    const payload = await response.json();
    if (!payload?.choices?.length) return { connected: false, message: "The AI provider did not return a model response. Check the model name." };
    return { connected: true, message: `Connected to ${new URL(endpoint).hostname} (${model}); test response succeeded.` };
  } catch {
    return { connected: false, message: "Could not reach the AI provider. Check your internet connection and API URL." };
  }
}

function githubHeaders(token) {
  return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${token}` };
}

export async function listGithubRepositories(token) {
  try {
    const response = await fetch("https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator,organization_member", {
      headers: githubHeaders(token), signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) return { repositories: [], error: "GitHub rejected this token. Check that it is valid and not expired." };
    if (response.status === 403) return { repositories: [], error: "GitHub could not list repositories. The token needs Metadata: Read permission (included by default for fine-grained tokens)." };
    if (!response.ok) return { repositories: [], error: `GitHub could not detect repositories (HTTP ${response.status}).` };
    const data = await response.json();
    return { repositories: Array.isArray(data) ? data.map(item => item.full_name).filter(Boolean) : [], error: null };
  } catch {
    return { repositories: [], error: "Could not reach GitHub to detect this token's repositories." };
  }
}

export async function verifyGithubToken(token, repository) {
  if (!token) return { connected: false, message: "No GitHub token is saved." };
  if (!isRepoName(repository)) return { connected: false, message: "Choose a repository from the detected list." };
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/actions/runs?per_page=1`, {
      headers: githubHeaders(token), signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) return { connected: false, message: "GitHub rejected this token. Check that it is valid and not expired." };
    if (response.status === 403 || response.status === 404) return { connected: false, message: `GitHub denied Actions access to ${repository}. Check repository selection and Actions: Read-only permission.` };
    if (!response.ok) return { connected: false, message: `GitHub could not verify Actions access (HTTP ${response.status}).` };
    return { connected: true, message: `Connected to ${repository}; GitHub Actions can be monitored.` };
  } catch {
    return { connected: false, message: "Could not reach GitHub. Check your internet connection and try again." };
  }
}
