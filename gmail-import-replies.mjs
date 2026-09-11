#!/usr/bin/env node

/**
 * gmail-import-replies.mjs — automatic Gmail input into the reply-watch.mjs
 * classification pipeline (builds out #1583, the "unbuilt" Gmail scanner
 * `paste-reply.mjs` documents as the planned counterpart to its manual path).
 *
 * reply-watch.mjs already classifies employer replies (Interview / Responded /
 * Need Action / Rejected / Offer / Auto-confirmation / Account Creation /
 * Noise / Unknown), matches them to tracker rows, and prompts before touching
 * data/applications.md — but its only input is data/reply-candidates.json.
 * paste-reply.mjs populates that file one email at a time, by hand.
 *
 * This script is the automated counterpart: it does NOT read Gmail itself
 * (no MCP/OAuth client lives in a standalone Node script in this project —
 * Gmail access is a tool available to the driving agent, not to `node`).
 * Instead it accepts a BATCH of already-fetched messages as JSON — the agent
 * calls Gmail search/read tools, normalizes the results into this shape, and
 * hands them to this script, which does the part that must be careful:
 *
 *   1. Dedupes against every message_id already in data/reply-candidates.json,
 *      so re-running the same Gmail search (recurring schedule, retried scan)
 *      never re-imports or double-counts a message.
 *   2. Appends ONLY the genuinely new candidates, exactly like paste-reply.mjs
 *      — never classifies, never touches data/applications.md.
 *   3. Advances data/gmail-scan-state.json's checkpoint so the next scan's
 *      Gmail search can be scoped to "since last checkpoint" instead of
 *      re-fetching the whole mailbox every run.
 *
 * Input batch shape (JSON array), one object per message:
 *   {
 *     "message_id": "<real Gmail message id — REQUIRED, the dedup key>",
 *     "from": "sender@example.com",
 *     "subject": "...",
 *     "body_snippet": "...",
 *     "date": "2026-09-08T12:00:00Z"   // optional, RFC 3339 — advances the checkpoint
 *   }
 *
 * A message with no message_id is rejected (loudly) rather than silently
 * imported with a synthesized id — a synthesized id can never be deduped
 * against on a later run, so the same real email would flood the digest with
 * a fresh "new" candidate every single scan.
 *
 * Usage:
 *   node gmail-import-replies.mjs --batch-file batch.json
 *   node gmail-import-replies.mjs --batch-file batch.json --dry-run
 *   node gmail-import-replies.mjs --help
 *
 * Env:
 *   CAREER_OPS_REPLY_CANDIDATES  override the candidates JSON path (tests;
 *                                 defaults to data/reply-candidates.json)
 *   CAREER_OPS_GMAIL_SCAN_STATE  override the checkpoint JSON path (tests;
 *                                 defaults to data/gmail-scan-state.json)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameSyncWithRetry } from './tracker-utils.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || path.join(__dirname, 'data', 'reply-candidates.json');
const STATE_PATH = process.env.CAREER_OPS_GMAIL_SCAN_STATE
  || path.join(__dirname, 'data', 'gmail-scan-state.json');

/**
 * Load the existing candidates array. A missing file is an empty array (first
 * run); a malformed file fails loudly rather than silently discarding
 * whatever the file held.
 */
function loadCandidates(candidatesPath) {
  if (!fs.existsSync(candidatesPath)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
  } catch (e) {
    throw new Error(`Could not parse existing candidates file at ${candidatesPath}: ${e.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Existing candidates file at ${candidatesPath} is not a JSON array`);
  }
  return parsed;
}

/**
 * Write-then-rename so an interrupted write (crash, signal, disk full) can
 * never leave the real file truncated or corrupted — same pattern as
 * paste-reply.mjs's appendCandidate().
 */
function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf-8');
  renameSyncWithRetry(tmpPath, filePath);
}

/**
 * Normalize one raw batch entry into the exact candidate shape reply-watch.mjs
 * expects, or return an error string if it cannot (missing message_id).
 * Exported for direct unit testing.
 */
export function normalizeBatchEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return { error: 'entry is not an object' };
  }
  const message_id = typeof entry.message_id === 'string' ? entry.message_id.trim() : '';
  if (!message_id) {
    return { error: 'missing message_id (required — it is the dedup key)' };
  }
  return {
    candidate: {
      message_id,
      from: typeof entry.from === 'string' ? entry.from : '',
      subject: typeof entry.subject === 'string' ? entry.subject : '',
      body_snippet: typeof entry.body_snippet === 'string' ? entry.body_snippet : '',
      // Classification is reply-watch.mjs's job, not this script's.
      signal: null,
    },
    date: typeof entry.date === 'string' ? entry.date : null,
  };
}

/**
 * Import a batch of raw entries: dedupe against existing message_ids, append
 * only the new ones, and report what happened. Exported for direct unit
 * testing (no file I/O side effect beyond the paths passed in).
 *
 * @returns {{ imported: object[], skippedDuplicate: string[], skippedInvalid: string[], newestDate: string|null }}
 */
export function importBatch(batch, existingCandidates) {
  const existingIds = new Set(existingCandidates.map(c => c.message_id));
  const imported = [];
  const skippedDuplicate = [];
  const skippedInvalid = [];
  let newestDate = null;

  for (const entry of batch) {
    const { candidate, date, error } = normalizeBatchEntry(entry);
    if (error) {
      skippedInvalid.push(`${JSON.stringify(entry?.subject ?? entry)} — ${error}`);
      continue;
    }
    if (existingIds.has(candidate.message_id)) {
      skippedDuplicate.push(candidate.message_id);
      continue;
    }
    existingIds.add(candidate.message_id); // guard against dupes WITHIN one batch too
    imported.push(candidate);
    if (date && (!newestDate || date > newestDate)) newestDate = date;
  }

  return { imported, skippedDuplicate, skippedInvalid, newestDate };
}

function printHelp() {
  console.log(`gmail-import-replies.mjs — automated Gmail input into the reply-watch.mjs pipeline (#1583)

Usage:
  node gmail-import-replies.mjs --batch-file <path.json>   import a batch of Gmail messages
  node gmail-import-replies.mjs --batch-file <path.json> --dry-run   preview without writing
  node gmail-import-replies.mjs --help

Batch file: a JSON array of {message_id, from, subject, body_snippet, date?}.
message_id MUST be the real Gmail message id — it is the sole dedup key, so a
missing/synthesized id would re-import the same email on every future scan.

Dedupes against every message_id already in data/reply-candidates.json, appends
only new candidates, and advances data/gmail-scan-state.json's checkpoint to
the newest "date" seen in this batch (so the next scan's Gmail search can start
from there instead of re-fetching the whole mailbox).

Never classifies a reply and never touches data/applications.md — run
\`node reply-watch.mjs\` afterward to review and (optionally) apply tracker
updates, exactly as the manual paste-reply.mjs path does.`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  const dryRun = args.includes('--dry-run');
  const fileIdx = args.indexOf('--batch-file');
  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error('Error: --batch-file <path.json> is required. See --help.');
    process.exit(1);
  }
  const batchPath = args[fileIdx + 1];
  if (!fs.existsSync(batchPath)) {
    console.error(`Error: batch file not found: ${batchPath}`);
    process.exit(1);
  }

  let batch;
  try {
    batch = JSON.parse(fs.readFileSync(batchPath, 'utf-8'));
  } catch (e) {
    console.error(`Error: could not parse batch file as JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(batch)) {
    console.error('Error: batch file must contain a JSON array.');
    process.exit(1);
  }

  const existing = loadCandidates(CANDIDATES_PATH);
  const { imported, skippedDuplicate, skippedInvalid, newestDate } = importBatch(batch, existing);

  if (skippedInvalid.length > 0) {
    console.warn(`⚠️  ${skippedInvalid.length} entr${skippedInvalid.length === 1 ? 'y' : 'ies'} skipped (invalid):`);
    for (const s of skippedInvalid) console.warn(`   - ${s}`);
  }

  if (dryRun) {
    console.log(`🔎 Dry run: would import ${imported.length} new candidate(s), skip ${skippedDuplicate.length} already-seen.`);
    return;
  }

  if (imported.length > 0) {
    writeJsonAtomic(CANDIDATES_PATH, [...existing, ...imported]);
  }

  // Advance the checkpoint even when nothing new was imported — "we checked
  // and found nothing since X" is still forward progress, and re-scanning the
  // same already-empty window on the next run would waste a Gmail search.
  const state = fs.existsSync(STATE_PATH)
    ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'))
    : {};
  const nowIso = new Date().toISOString();
  state.lastScanAt = nowIso;
  if (newestDate && (!state.lastMessageDate || newestDate > state.lastMessageDate)) {
    state.lastMessageDate = newestDate;
  }
  writeJsonAtomic(STATE_PATH, state);

  console.log(`✅ Imported ${imported.length} new candidate(s). Skipped ${skippedDuplicate.length} already-seen.`);
  if (imported.length > 0) {
    console.log('Run `node reply-watch.mjs` to classify and review tracker updates.');
  }
}

// Guard mirrors paste-reply.mjs's own CLI-vs-import check, so this module can
// be imported directly for unit testing without running main(). Uses the
// shared isMainModule() rather than a hand-rolled process.argv[1] comparison —
// sixty entrypoints once hand-rolled that exact check in six spellings, and
// all but one silently no-op through a symlinked checkout (#3170).
if (isMainModule(import.meta.url)) {
  main();
}
