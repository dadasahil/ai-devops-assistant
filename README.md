# AI DevOps Assistant

A local starter app that receives GitHub Actions `workflow_run` failure webhooks, verifies their HMAC signature, deduplicates runs, fetches failed job metadata and logs, redacts common secrets, and stores a structured diagnosis for a small dashboard. Fixes are recommendations only; this app does not edit code or open pull requests.

## Run locally

Requires Python 3.10+.

```powershell
cd devops_assistant
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Set `GITHUB_WEBHOOK_SECRET` in `.env`. The dashboard has one **Connect both** button for the OpenAI key and GitHub Actions token. Leave a field empty to reuse a key already saved on this computer. Keys are verified before saving and are kept in `.env.local`, which is excluded from Git.

Create an API key at <https://platform.openai.com/api-keys> and a fine-grained GitHub token with **Actions: Read-only** for the repository you want to monitor. Enter the matching token under **GitHub Actions log access**; the dashboard detects its repository access automatically. If the token covers multiple repositories, select the one to monitor from the detected list. Redacted workflow log excerpts are sent to OpenAI when a failure is analyzed.

```powershell
uvicorn main:app --reload
```

Open <http://127.0.0.1:8000>. The dashboard shows real failed workflow runs received from GitHub. Health is at `/health`, API docs at `/docs`.

## Connect GitHub

1. Create a fine-grained token that selects your repository and grants **Actions: Read-only**. Enter the token in the dashboard and choose **Connect both**. Repository access is discovered through GitHub's API; if several repositories are available, choose one from the detected list.
2. In that repository, add a webhook with URL `https://YOUR_PUBLIC_HOST/webhooks/github`, content type `application/json`, the same random secret as `GITHUB_WEBHOOK_SECRET`, and the **Workflow runs** event.
3. Make the backend reachable over HTTPS. For local development, use an authenticated development tunnel; do not expose an unauthenticated laptop server.
4. The assistant uses the saved token to fetch logs for failed runs received from GitHub. It never sends the token back to the browser.
5. Trigger a harmless failed workflow in a test repository. The endpoint accepts only signed `workflow_run` events with a completed failure conclusion and deduplicates by run ID.

Example `.env` values:

```dotenv
GITHUB_WEBHOOK_SECRET=your-long-random-webhook-secret
GITHUB_TOKEN=github_app_installation_token_or_limited_test_token
LLM_API_KEY=your_provider_api_key
```

## Important limits

- A GitHub webhook event includes workflow metadata, not the log archive. The backend uses the GitHub REST API to retrieve logs.
- This starter is a local single-user prototype. Do not deploy it publicly as-is: the dashboard has no login, the storage is local SQLite, and its settings endpoints are restricted to localhost. Public deployment needs authentication and persistent storage.
- Secret redaction is best-effort. Review data handling and provider terms before sending private logs to an LLM.
- SQLite is for local learning. Add a managed database, a durable background queue, rate limits, retention controls, and observability before production use.
- No automatic patch, branch, pull request, merge, or deployment is performed.

## Security notes

Webhook signature verification runs before payload parsing. Analyses are idempotent by workflow run ID. Logs are not persisted; only bounded redacted evidence is saved. The dashboard is intended for localhost and has no login in this starter, so do not expose it publicly until authentication and persistent storage are added.
