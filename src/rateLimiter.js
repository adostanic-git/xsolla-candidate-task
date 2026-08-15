// Continuous-refill token bucket. Capacity = burst limit; refill rate is
// derived from rateLimitPerMinute so a client sending at exactly the
// sustained rate never gets throttled, while short bursts beyond the
// declared burst capacity get a 429 + Retry-After.
class TokenBucket {
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.ratePerMs = refillPerMinute / 60000;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
    this.lastRefill = now;
  }

  // Returns { allowed, retryAfterSeconds }
  take() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true };
    }
    const deficit = 1 - this.tokens;
    const msNeeded = deficit / this.ratePerMs;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(msNeeded / 1000)) };
  }
}

module.exports = { TokenBucket };
