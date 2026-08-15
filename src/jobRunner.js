const { parseDiff, chunkFiles } = require('./diff');
const { runMock } = require('./providers/mockProvider');
const { runLlm } = require('./providers/llmProvider');
const { getOrCreateChannel } = require('./sse');
const { contentCache } = require('./store');
const config = require('./config');

function compareFindings(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  return 0;
}

function dedupeAndSort(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  out.sort(compareFindings);
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Populates a job (and its SSE event log) instantly from a cached result -
 * no processing needed, but the event log is still built so replay behaves
 * identically to a freshly-processed job.
 */
function finalizeFromCache(job, cached) {
  const channel = getOrCreateChannel(job.jobId);
  job.status = 'running';
  channel.emitEvent('status', { status: 'running' });

  for (const f of cached.findings) {
    channel.emitEvent('finding', f);
  }

  job.findings = cached.findings;
  job.usage = { ...cached.usage, cacheHit: true };
  job.status = 'done';
  channel.emitEvent('done', { total: job.findings.length, usage: job.usage });
}

/**
 * Processes a job end to end: parse -> chunk -> provider -> sort/dedupe ->
 * truncate -> emit SSE events -> finalize. Never throws - failures are
 * captured as a "failed" job status so the queue/process stay healthy.
 */
async function processJob(job) {
  const channel = getOrCreateChannel(job.jobId);
  try {
    job.status = 'running';
    channel.emitEvent('status', { status: 'running' });
    await sleep(5);

    const parsed = parseDiff(job.diff);
    const chunks = chunkFiles(parsed.files, config.CHUNK_BYTES);
    const usage = {
      inputBytes: Buffer.byteLength(job.diff, 'utf8'),
      chunks: chunks.length,
      cacheHit: false,
    };
    job.usage = usage; // visible via GET even if a later chunk fails

    const rawFindings = [];
    for (const chunkFileList of chunks) {
      const chunkFindings =
        job.options.provider === 'llm'
          ? await runLlm(chunkFileList)
          : runMock(chunkFileList);
      rawFindings.push(...chunkFindings);
    }

    const sorted = dedupeAndSort(rawFindings);
    const truncated = sorted.slice(0, job.options.maxFindings);

    for (const f of truncated) {
      channel.emitEvent('finding', f);
    }

    job.findings = truncated;
    job.usage = usage;
    job.status = 'done';

    contentCache.set(job.cacheKey, {
      findings: truncated,
      usage: { inputBytes: usage.inputBytes, chunks: usage.chunks },
    });

    channel.emitEvent('done', { total: truncated.length, usage });
  } catch (err) {
    job.status = 'failed';
    job.error = { code: 'internal', message: err.message || 'internal error' };
    if (!job.usage) {
      job.usage = {
        inputBytes: Buffer.byteLength(job.diff, 'utf8'),
        chunks: 0,
        cacheHit: false,
      };
    }
    channel.emitEvent('status', { status: 'failed', error: job.error });
  }
}

module.exports = { processJob, finalizeFromCache, dedupeAndSort };
