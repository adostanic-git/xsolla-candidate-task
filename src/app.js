const express = require('express');
const crypto = require('crypto');

const config = require('./config');
const { sendError } = require('./errors');
const { sha256, canonicalCacheKey } = require('./hash');
const { parseDiff } = require('./diff');
const { jobs, contentCache, idempotencyKeys } = require('./store');
const { getOrCreateChannel } = require('./sse');
const { processJob, finalizeFromCache } = require('./jobRunner');
const { TokenBucket } = require('./rateLimiter');
const { ConcurrentQueue } = require('./queue');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key');
  next();
});

const bucket = new TokenBucket(config.BURST_LIMIT, config.RATE_LIMIT_PER_MINUTE);
const queue = new ConcurrentQueue(config.MAX_CONCURRENT_JOBS);
const startedAt = Date.now();

// cacheKey -> Promise<cacheEntry|null>, resolved once the first job for that
// key finishes. Lets identical requests submitted before the first one
// completes join its result (cacheHit: true) instead of redoing the work
// and racing to populate contentCache themselves.
const inFlightByCacheKey = new Map();

// --- public routes ---

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: config.VERSION,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  });
});

app.get('/spec', (req, res) => {
  res.status(200).json({
    specVersion: '1.0',
    providers: ['mock', 'llm'],
    limits: {
      maxPayloadBytes: config.MAX_PAYLOAD_BYTES,
      chunkBytes: config.CHUNK_BYTES,
      maxConcurrentJobs: config.MAX_CONCURRENT_JOBS,
      rateLimitPerMinute: config.RATE_LIMIT_PER_MINUTE,
      burstLimit: config.BURST_LIMIT,
    },
  });
});

// --- auth for all /v1/* routes ---

function authMiddleware(req, res, next) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match || match[1] !== config.AUTH_TOKEN) {
    return sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
  }
  next();
}

app.use('/v1', authMiddleware);

function rateLimitMiddleware(req, res, next) {
  const result = bucket.take();
  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfterSeconds));
    return sendError(res, 429, 'rate_limited', 'Too many requests, please retry later');
  }
  next();
}

const jsonParser = express.json({
  limit: config.MAX_PAYLOAD_BYTES,
  // Parse the body as JSON regardless of the Content-Type header, so a
  // malformed body without (or with the wrong) Content-Type still hits the
  // JSON parser and yields a 400 invalid_json instead of silently falling
  // through as an empty body and mis-reporting as 422 invalid_diff.
  type: () => true,
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
});

app.post('/v1/reviews', rateLimitMiddleware, jsonParser, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const diff = typeof body.diff === 'string' ? body.diff : null;
  if (diff === null || diff.trim().length === 0) {
    return sendError(res, 422, 'invalid_diff', 'diff is required and must be a non-empty string');
  }

  const parsed = parseDiff(diff);
  if (!parsed.valid) {
    return sendError(res, 422, 'invalid_diff', 'diff could not be parsed as a unified diff');
  }

  const optionsIn = body.options && typeof body.options === 'object' ? body.options : {};
  const provider = optionsIn.provider === 'llm' ? 'llm' : 'mock';
  const maxFindings =
    Number.isInteger(optionsIn.maxFindings) && optionsIn.maxFindings > 0
      ? optionsIn.maxFindings
      : config.MAX_FINDINGS_DEFAULT;
  const normalizedOptions = { provider, maxFindings };

  const rawBodyHash = sha256(req.rawBody || Buffer.from(JSON.stringify(body)));
  const idKey = req.headers['idempotency-key'];

  if (idKey) {
    const existing = idempotencyKeys.get(idKey);
    if (existing) {
      if (existing.bodyHash === rawBodyHash) {
        // The contract for POST /v1/reviews is always `202 -> { jobId, status:
        // "queued" }` - this is a replay of that acceptance response, not a
        // status lookup, so it must report "queued" even if the original job
        // has since moved on to running/done/failed. Use GET /v1/reviews/:id
        // to observe actual progress.
        return res.status(202).json({ jobId: existing.jobId, status: 'queued' });
      }
      return sendError(res, 409, 'idempotency_conflict', 'Idempotency-Key already used with a different request body');
    }
  }

  const jobId = crypto.randomUUID();
  const cacheKey = canonicalCacheKey(diff, normalizedOptions);

  const job = {
    jobId,
    status: 'queued',
    diff,
    options: normalizedOptions,
    cacheKey,
    createdAt: Date.now(),
    // inputBytes is known immediately; chunks/cacheHit are filled in once
    // processing actually starts. Set up front so GET reports usage from
    // the moment a job is queued, not only once it reaches done/failed.
    usage: { inputBytes: Buffer.byteLength(diff, 'utf8'), chunks: 0, cacheHit: false },
  };
  jobs.set(jobId, job);

  if (idKey) {
    idempotencyKeys.set(idKey, { bodyHash: rawBodyHash, jobId });
  }

  res.status(202).json({ jobId, status: 'queued' });

  const cached = contentCache.get(cacheKey);
  if (cached) {
    setImmediate(() => finalizeFromCache(job, cached));
  } else {
    const inFlight = inFlightByCacheKey.get(cacheKey);
    if (inFlight) {
      inFlight.then((result) => {
        if (result) {
          finalizeFromCache(job, result);
        } else {
          queue.push(() => processJob(job));
        }
      });
    } else {
      let resolveInFlight;
      const inFlightPromise = new Promise((resolve) => {
        resolveInFlight = resolve;
      });
      inFlightByCacheKey.set(cacheKey, inFlightPromise);
      queue.push(() =>
        processJob(job).then(() => {
          inFlightByCacheKey.delete(cacheKey);
          resolveInFlight(job.status === 'done' ? contentCache.get(cacheKey) : null);
        })
      );
    }
  }
});

app.get('/v1/reviews/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return sendError(res, 404, 'not_found', 'No job with that id');
  }
  const body = { jobId: job.jobId, status: job.status };
  if (job.status === 'done' || job.status === 'failed') {
    body.findings = job.findings || [];
  }
  if (job.usage) body.usage = job.usage;
  if (job.status === 'failed' && job.error) body.error = job.error;
  res.status(200).json(body);
});

app.get('/v1/reviews/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return sendError(res, 404, 'not_found', 'No job with that id');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();

  const channel = getOrCreateChannel(job.jobId);

  const write = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  for (const entry of channel.log) {
    write(entry.event, entry.data);
  }

  if (channel.closed) {
    res.end();
    return;
  }

  const onEvent = ({ event, data }) => write(event, data);
  const onClose = () => {
    channel.off('event', onEvent);
    res.end();
  };
  channel.on('event', onEvent);
  channel.once('close', onClose);

  req.on('close', () => {
    channel.off('event', onEvent);
    channel.off('close', onClose);
  });
});

// --- fallbacks ---

app.use((req, res) => {
  sendError(res, 404, 'not_found', 'No such route');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return sendError(res, 413, 'payload_too_large', 'Payload exceeds the 1 MiB limit');
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
  }
  console.error('unexpected error:', err);
  sendError(res, 500, 'internal', 'Internal server error');
});

module.exports = app;
