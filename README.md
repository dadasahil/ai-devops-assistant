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

Open <http://127.0.0.1:8000>. The local dashboard has no sign-in. Enter:

1. The app owner configures a Gemini API key privately as `GEMINI_API_KEY` in the ignored `.env.local` file or the server environment. The dashboard does not ask users for an AI key. The key stays on the server and must never be added to `static/`, `.env.example`, or a committed file.
2. Paste a fine-grained GitHub token with access to the repository and **Actions: Read-only** permission. Choose the repository detected from the token.
3. Click **Connect GitHub**. The app checks the GitHub token and tests its built-in Gemini connection. The Gemini check may use a small amount of API quota.
4. Click **Refresh**. It checks GitHub for recent workflow failures, saves any it has not seen, and starts diagnosis. Open a failure card to read its summary, cause, and suggested fix.

For local use, the app owner’s Gemini key is stored in the ignored `.env.local` file or a private server environment variable; a user’s GitHub token is stored in `.env.local`. Analysis history is stored in the ignored `devops_assistant.db` SQLite file. None of these values belong in Git. Redacted failure-log excerpts are sent to Google Gemini for diagnosis. Secret redaction is best-effort. Disconnecting removes the GitHub token while keeping the app owner’s Gemini configuration.

If the provider reports no quota or credits, the GitHub failure can still be captured and shown, but a full AI diagnosis cannot run. Check that Google AI Studio has available Gemini API quota, then click **Retry diagnosis** on the saved failure.

### Optional instant notifications

Refresh works by polling GitHub, so a webhook is optional. To receive failures without clicking Refresh, GitHub needs to reach a public HTTPS URL for this app's `/webhooks/github` endpoint. Set the same `GITHUB_WEBHOOK_SECRET` in the app and in the repository's webhook settings, use `application/json`, and select **Workflow runs**. Do not expose the dashboard or its settings API through a public tunnel; the local app can restrict public access to the signed webhook and health check with `PUBLIC_WEBHOOK_ONLY=1`.

## Netlify hosting

The hosted version uses Netlify Functions, encrypted per-user GitHub credentials, and invite-only Netlify Identity to protect private workflow history and repository access. It requires Netlify Blobs, Identity, and these site environment variables:

- `CREDENTIAL_ENCRYPTION_KEY`: 32 random bytes encoded as Base64.
- `BACKGROUND_JOB_SECRET`: a separate long random secret for internal analysis jobs.
- `GITHUB_WEBHOOK_SECRET`: a separate secret for the optional GitHub webhook.
- Optional provider overrides: `LLM_BASE_URL` and `LLM_MODEL`.

For manual deployment, build with `npm run build`, publish `static`, and deploy the Netlify Functions in `netlify/functions`. Configure the required site services and secrets before expecting hosted analysis to work. The public hosted site must remain access-controlled; removing access control would expose saved repository logs and would let visitors use your provider quota.

## Checks and safeguards

- Webhook signatures are validated before an event is accepted. Duplicate run IDs are ignored.
- The dashboard's **Refresh** action polls the configured repository; it does not create or change a workflow run.
- Raw logs are held temporarily for analysis. Common GitHub and provider secrets are redacted before AI transmission; redaction cannot guarantee that every private value is removed.
- A completed AI diagnosis means the provider returned all three requested fields. Partial/error states explain when GitHub logs or AI access prevented a diagnosis.
- Treat recommendations as advisory. Confirm them against the linked GitHub run and verify changes before merging.
