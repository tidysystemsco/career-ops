// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// USAJOBS provider — hits the public data.usajobs.gov Search API.
//
// Covers essentially every federal civilian job posting across every agency
// (FBI Professional Staff, FinCEN, IRS-CI, OCC, FDIC, the Federal Reserve
// Banks' shared listings, etc. all post through this one API) via a single
// zero-token, structured JSON source — far more powerful than a per-agency
// websearch-fallback entry.
//
// Requires a free API key: register at https://developer.usajobs.gov (just
// an email address, no cost). Every request needs three headers:
//   Host:               data.usajobs.gov            (always this value)
//   User-Agent:          the email used to register  (identifies the caller)
//   Authorization-Key:   the key you were issued
// Both must be present in the environment as USAJOBS_API_KEY and
// USAJOBS_USER_AGENT (e.g. via .env — see .env.example). Never hardcode a
// key here; this file is system-layer and auto-updatable.
//
// The query itself (Keyword=, LocationName=, JobCategoryCode=, etc.) lives in
// the portal entry's `api:` field, same as any other provider — this file
// just executes exactly that URL with the required auth headers and handles
// pagination. See portals.yml for example entries.

import { fetchJsonWithRetry } from './_http.mjs';

const API_HOST = 'data.usajobs.gov';
const ALLOWED_HOSTS = new Set([API_HOST]);

// USAJOBS' documented maximum ResultsPerPage is 500, but a 500-result page is
// routinely a multi-MB response (each posting embeds a full QualificationSummary)
// that takes well past the shared 10s default fetch timeout — measured at 4.1MB
// / 15s+ for one broad keyword. 100 keeps each page comfortably fast; FETCH_TIMEOUT_MS
// below is a belt-and-suspenders margin on top of that, not a substitute for it.
const RESULTS_PER_PAGE = 100;
const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 10; // 1,000 postings — a query this broad should be narrowed, not paginated past this
const MAX_PAGES_CAP = 50;
const INTER_PAGE_DELAY_MS = 250;
const RETRY_POLICY = { retries: 3 };

/** @param {string} url */
function assertUsajobsUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`usajobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`usajobs: URL must use HTTPS: ${url}`);
  if (!ALLOWED_HOSTS.has(parsed.hostname))
    throw new Error(`usajobs: untrusted hostname "${parsed.hostname}" — must be ${API_HOST}`);
  return url;
}

/** Reads the two required credentials from the environment. Throws a clear,
 * actionable error (never a generic 401) when either is missing, since a
 * scan run should tell the user exactly what to fix rather than fail opaquely. */
function resolveAuthHeaders() {
  const apiKey = process.env.USAJOBS_API_KEY;
  const userAgent = process.env.USAJOBS_USER_AGENT;
  const missing = [];
  if (!apiKey) missing.push('USAJOBS_API_KEY');
  if (!userAgent) missing.push('USAJOBS_USER_AGENT');
  if (missing.length) {
    throw new Error(
      `usajobs: missing ${missing.join(' and ')} in the environment. Register a free key at ` +
      `https://developer.usajobs.gov and set it in .env (see .env.example) — ` +
      `USAJOBS_USER_AGENT must be the email address used to register.`
    );
  }
  return { Host: API_HOST, 'User-Agent': userAgent, 'Authorization-Key': apiKey };
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** @param {any} descriptor */
function toJob(descriptor, entryName) {
  const title = descriptor?.PositionTitle || '';
  const url = descriptor?.PositionURI || (Array.isArray(descriptor?.ApplyURI) ? descriptor.ApplyURI[0] : '') || '';
  const location = descriptor?.PositionLocationDisplay || '';
  // QualificationSummary is the only body-text field USAJOBS' *search*
  // response carries for free — PositionFormattedDescription in the list
  // payload is just a "Dynamic Teaser" label, not real content. A full
  // description requires a per-job detail fetch, which this provider does
  // not do (would defeat the zero-token design for a source this large).
  const description = descriptor?.QualificationSummary || undefined;
  const postedAt = toEpochMs(descriptor?.PublicationStartDate);
  // OrganizationName is the specific hiring agency (e.g. "Federal Bureau of
  // Investigation") — far more useful than the portal entry's own generic
  // name (which might just be "USAJOBS — <query>") since one entry's results
  // can span many agencies depending on the query.
  const company = descriptor?.OrganizationName || entryName;
  return { title, url, company, location, ...(description ? { description } : {}), ...(postedAt ? { postedAt } : {}) };
}

/** @type {Provider} */
export default {
  id: 'usajobs',

  // No auto-detect: USAJOBS entries always carry an explicit `provider:
  // usajobs` field in portals.yml, since a bare careers_url/api host alone
  // (data.usajobs.gov) is shared across every possible query and would be
  // ambiguous to detect a specific entry's intent from.

  async fetch(entry, ctx) {
    const baseUrl = entry.api;
    if (!baseUrl) throw new Error(`usajobs: entry "${entry.name}" has no api: query URL configured`);
    assertUsajobsUrl(baseUrl);
    const headers = resolveAuthHeaders();
    const maxPages = resolveMaxPages(entry);

    /** @type {any[]} */
    const jobs = [];
    for (let page = 1; page <= maxPages; page++) {
      const pageUrl = new URL(baseUrl);
      pageUrl.searchParams.set('ResultsPerPage', String(RESULTS_PER_PAGE));
      pageUrl.searchParams.set('Page', String(page));
      const pageHref = assertUsajobsUrl(pageUrl.href);

      const json = /** @type {any} */ (
        await fetchJsonWithRetry(ctx, pageHref, { headers, redirect: 'error', timeoutMs: FETCH_TIMEOUT_MS }, RETRY_POLICY)
      );
      const items = Array.isArray(json?.SearchResult?.SearchResultItems) ? json.SearchResult.SearchResultItems : [];
      for (const item of items) {
        const descriptor = item?.MatchedObjectDescriptor;
        if (!descriptor?.PositionTitle) continue;
        const job = toJob(descriptor, entry.name);
        if (job.url) jobs.push(job);
      }

      const totalCount = json?.SearchResult?.SearchResultCountAll;
      const fetchedSoFar = page * RESULTS_PER_PAGE;
      const hasMore = items.length === RESULTS_PER_PAGE && (typeof totalCount !== 'number' || fetchedSoFar < totalCount);
      if (!hasMore) break;
      if (page < maxPages) await sleep(INTER_PAGE_DELAY_MS, ctx);
    }

    return jobs;
  },
};
