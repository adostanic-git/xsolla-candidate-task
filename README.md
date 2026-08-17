# AI Diff Review Service

A small HTTP service that accepts a unified diff, reviews it asynchronously
through a pluggable provider (`mock` or `llm`), and returns structured
findings. Built for the Xsolla AI-First Engineering Intern take-home task —
see `CANDIDATE-TASK.md` for the full contract and `SUBMISSION.md` for
architecture notes and verification.

## Run locally

```bash
npm install
AUTH_TOKEN=my-secret PORT=3000 npm start
```

Then:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/spec

curl -X POST http://localhost:3000/v1/reviews \
  -H "Authorization: Bearer my-secret" \
  -H "Content-Type: application/json" \
  -d '{"diff": "diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +1,1 @@\n+eval(x);\n"}'
```

## Environment variables

| Variable            | Required | Purpose                                                       |
|----------------------|----------|----------------------------------------------------------------|
| `AUTH_TOKEN`          | yes      | Bearer token required on all `/v1/*` routes                    |
| `PORT`                | no       | HTTP port (default `3000`)                                     |
| `LLM_API_KEY`         | no       | Enables the `llm` provider. If unset, `llm` jobs fail gracefully with a `failed` status and a clear error. |
| `LLM_BASE_URL`        | no       | OpenAI-compatible chat-completions endpoint, currently Groq (default `https://api.groq.com/openai/v1/chat/completions`) |
| `LLM_MODEL`           | no       | Model id (default `openai/gpt-oss-120b`)                       |
| `LLM_TIMEOUT_MS`      | no       | Timeout for the LLM call (default `20000`)                     |

## Tests

```bash
npm test
```

Spawns the server as a child process and drives it over real HTTP, covering
auth, validation/error codes, mock rule findings + ordering, empty-catch
detection, caching, idempotency, chunking, concurrency, SSE + replay, and
rate limiting. See `SUBMISSION.md` for how this maps to the graded
cross-cutting behaviors.

## Deployment

Any option works per the task brief. This instance is exposed via
`<see submission email>`; no database or external service is required beyond
an optional `LLM_API_KEY` for the `llm` provider (OpenAI-compatible endpoint,
currently Groq).
