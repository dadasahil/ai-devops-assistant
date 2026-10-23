# AI DevOps Assistant

> Created and owned by **Sahil** ([`dadasahil`](https://github.com/dadasahil)).
> Copyright © 2026 Sahil. All rights reserved.

This is proprietary software. You may not use, copy, modify, or redistribute
this project without written permission. See [LICENSE](LICENSE).

Pipeline Pulse watches one selected GitHub repository's GitHub Actions runs. Click **Refresh** to ask GitHub for its latest 50 runs; completed failures are saved and analyzed. A signed GitHub webhook can also send failures immediately. For each failure, the assistant fetches job details and redacted log excerpts, then presents a **Summary**, **How to fix**, and **Cause**. If the AI provider is unavailable, a real failure remains visible with a clearly labeled, cautious evidence fallback. Once provider access is restored, choose **Retry diagnosis** to analyze the same saved run; you do not need to create another failure.

The assistant recommends fixes. It does not edit repositories, merge pull requests, or deploy code. It currently monitors **GitHub Actions**. Jenkins is not connected in this version; Jenkins would need its own server URL, API token, build-log connector, and webhook/polling support.

## Run locally

Requires Python 3.10 or newer.

```powershell
cd C:\path\to\devops_assistant
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000>. The local dashboard has no sign-in. In **Connections**, choose an AI provider, enter its model and API key, then click **Connect AI**. Supported choices are:

- **Google Gemini**, using Google's OpenAI-compatible chat endpoint.
- **OpenAI**, using its official API endpoint.
- **Anthropic Claude**, using Anthropic's Messages API.
- **Other OpenAI-compatible provider**, where you provide its public HTTPS API base URL and a model it supports. This includes gateways and services that implement the OpenAI chat-completions format.

An API key only works with the provider and models that issued or accept it. A Claude or OpenAI key cannot call Gemini by itself; a compatible gateway must explicitly offer that Gemini model. Arbitrary API protocols are not interchangeable, so an unlisted service needs to support the OpenAI-compatible chat-completions format. The connection check sends a small real generation request and may use provider quota.

Then paste a fine-grained GitHub token with access to the repository and **Actions: Read-only** permission, choose a repository detected from that token, and click **Connect GitHub**. Click **Refresh** to check recent workflow failures and start diagnosis. Open a failure card to read its summary, cause, and suggested fix.

For local use, the selected AI key and GitHub token are stored in the ignored `.env.local` file on this computer; this local dashboard has no sign-in, so keep the server bound to localhost. The hosted Netlify dashboard also has no account or sign-in page. It creates a private browser session using a random, HttpOnly cookie, then encrypts that browser's GitHub and AI keys in Netlify Blobs. Saved workflow history belongs to that browser session. Clearing this site's browser data or switching browsers/devices loses access to that session's saved settings and history. Analysis history is stored in the ignored `devops_assistant.db` SQLite file locally. Redacted failure-log excerpts are sent to the selected AI provider for diagnosis; redaction is best-effort. **Disconnect AI** removes the selected key while keeping GitHub access and saved history.

If the provider reports no quota or credits, the GitHub failure can still be captured and shown, but a full AI diagnosis cannot run. Check quota with that provider, then click **Check AI** or **Retry diagnosis** on the saved failure.

### Optional instant notifications

Refresh works by polling GitHub, so a webhook is optional. To receive failures without clicking Refresh, GitHub needs to reach a public HTTPS URL for this app's `/webhooks/github` endpoint. Set the same `GITHUB_WEBHOOK_SECRET` in the app and in the repository's webhook settings, use `application/json`, and select **Workflow runs**. Do not expose the dashboard or its settings API through a public tunnel; the local app can restrict public access to the signed webhook and health check with `PUBLIC_WEBHOOK_ONLY=1`.

## Netlify hosting

The hosted version uses Netlify Functions and Netlify Blobs. It has no login or account system: each browser gets a random private session cookie, and its GitHub and AI credentials are encrypted before storage. Users enter their own provider keys. Each browser/device has a separate session; clearing browser data removes its session cookie and makes its saved settings and history inaccessible. Netlify Blobs and these site environment variables are required:

- `CREDENTIAL_ENCRYPTION_KEY`: 32 random bytes encoded as Base64.
- `BACKGROUND_JOB_SECRET`: a separate long random secret for internal analysis jobs.
- `GITHUB_WEBHOOK_SECRET`: a separate secret for the optional GitHub webhook.
- Optional default provider settings: `AI_PROVIDER`, `LLM_BASE_URL`, and `LLM_MODEL`.

For manual deployment, build with `npm run build`, publish `static`, and deploy the Netlify Functions in `netlify/functions`. Configure the required site services and secrets before expecting hosted analysis to work. This is a public service with no account login, so anyone can open it and submit their own provider and GitHub keys; protect secret environment variables, use HTTPS, and keep data isolated by the browser session. Repository webhook delivery is optional and requires `GITHUB_WEBHOOK_SECRET`.

## Checks and safeguards

- Webhook signatures are validated before an event is accepted. Duplicate run IDs are ignored.
- The dashboard's **Refresh** action polls the configured repository; it does not create or change a workflow run.
- Raw logs are held temporarily for analysis. Common GitHub and provider secrets are redacted before AI transmission; redaction cannot guarantee that every private value is removed.
- A completed AI diagnosis means the provider returned all three requested fields. Partial/error states explain when GitHub logs or AI access prevented a diagnosis.
- Treat recommendations as advisory. Confirm them against the linked GitHub run and verify changes before merging.
