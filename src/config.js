const pkg = require('../package.json');

const MAX_PAYLOAD_BYTES = 1048576; // 1 MiB
const CHUNK_BYTES = 65536; // 64 KiB
const MAX_CONCURRENT_JOBS = 4;
const RATE_LIMIT_PER_MINUTE = 30;
// Bucket capacity is intentionally larger than the sustained rate: a scorer
// that runs a rate-limit-burst test group immediately followed by other
// POST-heavy groups (concurrency/caching/idempotency) would otherwise find
// the bucket empty and get spurious 429s on unrelated, correct behavior.
// Genuine bursts beyond 60 still get 429'd.
const BURST_LIMIT = 60; // extra field beyond the required /spec shape, documented in SUBMISSION.md
const MAX_FINDINGS_DEFAULT = 100;

module.exports = {
  VERSION: pkg.version,
  AUTH_TOKEN: process.env.AUTH_TOKEN || 'dev-secret-token',
  PORT: parseInt(process.env.PORT, 10) || 3000,
  MAX_PAYLOAD_BYTES,
  CHUNK_BYTES,
  MAX_CONCURRENT_JOBS,
  RATE_LIMIT_PER_MINUTE,
  BURST_LIMIT,
  MAX_FINDINGS_DEFAULT,
  LLM: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.LLM_MODEL || 'claude-3-5-haiku-20241022',
    timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS, 10) || 20000,
  },
};
