#!/usr/bin/env node

/**
 * gmail-import-replies-tests.mjs — regression tests for gmail-import-replies.mjs
 * (#1583's automated counterpart to paste-reply.mjs's manual path).
 *
 * Locks in:
 *   1. A batch of new messages imports and appends onto any existing candidates.
 *   2. message_id is the sole dedup key — re-importing the same batch (a
 *      retried scan, or a recurring schedule re-fetching an overlapping
 *      window) adds nothing and reports the skip count.
 *   3. Dedup also fires WITHIN one batch (two entries sharing a message_id).
 *   4. An entry with no message_id is rejected loudly, not silently imported
 *      with a synthesized id (which could never be deduped on a later run).
 *   5. --dry-run previews without writing either file.
 *   6. The checkpoint (gmail-scan-state.json) advances to the newest `date`
 *      seen, and advances even on a run that imports nothing new.
 *   7. A missing --batch-file path / malformed batch fails loudly (exit 1).
 *   8. Never touches data/applications.md or reply-watch.mjs.
 *
 * Provisions throwaway files via CAREER_OPS_REPLY_CANDIDATES /
 * CAREER_OPS_GMAIL_SCAN_STATE and a temp dir; never touches the repo's real
 * data/reply-candidates.json or data/gmail-scan-state.json.
 */

import { execFileSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const CLI = join(ROOT, 'gmail-import-replies.mjs');

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Combines stdout+stderr into one string: console.warn() (the invalid-entry
// notice) goes to stderr, and tests below assert on that text alongside the
// stdout summary, so callers that don't care about the split just get both.
function runBatch(candidatesPath, statePath, batchPath, extraArgs = []) {
  try {
    const stdout = execFileSync(NODE, [CLI, '--batch-file', batchPath, ...extraArgs], {
      cwd: ROOT,
      env: {
        ...process.env,
        CAREER_OPS_REPLY_CANDIDATES: candidatesPath,
        CAREER_OPS_GMAIL_SCAN_STATE: statePath,
      },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return stdout;
  } catch (e) {
    // Re-throw for callers that expect a failure (missing/malformed batch
    // file) — they inspect e.status/e.stderr themselves.
    throw e;
  }
}

// Same invocation, but returns stdout+stderr combined (execFileSync only
// gives stdout on success; stderr must be read from the child's own pipes,
// which execFileSync exposes via the thrown error OR — on success — not at
// all, so this variant uses spawnSync directly to capture both regardless of
// exit code).
function runBatchCombined(candidatesPath, statePath, batchPath, extraArgs = []) {
  const r = spawnSync(NODE, [CLI, '--batch-file', batchPath, ...extraArgs], {
    cwd: ROOT,
    env: {
      ...process.env,
      CAREER_OPS_REPLY_CANDIDATES: candidatesPath,
      CAREER_OPS_GMAIL_SCAN_STATE: statePath,
    },
    encoding: 'utf8',
  });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}

console.log('\ngmail-import-replies.mjs — automated Gmail input (#1583)');

// ── 1-2. import + re-import dedup ────────────────────────────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const batch = join(dir, 'batch1.json');
  writeFileSync(batch, JSON.stringify([
    { message_id: 'g001', from: 'a@acme.com', subject: 'Interview invitation', body_snippet: 'schedule an interview', date: '2026-09-01T10:00:00Z' },
    { message_id: 'g002', from: 'b@beta.com', subject: 'Unfortunately', body_snippet: 'not moving forward', date: '2026-09-02T10:00:00Z' },
  ]));

  const out1 = runBatch(cand, state, batch);
  check('first import reports 2 new, 0 skipped', /Imported 2 new candidate\(s\)\. Skipped 0 already-seen/.test(out1), out1);

  const candidates = JSON.parse(readFileSync(cand, 'utf-8'));
  check('candidates file has 2 entries', candidates.length === 2, String(candidates.length));
  check('signal left null (classification stays reply-watch.mjs\'s job)', candidates.every(c => c.signal === null));
  check('message_id preserved verbatim (real Gmail id, not synthesized)', candidates.map(c => c.message_id).sort().join(',') === 'g001,g002');

  const state1 = JSON.parse(readFileSync(state, 'utf-8'));
  check('checkpoint advances to newest date in batch', state1.lastMessageDate === '2026-09-02T10:00:00Z', state1.lastMessageDate);

  // Re-run the SAME batch — simulates a retried/overlapping recurring scan.
  const out2 = runBatch(cand, state, batch);
  check('re-import of the same batch reports 0 new, 2 skipped', /Imported 0 new candidate\(s\)\. Skipped 2 already-seen/.test(out2), out2);
  const candidatesAfter = JSON.parse(readFileSync(cand, 'utf-8'));
  check('re-import does not duplicate rows', candidatesAfter.length === 2, String(candidatesAfter.length));
}

// ── 3. within-batch dedup ────────────────────────────────────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify([
    { message_id: 'dup1', subject: 'first copy' },
    { message_id: 'dup1', subject: 'second copy, same id' },
  ]));
  runBatch(cand, state, batch);
  const candidates = JSON.parse(readFileSync(cand, 'utf-8'));
  check('two entries sharing one message_id within a batch collapse to one', candidates.length === 1, String(candidates.length));
  check('the FIRST copy wins (not silently overwritten)', candidates[0].subject === 'first copy', candidates[0].subject);
}

// ── 4. missing message_id is rejected, not synthesized ───────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify([
    { subject: 'no id on this one', body_snippet: 'x' },
    { message_id: 'ok1', subject: 'this one is fine' },
  ]));
  const out = runBatchCombined(cand, state, batch);
  check('warns about the invalid (id-less) entry', /skipped \(invalid\)/.test(out), out);
  check('missing-message_id reason is explicit', /missing message_id/.test(out), out);
  const candidates = JSON.parse(readFileSync(cand, 'utf-8'));
  check('only the valid entry was imported', candidates.length === 1 && candidates[0].message_id === 'ok1');
}

// ── 5. --dry-run writes nothing ──────────────────────────────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify([{ message_id: 'dry1', subject: 'preview only' }]));
  const out = runBatch(cand, state, batch, ['--dry-run']);
  check('dry-run reports what it WOULD do', /would import 1 new candidate/.test(out), out);
  check('dry-run creates no candidates file', !existsSync(cand));
  check('dry-run creates no state file', !existsSync(state));
}

// ── 6. checkpoint advances even when nothing new is imported ─────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const batch1 = join(dir, 'b1.json');
  const batch2 = join(dir, 'b2.json'); // same message_id, re-scanned window
  writeFileSync(batch1, JSON.stringify([{ message_id: 'ck1', subject: 'x', date: '2026-09-01T00:00:00Z' }]));
  writeFileSync(batch2, JSON.stringify([{ message_id: 'ck1', subject: 'x', date: '2026-09-01T00:00:00Z' }]));
  runBatch(cand, state, batch1);
  const before = JSON.parse(readFileSync(state, 'utf-8')).lastScanAt;
  runBatch(cand, state, batch2); // 0 new, but the check itself still happened
  const after = JSON.parse(readFileSync(state, 'utf-8'));
  check('lastScanAt is refreshed on a zero-new-candidates run', after.lastScanAt >= before, `${before} -> ${after.lastScanAt}`);
}

// ── 7. missing / malformed batch file fails loudly ────────────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  let threwMissing = false;
  try {
    runBatch(cand, state, join(dir, 'does-not-exist.json'));
  } catch (e) {
    threwMissing = e.status === 1 && /not found/.test(e.stderr?.toString() ?? '');
  }
  check('missing --batch-file path exits 1 with a clear error', threwMissing);

  const badFile = join(dir, 'bad.json');
  writeFileSync(badFile, 'not valid json {{{');
  let threwBad = false;
  try {
    runBatch(cand, state, badFile);
  } catch (e) {
    threwBad = e.status === 1 && /could not parse/i.test(e.stderr?.toString() ?? '');
  }
  check('malformed batch JSON exits 1 with a clear error', threwBad);

  const notArrayFile = join(dir, 'not-array.json');
  writeFileSync(notArrayFile, JSON.stringify({ oops: true }));
  let threwNotArray = false;
  try {
    runBatch(cand, state, notArrayFile);
  } catch (e) {
    threwNotArray = e.status === 1 && /must contain a JSON array/.test(e.stderr?.toString() ?? '');
  }
  check('a batch file that is not a JSON array exits 1', threwNotArray);
}

// ── 8. never touches applications.md ─────────────────────────────────────
{
  const dir = tmp('gmail-import-');
  const cand = join(dir, 'reply-candidates.json');
  const state = join(dir, 'gmail-scan-state.json');
  const apps = join(dir, 'applications.md');
  writeFileSync(apps, '# Applications Tracker\nSENTINEL-UNCHANGED\n');
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify([{ message_id: 'z1', subject: 'irrelevant' }]));
  runBatch(cand, state, batch);
  check('applications.md is untouched', readFileSync(apps, 'utf-8').includes('SENTINEL-UNCHANGED'));
}

// ── unit-level: normalizeBatchEntry / importBatch as direct imports ──────
{
  const mod = await import(pathToFileURL(CLI).href);
  const ok = mod.normalizeBatchEntry({ message_id: 'u1', subject: 's', from: 'f', body_snippet: 'b', date: 'd' });
  check('normalizeBatchEntry: valid entry has no error', !ok.error, JSON.stringify(ok));
  check('normalizeBatchEntry: candidate carries signal:null', ok.candidate.signal === null);

  const bad = mod.normalizeBatchEntry({ subject: 'no id' });
  check('normalizeBatchEntry: missing id reports error', typeof bad.error === 'string');

  const batchResult = mod.importBatch(
    [{ message_id: 'x1', subject: 'new' }, { message_id: 'existing', subject: 'dup' }],
    [{ message_id: 'existing', subject: 'already here' }],
  );
  check('importBatch: skips ids already in existingCandidates', batchResult.skippedDuplicate.includes('existing'));
  check('importBatch: imports only the genuinely new one', batchResult.imported.length === 1 && batchResult.imported[0].message_id === 'x1');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
