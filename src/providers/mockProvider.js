// Deterministic mock provider - implements the MOCK-001..MOCK-008 + MOCK-INJ
// rule table exactly. Rules apply to added ("+") lines only.

const CREDENTIAL_RE = /(api[_-]?key|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i;
const LOOSE_NULL_RE = /(?<![!=])==(?!=)\s*null|(?<!=)!=(?!=)\s*null/;
const INJECTION_RE = /ignore previous instructions|disregard all prior|you are now/i;

const SQL_KEYWORDS = 'SELECT|INSERT|UPDATE|DELETE';
// A quoted string containing a SQL keyword, immediately adjacent (before or
// after) to a '+' concatenation operator - including the '+=' compound
// assignment form (e.g. `sql += "INSERT INTO ..."`).
const SQL_CONCAT_RE = new RegExp(
  `(['"\`])(?:(?!\\1).)*\\b(?:${SQL_KEYWORDS})\\b(?:(?!\\1).)*\\1\\s*\\+=?` +
    `|` +
    `\\+=?\\s*(['"\`])(?:(?!\\2).)*\\b(?:${SQL_KEYWORDS})\\b(?:(?!\\2).)*\\2`,
  'i'
);

// Simple line-level rules: [ruleId, severity, category, title, test(text)]
const LINE_RULES = [
  ['MOCK-001', 'critical', 'security', 'eval usage', (t) => t.includes('eval(')],
  ['MOCK-002', 'critical', 'security', 'hardcoded credential', (t) => CREDENTIAL_RE.test(t)],
  ['MOCK-003', 'high', 'security', 'SQL string concatenation', (t) => SQL_CONCAT_RE.test(t)],
  ['MOCK-005', 'medium', 'correctness', 'loose null comparison', (t) => LOOSE_NULL_RE.test(t)],
  ['MOCK-006', 'medium', 'performance', 'deep-clone via JSON', (t) => t.includes('JSON.parse(JSON.stringify(')],
  ['MOCK-007', 'low', 'style', 'console.log left in', (t) => t.includes('console.log(')],
  ['MOCK-008', 'low', 'style', 'unresolved marker', (t) => t.includes('TODO') || t.includes('FIXME')],
  ['MOCK-INJ', 'critical', 'security', 'prompt-injection content', (t) => INJECTION_RE.test(t)],
];

function makeFinding(ruleId, severity, category, title, path, line, evidence) {
  return {
    id: `${ruleId}:${path}:${line}`,
    ruleId,
    path,
    line,
    severity,
    category,
    title,
    evidence,
  };
}

// MOCK-004: empty catch block. Requires the opening brace on the same added
// line as `catch(...)`, then walks forward through *contiguous* added lines
// (no gap in new-file line numbers, i.e. no unseen context/removed lines in
// between) tracking brace depth until the block closes. If every line inside
// the block is blank or a comment, it is reported as empty. If the block's
// closing brace cannot be located within contiguous added lines, we
// conservatively skip it (we cannot see unchanged lines, so we cannot claim
// certainty either way).
function findEmptyCatchFindings(path, addedLines) {
  const findings = [];
  for (let i = 0; i < addedLines.length; i++) {
    const { line, text } = addedLines[i];
    // The parameter list is optional (ES2019 "optional catch binding":
    // `catch {}` is valid alongside `catch (e) {}`).
    if (!/\bcatch\b\s*(\([^)]*\))?\s*\{/.test(text)) continue;
    const catchIdx = text.indexOf('catch');
    const openIdx = text.indexOf('{', catchIdx);
    if (openIdx === -1) continue; // brace not on this line: unsupported shape

    let depth = 1;
    for (let c = openIdx + 1; c < text.length; c++) {
      if (text[c] === '{') depth++;
      else if (text[c] === '}') depth--;
    }

    const bodyTokens = [text.slice(openIdx + 1)];
    let prevLine = line;
    let closed = depth <= 0;
    let j = i;

    while (!closed) {
      j++;
      if (j >= addedLines.length) { closed = null; break; }
      const next = addedLines[j];
      if (next.line !== prevLine + 1) { closed = null; break; }
      prevLine = next.line;
      for (const ch of next.text) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
      }
      bodyTokens.push(next.text);
      if (depth <= 0) { closed = true; break; }
    }

    if (closed !== true) continue;

    const bodyStr = bodyTokens.join('\n').replace(/[{}]/g, '');
    const meaningful = bodyStr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//') && !l.startsWith('/*') && !l.endsWith('*/'));

    if (meaningful.length === 0) {
      findings.push(makeFinding('MOCK-004', 'high', 'correctness', 'swallowed exception', path, line, text));
    }
  }
  return findings;
}

/**
 * Runs the mock provider over a set of parsed files (already grouped for a
 * chunk, or the whole diff - callers decide). Returns an unsorted, deduped
 * array of findings.
 */
function runMock(files) {
  const seen = new Set();
  const findings = [];

  const push = (f) => {
    if (seen.has(f.id)) return;
    seen.add(f.id);
    findings.push(f);
  };

  for (const file of files) {
    for (const { line, text } of file.addedLines) {
      for (const [ruleId, severity, category, title, test] of LINE_RULES) {
        if (test(text)) {
          push(makeFinding(ruleId, severity, category, title, file.path, line, text));
        }
      }
    }
    for (const f of findEmptyCatchFindings(file.path, file.addedLines)) {
      push(f);
    }
  }

  return findings;
}

module.exports = { runMock };
