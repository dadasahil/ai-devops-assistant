import { getStore } from "@netlify/blobs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const store = getStore("pipeline-pulse-data");

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const SESSION_COOKIE = "devops_session";

function sessionToken(request) {
  const cookie = request.headers.get("cookie") || "";
  const pair = cookie.split(";").map(item => item.trim()).find(item => item.startsWith(`${SESSION_COOKIE}=`));
  const token = pair?.slice(SESSION_COOKIE.length + 1) || "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32) return "";
  return token;
}

export function sessionIdFromRequest(request) {
  const token = sessionToken(request);
  return token ? createHash("sha256").update(token).digest("hex") : "";
}

export function issueSession(request) {
  const existing = sessionToken(request);
  const token = existing || randomBytes(32).toString("base64url");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id: createHash("sha256").update(token).digest("hex"),
    cookie: existing ? "" : `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`,
  };
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

export function sessionConfigKey(sessionId) {
  return `sessions/${sessionId}/connections`;
}

export function analysisKey(sessionId, runId) {
  return `analyses/${sessionId}/${runId}`;
}

export function isRepoName(value) {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(value || "");
}

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

function inferAIProvider(baseUrl = "") {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "generativelanguage.googleapis.com") return "gemini";
    if (host === "api.openai.com") return "openai";
    if (host === "api.anthropic.com") return "anthropic";
  } catch {}
  return "openai_compatible";
}

function defaultAIBaseUrl(provider) {
  return { gemini: GEMINI_BASE_URL, openai: OPENAI_BASE_URL, anthropic: ANTHROPIC_BASE_URL }[provider] || "";
}

function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2) || (b === 88 && c === 99) || (b === 168 && c === 0) || (b === 168 && c === 2)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return !(value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd")
      || /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:"));
  }
  return false;
}

async function validateAIBaseUrl(baseUrl, provider) {
  const direct = defaultAIBaseUrl(provider);
  const endpoint = String(baseUrl || direct).trim().replace(/\/$/, "");
  if (!endpoint || endpoint.length > 500) throw new Error("The AI API URL is invalid.");
  if (provider !== "openai_compatible" && endpoint !== direct) throw new Error("This provider uses its official API endpoint.");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Enter a valid HTTPS AI API URL.");
  if (provider === "openai_compatible") {
    const host = parsed.hostname.toLowerCase();
    if (!host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
      throw new Error("Custom provider URLs must use a public HTTPS host.");
    }
    let addresses;
    if (isIP(host)) addresses = [{ address: host }];
    else addresses = await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error("Custom provider URLs must resolve to a public server address.");
  }
  return endpoint;
}

export function buildAIRequest(apiKey, provider, baseUrl, model, messages, maxTokens) {
  if (provider === "anthropic") {
    const system = messages.filter(item => item.role === "system").map(item => item.content).join("\n\n");
    const body = { model, max_tokens: maxTokens, messages: messages.filter(item => item.role !== "system") };
    if (system) body.system = system;
    return { url: `${baseUrl}/messages`, headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, body };
  }
  return { url: `${baseUrl}/chat/completions`, headers: { authorization: `Bearer ${apiKey}` },
    body: { model, max_tokens: maxTokens, messages } };
}

export function aiResponseText(payload, provider) {
  if (provider === "anthropic") return (payload?.content || []).filter(item => item?.type === "text").map(item => item.text || "").join("").trim();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.filter(item => typeof item?.text === "string").map(item => item.text).join("").trim();
  return "";
}

export function aiConnectionStatus(connected, message = "") {
  if (connected) return "connected";
  const lower = String(message).toLowerCase();
  if (/no available quota|quota or credits|insufficient.*quota|quota.*exhausted/.test(lower)) return "quota_exhausted";
  if (/rate-limit|rate limit|too many requests/.test(lower)) return "rate_limited";
  if (/temporarily unavailable|timed out|did not respond|could not reach/.test(lower)) return "provider_unavailable";
  return "disconnected";
}

export function shouldKeepAISettings(result) {
  return result?.connected === true || ["rate_limited", "quota_exhausted", "provider_unavailable"].includes(aiConnectionStatus(false, result?.message));
}

export async function getConfig(sessionId) {
  const stored = await readJson(sessionConfigKey(sessionId));
  const defaultProvider = process.env.AI_PROVIDER || (process.env.LLM_BASE_URL ? inferAIProvider(process.env.LLM_BASE_URL) : "gemini");
  if (!stored) return { githubToken: "", aiKey: "", repository: "", aiProvider: defaultProvider,
    aiBaseUrl: process.env.LLM_BASE_URL || defaultAIBaseUrl(defaultProvider),
    aiModel: process.env.LLM_MODEL || (defaultProvider === "gemini" ? DEFAULT_GEMINI_MODEL : ""), aiVerified: false, aiMessage: "No AI provider key is saved." };
  return {
    githubToken: decrypt(stored.githubToken || ""),
    aiKey: decrypt(stored.aiKey || ""),
    repository: stored.repository || "",
    aiProvider: stored.aiProvider || inferAIProvider(stored.aiBaseUrl || process.env.LLM_BASE_URL || ""),
    aiBaseUrl: stored.aiBaseUrl || process.env.LLM_BASE_URL || defaultAIBaseUrl(stored.aiProvider || "gemini"),
    aiModel: stored.aiModel || process.env.LLM_MODEL || ((stored.aiProvider || inferAIProvider(stored.aiBaseUrl || "")) === "gemini" ? DEFAULT_GEMINI_MODEL : ""),
    aiVerified: stored.aiVerified === true,
    aiMessage: stored.aiMessage || "AI key is saved but has not been verified. Click Check AI to test it.",
  };
}

export async function saveConfig(sessionId, config) {
  await writeJson(sessionConfigKey(sessionId), {
    githubToken: config.githubToken ? encrypt(config.githubToken) : "",
    aiKey: config.aiKey ? encrypt(config.aiKey) : "",
    repository: config.repository || "",
    aiProvider: config.aiProvider || "gemini",
    aiBaseUrl: config.aiBaseUrl || defaultAIBaseUrl(config.aiProvider || "gemini"),
    aiModel: config.aiModel || (config.aiProvider === "gemini" ? DEFAULT_GEMINI_MODEL : ""),
    aiVerified: config.aiVerified === true,
    aiMessage: config.aiMessage || "",
    updatedAt: new Date().toISOString(),
  });
}

export async function listAnalyses(sessionId, limit = 100) {
  const { blobs = [] } = await store.list({ prefix: `analyses/${sessionId}/` });
  const rows = await Promise.all(blobs.map(async ({ key }) => readJson(key)));
  return rows.filter(Boolean).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, limit);
}

export async function updateAnalysis(sessionId, runId, updates) {
  const key = analysisKey(sessionId, runId);
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

export async function verifyAIKey(apiKey, provider = "gemini", baseUrl = "", model = DEFAULT_GEMINI_MODEL) {
  if (!apiKey) return { connected: false, message: "No AI provider API key is saved." };
  let endpoint;
  try {
    if (!["gemini", "openai", "anthropic", "openai_compatible"].includes(provider)) throw new Error("Choose a supported AI provider.");
    endpoint = await validateAIBaseUrl(baseUrl, provider);
  } catch {
    return { connected: false, message: provider === "openai_compatible" ? "Enter a public HTTPS URL for an OpenAI-compatible chat-completions API." : "The selected AI provider settings are invalid." };
  }
  if (!model || model.length > 160 || /[\r\n]/.test(model)) return { connected: false, message: "Enter a valid model name." };
  try {
    // A tiny generation probe checks usable quota, not only key formatting.
    const request = buildAIRequest(apiKey, provider, endpoint, model, [{ role: "user", content: "Reply exactly OK." }], provider === "anthropic" ? 24 : 128);
    const response = await fetch(request.url, {
      method: "POST", redirect: "error", headers: { ...request.headers, "content-type": "application/json" },
      body: JSON.stringify(request.body), signal: AbortSignal.timeout(20000),
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
    if (!aiResponseText(payload, provider)) return { connected: false, message: "The AI provider did not return a model response. Check the model name." };
    return { connected: true, message: `Connected to ${provider === "openai_compatible" ? new URL(endpoint).hostname : provider} (${model}); test response succeeded.` };
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
