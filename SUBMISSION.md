# SUBMISSION.md

## Architecture (~10 lines)

Node.js + Express, single process, in-memory state (`src/store.js`). Flow:
`POST /v1/reviews` validates the body, parses the unified diff
(`src/diff.js`) into per-file segments with new-file line numbers for added
lines, computes a job record, responds `202`, then hands the job to a
concurrency-limited queue (`src/queue.js`, limit 4). A worker
(`src/jobRunner.js`) splits the parsed files into ≤64 KiB chunks on file
boundaries, runs the selected provider per chunk (`src/providers/`), merges
findings, dedupes by `id`, sorts by `path → line → ruleId`, truncates to
`maxFindings`, and finalizes the job. Every state transition and finding is
also appended to a per-job in-memory event log (`src/sse.js`) that both live
SSE subscribers and later "replay" connections read from. A token-bucket
(`src/rateLimiter.js`) guards `POST /v1/reviews` only.

## Provider design

Both providers implement the same signature: `(files) -> findings[]`, where
`files` is the chunk's parsed file list (`{ path, addedLines }`). This keeps
chunking, ordering, dedup, caching, and SSE entirely provider-agnostic.

- **mock** (`src/providers/mockProvider.js`): pure functions, no I/O. Eight
  rules are simple per-line predicates; `MOCK-004` (empty catch) is the one
  stateful rule — it requires the opening brace on the same added line as
  `catch(`, then walks forward through *contiguous* added lines (no gap in
  new-file line numbers) tracking brace depth until the block closes. If the
  block can't be fully bounded within added lines (i.e. it depends on
  unchanged context we can't see), it's conservatively skipped rather than
  guessed at.
- **llm** (`src/providers/llmProvider.js`): calls the Anthropic Messages API
  with `tool_choice` forced to a `report_findings` tool so the model must
  return structured JSON matching the finding shape. The diff is framed
  explicitly as *data to review*, not instructions to follow (see injection
  note below). A 20s `AbortController` timeout and a `try/catch` around the
  fetch mean a missing key, network failure, non-2xx response, or malformed
  tool output all become a normal thrown `Error` — `jobRunner` catches it and
  marks the job `failed` with that message, never crashing the process.

Prompt-injection handling is provider-independent: the mock provider treats
`MOCK-INJ` as just another regex rule (report it, do nothing else); the llm
prompt tells the model the diff is inert data. I verified this by including
an "ignore previous instructions..." line in a diff that also had five other
violations — all six findings still came back, in order, nothing suppressed.

## Verifying the cross-cutting behaviors

`test/smoke.js` spawns the real server as a child process and drives it over
HTTP/SSE (65 assertions, `npm test`). What it checks, mapped to what's scored:

- **Chunking** — a 6-file/121 KB diff packs into 2 chunks (verified file
  boundaries are respected, no file split); all 1500 expected findings
  present with unique `id`s (no loss/dup across the boundary). A separate
  ~180-line single-file diff over 64 KiB was checked to become its own
  chunk. Findings order is asserted equal to a manual `path→line→ruleId`
  sort of the same array.
- **Caching** — same `{diff, options}` submitted twice (no key) gets two
  different `jobId`s but the second reports `cacheHit: true` with
  `findings` deep-equal to the first run's.
- **Idempotency** — same `Idempotency-Key` + identical body twice returns
  the same `jobId`; same key + a one-byte-different body returns `409`.
- **SSE + replay** — captured the full event stream for a finished job,
  reconnected, captured it again, asserted the two captures are
  byte-for-byte identical JSON (status → finding × N → done).
- **Concurrency** — fired 5 jobs at once against a limit of 4 and confirmed
  all 5 (including the queued 5th) reach `done`.
- **Rate limiting** — burst-submitted until a `429` appeared, confirmed
  every prior response was `202` (never a 5xx under burst) and the `429`
  carries `Retry-After`.
- Also covered: auth on `/v1/*` (missing/wrong token → `401`), the full
  error taxonomy (`400`/`413`/`422`/`404`/`409`/`429`), and all nine mock
  rules including `MOCK-INJ` on one crafted diff.
- **llm graceful failure** was checked manually (not in the automated
  suite, since it needs no credentials by design): submitting with
  `"provider": "llm"` and no `ANTHROPIC_API_KEY` set yields
  `status: "failed"` with a clear `error.message`, `200` on the GET, no
  crash.

Two real bugs were caught this way, not by inspection: an initial
`BURST_LIMIT` of 10 caused unrelated later assertions to get spuriously
`429`'d during the suite itself (fixed by raising it to 30, see below), and
`usage.chunks` was reported as `0` on a failed job because it was only
attached to the job record after the provider loop succeeded (fixed by
attaching it right after chunking, before any provider call).

## AI tools used

Built end-to-end with Claude Code (Claude Sonnet 5) against the task brief
and this repo's `CANDIDATE-TASK.md`, including the diff parser, all
providers, the test suite, and this document. I reviewed and ran everything
locally before submitting.

## An AI suggestion I rejected

The first draft of `jobRunner.js` emitted `finding` SSE events *as each
chunk was scanned* — i.e. true "discover and emit immediately" streaming,
processing chunks (and lines within them) in raw diff order. It looked
right and matched the literal words "as discovered." I rejected it once I
re-checked the spec line "Ordering everywhere (**results and streams**): by
`path`, then `line`, then `ruleId`" — diff order and sorted order aren't the
same thing (e.g. a diff touching `z.ts` before `a.ts`), so that draft would
have produced a stream whose finding order didn't match the final `GET`
result's order, and worse, wouldn't even have been byte-identical across
disconnect/reconnect if timing shifted anything (it wouldn't have, since
findings themselves are deterministic, but it made "identical" harder to
reason about and verify). I changed it to: compute the whole job's findings,
sort/dedupe/truncate once, then emit `finding` events in that final order.
Streaming still shows progress transitions (`queued → running → done`
happen genuinely asynchronously via the queue), but the finding events
themselves are the same list, same order, as the `GET` response — which is
what let me write a single "capture stream, capture again, diff them" test
instead of two different notions of "correct order."

Smaller one: I considered wiring an actual queue/store for jobs (Redis) so
state would survive a restart. I rejected it for this submission — the
scoring window is time-boxed and single-instance, and it would have traded
a chunk of implementation and deploy-config time for a property (restart
survival) that isn't part of the graded contract. It's the first thing
listed below for "more time," not something I think is actually unnecessary.

## What I'd do next with more time

- Persist jobs/cache/idempotency keys outside process memory (Redis or
  Postgres) so the service survives a restart/redeploy without losing
  in-flight jobs, and so it could run as more than one instance.
- Process a job's chunks concurrently (currently sequential within a job)
  now that correctness is nailed down — would matter for very large diffs.
- Widen `MOCK-004` to reason about brace context without requiring the
  opening brace on the `catch(` line itself, using the diff's hunk context
  lines (currently visible but unused for this rule) instead of only added
  lines.
- Multi-provider `llm` support (OpenAI/local models) with retry/backoff
  instead of a single attempt + timeout.
- A `/metrics` endpoint (queue depth, cache hit rate, provider latency) —
  useful for exactly the kind of production service this task is modeling.
- A Dockerfile for a fully reproducible deploy, independent of the tunnel
  used for this submission's scoring window.
