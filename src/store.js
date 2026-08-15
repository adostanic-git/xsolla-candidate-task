// In-memory data store. A single process is sufficient for the scoring
// window; see SUBMISSION.md for what a production version would use instead
// (Redis/Postgres) to survive restarts and scale horizontally.

const jobs = new Map(); // jobId -> job record
const contentCache = new Map(); // cacheKey (hash of diff+options) -> { findings, usage }
const idempotencyKeys = new Map(); // idempotencyKey -> { bodyHash, jobId }

module.exports = { jobs, contentCache, idempotencyKeys };
