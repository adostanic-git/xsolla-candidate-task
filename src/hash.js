const crypto = require('crypto');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// Canonical hash of {diff, options} - used for content caching. Key order in
// the options object must not matter, so we normalize before hashing.
function canonicalCacheKey(diff, normalizedOptions) {
  const canonical = JSON.stringify({
    diff,
    provider: normalizedOptions.provider,
    maxFindings: normalizedOptions.maxFindings,
  });
  return sha256(canonical);
}

module.exports = { sha256, canonicalCacheKey };
