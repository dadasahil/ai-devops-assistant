# AI DevOps Assistant

Pipeline Pulse monitors failed GitHub Actions runs. GitHub sends a signed notice when a workflow fails; the assistant fetches that run's job details and logs, redacts common secrets, asks OpenAI for a concise summary, likely cause, and suggested fix, then saves the result in the signed-in user's private history. It only recommends fixes: it does not edit code, open pull requests, or deploy changes.

## Deploy on Netlify

The Netlify version uses Netlify Identity for sign-in, Netlify Blobs for durable account-scoped data, and Netlify Functions for the API, signed webhook, and background log analysis. User API credentials are encrypted with AES-256-GCM before they are written to storage. They are never sent to the browser after saving. Redacted failure-log excerpts are sent to OpenAI for diagnosis.

1. Import the private `dadasahil/ai-devops-assistant` GitHub repository into a **new Netlify site**. Do not reuse the unrelated `aigalaxy2` site. Leave the publish directory as `static` and build command as `npm run build` (these are already in `netlify.toml`).
2. Enable Netlify Identity on that site and use **invite-only** registration. Invite the site's owner account, then confirm the invitation email and sign in. Do not enable public sign-up for a personal dashboard.
3. In Netlify's site environment variables, set these secret values:
   - `CREDENTIAL_ENCRYPTION_KEY`: 32 random bytes encoded as Base64.
   - `BACKGROUND_JOB_SECRET`: a separate long random secret used only to protect the private background worker.
   - `GITHUB_WEBHOOK_SECRET`: a separate long random secret used to verify GitHub's signature.
   - Optional: `LLM_MODEL` (defaults to `gpt-4o-mini`).
4. Deploy the site. Sign in, paste the OpenAI API key and a fine-grained GitHub token with **Actions: Read-only** access, select the intended repository, and choose **Connect both**. Do not paste either key into chat or GitHub source files.
5. In that repository's GitHub settings, add or update a webhook to `https://YOUR-SITE.netlify.app/webhooks/github`, with content type `application/json`, the exact `GITHUB_WEBHOOK_SECRET` value, and only the **Workflow runs** event. GitHub must be able to reach this public HTTPS URL.
6. Run a workflow in the repository. Failed runs appear in the dashboard with a summary, cause, and suggested fix. The dashboard refreshes the account's saved history; it does not create a GitHub workflow run.

The encryption key must be retained unchanged. If it is lost or rotated, saved provider keys cannot be decrypted; users can reconnect them. The GitHub webhook secret must match the value stored in Netlify. Netlify Identity and environment variables must be configured in the site's dashboard; their values must never be committed to Git.

## Run the original local Python version

Requires Python 3.10+.

```powershell
cd devops_assistant
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
uvicorn main:app --reload
```

Open <http://127.0.0.1:8000>. The local version stores its keys in `.env.local` and data in a local SQLite file. It is for local learning and is not the backend used by the Netlify deployment.

## Security and behavior

- A valid GitHub HMAC signature is checked before a webhook event is parsed or accepted.
- Only completed failed workflow runs are recorded. Run IDs are deduplicated.
- Raw workflow logs are held in memory only long enough to analyze; common secrets are redacted before the excerpt is sent to OpenAI. Redaction is best-effort, so review private logs and provider policies before connecting a repository.
- Each signed-in account sees only its own saved credentials and analysis history. Secrets are encrypted with a site-level key before storage.
- GitHub and OpenAI credentials require the user's own valid API access. OpenAI API usage may be billed by OpenAI; a valid key alone does not guarantee that the account has API credits.
- Recommendations are advisory. Check the actual workflow evidence and verify changes yourself.
