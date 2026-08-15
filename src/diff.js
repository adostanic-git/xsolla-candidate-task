// Unified diff parser: splits a diff into per-file segments and, for each
// file, the list of added ("+") lines together with their line number in the
// NEW file. Only added lines matter for the mock rules.

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function splitIntoFileSegments(text) {
  const lines = text.split(/\r\n|\n/);
  const hasGitHeaders = lines.some((l) => l.startsWith('diff --git '));
  const boundaryTest = hasGitHeaders
    ? (l) => l.startsWith('diff --git ')
    : (l) => l.startsWith('--- ');

  const segments = [];
  let current = null;
  for (const line of lines) {
    if (boundaryTest(line)) {
      if (current) segments.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
    // lines before the first boundary (e.g. a leading "index ..." line with
    // no preceding "diff --git") are ignored - not valid unified diff content
  }
  if (current) segments.push(current);
  return segments;
}

function extractPath(segmentLines) {
  let plus = null;
  let minus = null;
  for (const line of segmentLines) {
    if (line.startsWith('+++ ')) plus = line.slice(4).trim();
    else if (line.startsWith('--- ')) minus = line.slice(4).trim();
    if (plus && minus) break;
  }
  const strip = (p) => {
    if (!p || p === '/dev/null') return null;
    // drop optional a/ b/ prefix used by git
    return p.replace(/^[ab]\//, '').split('\t')[0].trim();
  };
  return strip(plus) || strip(minus) || null;
}

function parseFileSegment(segmentLines) {
  const path = extractPath(segmentLines);
  const addedLines = [];
  let newLineNo = null;

  for (const line of segmentLines) {
    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      newLineNo = parseInt(hunkMatch[3], 10);
      continue;
    }
    if (newLineNo === null) continue; // before first hunk in this segment

    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      addedLines.push({ line: newLineNo, text: line.slice(1) });
      newLineNo++;
    } else if (line.startsWith('-')) {
      // removed line: does not exist in new file, no line number change
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" - ignore
    } else {
      // context line (starts with a space, or blank line inside a hunk)
      newLineNo++;
    }
  }

  return {
    path,
    text: segmentLines.join('\n'),
    hunkCount: segmentLines.filter((l) => HUNK_HEADER_RE.test(l)).length,
    addedLines,
  };
}

/**
 * Parses a unified diff into files. Returns { valid, files }.
 * valid=false when the input has no recognizable unified-diff structure.
 */
function parseDiff(diffText) {
  if (typeof diffText !== 'string' || diffText.trim().length === 0) {
    return { valid: false, files: [] };
  }

  const segments = splitIntoFileSegments(diffText);
  if (segments.length === 0) return { valid: false, files: [] };

  const files = segments.map(parseFileSegment).filter((f) => f.hunkCount > 0);

  if (files.length === 0) return { valid: false, files: [] };

  // Assign a fallback path if headers were missing but hunks exist, so
  // downstream code always has a stable, non-null string to sort/report on.
  files.forEach((f, i) => {
    if (!f.path) f.path = `unknown-file-${i + 1}`;
  });

  return { valid: true, files };
}

/**
 * Groups parsed files into chunks of at most CHUNK_BYTES, split only on file
 * boundaries. A single file larger than CHUNK_BYTES becomes its own chunk.
 */
function chunkFiles(files, chunkBytes) {
  const chunks = [];
  let current = [];
  let currentBytes = 0;

  for (const file of files) {
    const fileBytes = Buffer.byteLength(file.text, 'utf8');
    if (current.length > 0 && currentBytes + fileBytes > chunkBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += fileBytes;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

module.exports = { parseDiff, chunkFiles };
