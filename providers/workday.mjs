// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Workday provider — hits the public CXS jobs endpoint (POST, paginated).
// Auto-detects from careers_url pattern
// `https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>`,
// e.g. https://23andme.wd5.myworkdayjobs.com/23 →
//      POST https://23andme.wd5.myworkdayjobs.com/wday/cxs/23andme/23/jobs
//
// Workday only exposes a relative "postedOn" label ("Posted Today",
// "Posted 5 Days Ago", "Posted 30+ Days Ago"); postedAt is derived from it
// and omitted for the unbounded "30+ Days Ago" form.

import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry } from './_http.mjs';

const PAGE_SIZE = 20;

// Safety cap on pagination — applied regardless of what the upstream reports
// as `total` (or, when `total` is absent, regardless of how many full pages
// keep coming back), so a misbehaving/compromised API can't drive this into
// fetching an unbounded number of pages. Override with `max_pages` on the
// portal entry for a tenant that genuinely exceeds it.
const DEFAULT_MAX_PAGES = 100;
// Hard ceiling even for an explicit override. 1500 pages (30,000 postings)
// covers known large tenants (dollartree: 23,609; oreillyauto: 17,061;
// cvshealth: ~16,800) with headroom — not a completeness guarantee, since a
// company directory this size has no fixed upper bound.
const MAX_PAGES_CAP = 1500;

// Retry policy for transient page failures (429 rate-limit, 5xx, timeouts/aborts),
// via providers/_http.mjs's shared fetchJsonWithRetry. Workday's CXS API is
// fronted by a WAF that rate-limits in bursts; without retry, a single 429
// silently truncates an entire tenant (e.g. a 3,383-posting tenant reduced to
// 20 jobs on page 2). Non-transient errors (4xx other than 429) are not
// retried — retrying a malformed request just wastes the budget.
const RETRY_POLICY = { retries: 3 };

// Delay between successive pages *within one tenant's own pagination loop*
// (not between tenants — that's scan-ats-full.mjs's concurrency, a separate
// knob). A burst of same-host requests with zero delay risks Workday's
// WAF-level rate limiting on any tenant that paginates several pages deep
// (large boards like rollsroyce, sec, roche). Only tenants that loop past
// page 1 pay this; no-date-skip and early-stopped tenants never do.
const INTER_PAGE_DELAY_MS = 250;

// Workday returns postings newest-first, so pagination can stop once a
// page's oldest *dated* posting is well past --since — no point paying for
// (and rate-limit-risking) pages that are entirely stale. Only unambiguous
// numeric ages ("Posted N Days Ago", N < 30) count for this; the unbounded
// "30+ Days Ago" bucket never triggers it, so a wide --since (>=30 days)
// simply never early-stops rather than risk a false stop.
//
// The sort isn't perfectly monotonic day-to-day — some tenants (e.g. Adobe)
// return day-labels slightly out of order across consecutive postings ("27
// Days Ago | 26 Days Ago | 27 Days Ago"), roughly 1 day of jitter. The
// margin only needs to clear that; 2 is double it as a plain safety factor,
// not a second measurement.
const EARLY_STOP_MARGIN_MS = 2 * 86_400_000;

// Workday's CXS backend refuses offsets beyond a fixed ceiling and reports
// `total` AT that same ceiling regardless of the board's real size (measured
// live, dickssportinggoods: total=2000 while the tenant's own facet counts
// sum to ~8,400 — see tests/providers/workday-facet-split.test.mjs). A page
// count exactly at DEFAULT_MAX_PAGES with `total` exactly at the offset
// ceiling is the one reliable signature: a genuinely small board reports its
// real total, which only coincides with the ceiling by chance vanishingly
// rarely for a real posting count.
const OFFSET_CEILING = DEFAULT_MAX_PAGES * PAGE_SIZE;

// Recursive facet-split bound: a tenant that reports a clamp at every level,
// on a facet it never runs out of, would otherwise recurse until the board
// does (or the request budget does, which is the coarser and more important
// bound below — this one exists so a SMALL pathological case still stops
// fast rather than merely staying under budget).
const MAX_SPLIT_DEPTH = 4;

// Total page-fetch budget for one tenant's WHOLE fetch (unfaceted crawl plus
// every split slice, at every depth), so one pathological board with a wide,
// perpetually-clamped facet fan-out cannot eat a disproportionate share of a
// full-directory sweep. Scaled off the tenant's own max_pages so a tenant
// explicitly configured for a larger board also gets a larger split budget.
const SPLIT_PAGE_BUDGET_FACTOR = 5;

// How far under the largest facet's own sum the CHOSEN split facet may fall
// and still count as "covers the board". Real Workday facets disagree by a
// point or two against each other (a posting missing one facet's value is
// absent from that facet's counts, never from the true total) — DSG's own
// numbers: trueTotal 8367 (workerSubType), chosen jobFamily sums to 8366, 1
// short against a 77-wide spread across the counted facets. A materiality
// floor is needed so that ordinary disagreement doesn't tag every recovered
// board as still-incomplete and make the tag meaningless.
const SPLIT_COVERAGE_MIN_RATIO = 0.9;

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry) {
  const v = entry?.max_pages;
  if (Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True once a page's oldest unambiguously-dated posting is past the --since window.
 *
 * Undated postings are invisible here. A page of nothing but undated postings
 * never stops pagination (the `dated.length === 0` guard), but a page that
 * mixes stale dated postings with undated ones does — and the undated ones on
 * later pages are then never fetched, even though scan.mjs's date filters
 * would have accepted them. Exported for test-all.mjs, which pins that
 * behaviour so it can't drift without the docs drifting too.
 */
export function pageIsPastWindow(pageJobs, sinceMs) {
  if (typeof sinceMs !== 'number') return false;
  const dated = pageJobs.map((j) => j.postedAt).filter((v) => typeof v === 'number');
  if (dated.length === 0) return false;
  return Math.min(...dated) < sinceMs - EARLY_STOP_MARGIN_MS;
}

/**
 * Resolve a Workday entry's CXS API endpoint from `api:` or `careers_url`.
 * Exported for test-all.mjs, which pins the full-CXS-URL `api:` shape below
 * so it can't regress without the test failing.
 */
export function resolveEndpoint(entry) {
  // Try api: first, then careers_url (mirrors greenhouse/ashby), returning the
  // first that matches the Workday tenant pattern. This lets a branded page
  // (e.g. https://www.ptc.com/en/careers) stay as careers_url while the Workday
  // tenant URL is pinned via api: — and, because we fall through on a non-match,
  // a non-Workday api: value doesn't shadow a valid careers_url.
  for (const url of [entry.api, entry.careers_url]) {
    if (typeof url !== 'string' || !url) continue;
    // `api:` is sometimes already the full CXS jobs endpoint (the documented
    // convention in modes/scan.md's "API/Feed Patterns by Platform" table:
    // https://{tenant}.{instance}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs).
    // Match this shape FIRST — the generic browsing-URL pattern below would
    // otherwise misparse "wday" (the literal path segment) as the site name.
    // Trailing `/jobs` is optional: a CXS base URL (no `/jobs`) names the same
    // board, and without this an api: given in that shorter form fell through
    // to the generic pattern below and reproduced the exact #3498 misparse
    // this branch exists to prevent.
    const cxs = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/wday\/cxs\/[\w-]+\/([^/?#]+)(?:\/jobs)?\/?(?:[?#].*)?$/);
    if (cxs) {
      const [, tenant, instance, site] = cxs;
      const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
      return {
        api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
        jobBase: `${origin}/${site}`,
        origin,
      };
    }
    const m = url.match(/^https:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
    if (!m) continue;
    const [, tenant, instance, site] = m;
    const origin = `https://${tenant}.${instance}.myworkdayjobs.com`;
    return {
      api: `${origin}/wday/cxs/${tenant}/${site}/jobs`,
      // externalPath is relative to the site, not the host root — without the
      // site segment the URL 404s.
      jobBase: `${origin}/${site}`,
      origin,
    };
  }
  return null;
}

function parsePostedOn(label) {
  if (!label) return undefined;
  if (/posted\s+today/i.test(label)) return Date.now();
  if (/posted\s+yesterday/i.test(label)) return Date.now() - 86_400_000;
  const m = label.match(/posted\s+(\d+)(\+?)\s*day/i);
  if (!m || m[2] === '+') return undefined; // "30+ Days Ago" — unbounded, no usable date
  return Date.now() - Number(m[1]) * 86_400_000;
}

// Workday URL path encodes location as /job/{Location-Slug}/{title-slug}.
// Use it as fallback when locationsText is absent (common on some tenants).
function locationFromPath(externalPath) {
  const m = String(externalPath || '').match(/\/job\/([^/]+)\//);
  if (!m) return '';
  let segment;
  try { segment = decodeURIComponent(m[1]); } catch { segment = m[1]; }
  return segment.replace(/-/g, ' ');
}

/**
 * Recover the board's real size from its own facet counts, when a facet
 * carries usable per-value counts. Every facet independently partitions the
 * SAME board, so different facets' sums are alternate estimates of one
 * total — this returns the largest of them, on the theory that a smaller sum
 * only means that facet leaves more postings uncategorized, never that the
 * board is actually smaller (#3517-adjacent: this is the offset-clamp
 * analogue of the "value labelled X doesn't look like one" corroboration
 * pattern — check what a source claims against what it can be shown to add
 * up to, rather than trusting the single reported number).
 *
 * @param {Array<{facetParameter?: string, values?: Array<{count?: number}>}>} facets
 * @returns {number|null} The largest facet-derived sum, or null when no facet
 *   carries a single usable count.
 */
export function trueTotalFromFacets(facets) {
  if (!Array.isArray(facets) || facets.length === 0) return null;
  let best = null;
  for (const facet of facets) {
    const values = Array.isArray(facet?.values) ? facet.values : [];
    const counts = values.map((v) => v?.count).filter((c) => typeof c === 'number');
    if (counts.length === 0) continue;
    const sum = counts.reduce((a, b) => a + b, 0);
    if (best === null || sum > best) best = sum;
  }
  return best;
}

/**
 * Pick the facet to split a clamped query on, and the values to iterate.
 *
 * Default selection minimizes the WORST-CASE slice: the facet whose largest
 * single value is smallest, so the split is as likely as possible to bring
 * every resulting slice back under the offset ceiling in one pass rather than
 * needing to recurse. A facet is only a usable partition when at least two of
 * its values carry both a string id (an id-less entry is a group header, not
 * a filterable value) and a numeric count — a single-valued "facet" would
 * just refetch the same board under a redundant filter.
 *
 * `opts.exclude` keeps a recursive re-split from re-applying a facet already
 * in effect on the current slice, which would derive the same partition
 * forever instead of narrowing it.
 *
 * `opts.locationHints` (`{allow, block}`, arrays of case-insensitive
 * substrings matched against each value's descriptor) lets a caller carve out
 * a configured geographic scope instead of accepting whichever facet happens
 * to minimize the worst case — even a single recognized in-scope value is
 * worth returning here, since the point is regional coverage, not an even
 * partition. Only a facet named/described "location" is considered for this;
 * everything else falls through to the default selection when no in-scope
 * value is found.
 *
 * @param {Array<{facetParameter?: string, descriptor?: string, values?: Array<{id?: string, descriptor?: string, count?: number}>}>} facets
 * @param {{exclude?: string[], locationHints?: {allow?: string[], block?: string[]}}} [opts]
 * @returns {{facetParameter: string, descriptor: string, values: Array<{id: string, descriptor?: string, count: number}>}|null}
 */
export function chooseSplitFacet(facets, opts = {}) {
  const list = Array.isArray(facets) ? facets : [];
  const exclude = new Set(opts.exclude || []);

  if (opts.locationHints) {
    const allow = opts.locationHints.allow || [];
    const block = opts.locationHints.block || [];
    const matchesAny = (text, needles) => needles.some((n) => text.toLowerCase().includes(String(n).toLowerCase()));
    for (const facet of list) {
      const name = String(facet?.facetParameter || '').toLowerCase();
      const desc = String(facet?.descriptor || '').toLowerCase();
      if (name !== 'location' && desc !== 'location') continue;
      const values = (Array.isArray(facet?.values) ? facet.values : []).filter((v) => {
        if (typeof v?.id !== 'string') return false;
        const label = String(v.descriptor || '');
        if (block.length && matchesAny(label, block)) return false;
        return allow.length === 0 || matchesAny(label, allow);
      });
      if (values.length >= 1) {
        return { facetParameter: facet.facetParameter, descriptor: facet.descriptor, values };
      }
    }
    // No in-scope location value found -- fall through to the default pick.
  }

  let best = null;
  let bestWorstCase = Infinity;
  for (const facet of list) {
    if (exclude.has(facet?.facetParameter)) continue;
    const values = (Array.isArray(facet?.values) ? facet.values : [])
      .filter((v) => typeof v?.id === 'string' && typeof v?.count === 'number');
    if (values.length < 2) continue; // not a partition
    const worstCase = Math.max(...values.map((v) => v.count));
    if (worstCase < bestWorstCase) {
      bestWorstCase = worstCase;
      best = { facetParameter: facet.facetParameter, descriptor: facet.descriptor, values };
    }
  }
  return best;
}

/**
 * Stable cross-site dedup key for one Workday requisition (#3439).
 *
 * The same requisition is routinely served under several "sites" of one
 * tenant (an internal `/careers/` site and a syndication site like
 * `/external/` or an Indeed/Glassdoor feed alias) — same tenant, same
 * instance, same requisition ID, different path prefix. Scoped to
 * tenant+instance (the hostname) so an identical requisition ID string on a
 * DIFFERENT tenant, or the same tenant on a different wd instance, never
 * collapses.
 *
 * @param {{url?: string}} entry
 * @returns {string|null}
 */
export function workdayDedupKey(entry) {
  const raw = entry?.url;
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  // Explicit hostname check: a bare underscore-shaped last path segment on a
  // non-Workday host must never coincidentally produce a key (CodeRabbit
  // review) — a `.` must precede "myworkdayjobs.com", not merely the
  // substring, so "evilmyworkdayjobs.com" is rejected too.
  if (!host.endsWith('.myworkdayjobs.com')) return null;

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const lastSegment = segments[segments.length - 1];

  // The last path segment is "{title-slug}_{requisition-id}" — split on the
  // FIRST underscore only, so a requisition ID that itself contains
  // underscores (R26_05710) survives intact rather than being truncated to
  // its final piece.
  const underscoreAt = lastSegment.indexOf('_');
  if (underscoreAt === -1) return null;
  let reqTail = lastSegment.slice(underscoreAt + 1);
  if (!reqTail) return null;

  // Workday appends its own small numeric disambiguator ("-2", "-3", ...) to
  // the requisition tail when the SAME requisition is republished on a
  // second/third site (agf R11312 served on three sites: R11312, R11312-2,
  // R11312-3). Real disambiguators observed are exactly one digit. Stripping
  // any longer trailing "-digits" run would merge genuinely distinct
  // requisitions whose own ID happens to end in a hyphenated number (Walmart
  // R-2593225 vs R-2592964; JR26-39350 vs JR26-42996) into a single key
  // (#3446 review) — so the strip fires only on a one-digit tail.
  const disambiguated = reqTail.match(/^(.+)-(\d)$/);
  if (disambiguated) reqTail = disambiguated[1];

  return `workday:${host}:${reqTail.toLowerCase()}`;
}

export function parseWorkdayResponse(json, entry) {
  const ep = resolveEndpoint(entry);
  const jobBase = ep?.jobBase || '';
  const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
  const jobs = [];
  for (const j of postings) {
    if (j == null) continue;
    if (!j.externalPath || !String(j.title || '').trim()) continue;
    jobs.push({
      title: j.title || '',
      url: jobBase + j.externalPath,
      company: entry.name,
      location: j.locationsText || locationFromPath(j.externalPath),
      postedAt: parsePostedOn(j.postedOn),
    });
  }
  return jobs;
}

/**
 * Whether a query's own reported `total` looks clamped against what its
 * facets independently prove: the facet-derived estimate exceeds it. This is
 * the ONE trigger for facet-split recovery, checked at the top-level query
 * and again at every slice — deliberately NOT tied to the literal
 * OFFSET_CEILING value, since a slice can be clamped at a much smaller total
 * than the tenant-wide ceiling once a facet filter is already narrowing it.
 *
 * @param {number|null} total
 * @param {Array} facets
 * @returns {boolean}
 */
function looksClamped(total, facets) {
  const trueTotal = trueTotalFromFacets(facets);
  return trueTotal !== null && typeof total === 'number' && trueTotal > total;
}

/**
 * One facet-filtered query: page 0, then the same pagination shape
 * `fetch()` runs unfaceted, generalized to an arbitrary `appliedFacets` value
 * and a shared page-fetch budget. Never throws — a slice that fails, even on
 * its own first request, reports itself `incomplete` instead of escaping and
 * dropping whatever the caller has already gathered (the unfaceted crawl's
 * postings, or a sibling slice's).
 *
 * @param {object} entry
 * @param {object} ctx
 * @param {{api: string}} ep
 * @param {object} postOpts
 * @param {object} appliedFacets
 * @param {{used: number, max: number}} budget - Mutated in place.
 * @returns {Promise<{jobs: Array, stopReason: string, total: number|null, facets: Array, incomplete: boolean}>}
 */
async function runQuerySlice(entry, ctx, ep, postOpts, appliedFacets, budget) {
  const sinceMs = typeof ctx?.sinceMs === 'number' ? ctx.sinceMs : null;
  const maxPages = resolveMaxPages(entry);
  const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
  const makeBody = (offset) => JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '', appliedFacets });

  if (budget.used >= budget.max) {
    return { jobs: [], stopReason: 'cap', total: null, facets: [], incomplete: true };
  }
  budget.used++;
  let first;
  try {
    first = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(0) }, RETRY_POLICY);
  } catch {
    return { jobs: [], stopReason: 'fetch-error', total: null, facets: [], incomplete: true };
  }

  const jobs = parseWorkdayResponse(first, entry);
  const total = typeof first?.total === 'number' ? first.total : null;
  const facets = Array.isArray(first?.facets) ? first.facets : [];
  const firstPostings = Array.isArray(first?.jobPostings) ? first.jobPostings : [];

  let pagesToFetch = total !== null
    ? Math.min(Math.ceil(total / PAGE_SIZE), maxPages)
    : (firstPostings.length >= PAGE_SIZE ? maxPages : 1);
  pagesToFetch = Math.min(pagesToFetch, ctxCap);

  let stopReason = 'complete';
  if (pageIsPastWindow(jobs, sinceMs)) stopReason = 'early-stop';
  const sawAnyDatedPosting = jobs.some((j) => typeof j.postedAt === 'number');
  if (stopReason === 'complete' && sinceMs !== null && ctx?.includeUndated !== true
    && !sawAnyDatedPosting && jobs.length > 0) {
    stopReason = 'no-date-skip';
  }

  let page = 1;
  if (stopReason === 'complete') {
    for (; page < pagesToFetch; page++) {
      if (budget.used >= budget.max) { stopReason = 'cap'; break; }
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      budget.used++;
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(page * PAGE_SIZE) }, RETRY_POLICY);
      } catch {
        stopReason = 'fetch-error';
        break;
      }
      const pageJobs = parseWorkdayResponse(json, entry);
      jobs.push(...pageJobs);
      if (total === null) {
        const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
        if (postings.length < PAGE_SIZE) break; // short page → last page reached
      }
      if (pageIsPastWindow(pageJobs, sinceMs)) { stopReason = 'early-stop'; break; }
    }
    if (stopReason === 'complete' && page === pagesToFetch && pagesToFetch === maxPages) {
      stopReason = 'cap';
    }
  }

  // 'early-stop' is exempt: a slice that paginated past the --since window is
  // genuinely done for this sweep, not partial — tagging it would send the
  // whole tenant back through the retry pass on every incremental scan.
  const incomplete = stopReason === 'fetch-error' || stopReason === 'cap';
  return { jobs, stopReason, total, facets, incomplete };
}

/**
 * Recursively partition a clamped query on its facets until every resulting
 * slice reports a total its own facets don't contradict, a depth or budget
 * bound is reached, or no further partition is available.
 *
 * @param {object} entry
 * @param {object} ctx
 * @param {{api: string}} ep
 * @param {object} postOpts
 * @param {object} appliedFacetsSoFar - Facets already applied on the way here.
 * @param {Array} parentFacets - The facets array from the query THIS call is splitting.
 * @param {number} depth
 * @param {{used: number, max: number}} budget
 * @returns {Promise<{jobs: Array, incomplete: boolean}>}
 */
async function runFacetSplit(entry, ctx, ep, postOpts, appliedFacetsSoFar, parentFacets, depth, budget) {
  const excludeNames = Object.keys(appliedFacetsSoFar || {});
  const chosen = depth < MAX_SPLIT_DEPTH ? chooseSplitFacet(parentFacets, { exclude: excludeNames }) : null;

  if (!chosen) {
    // Cannot partition further at this level (no depth left, or no facet
    // qualifies): whatever lies beyond the clamp here is unreachable by any
    // slice, so this branch of the board is not fully covered.
    return { jobs: [], incomplete: true };
  }

  // The clamp is detected against the LARGEST facet sum, but the split runs
  // on whichever facet partitions most finely (the smallest worst case) —
  // when the two disagree, the chosen facet may leave a real slice of the
  // board unrequested by any slice even though every slice it DOES request
  // completes cleanly. A small gap is ordinary disagreement between facets
  // that each leave different postings uncategorized (see
  // SPLIT_COVERAGE_MIN_RATIO); only a materially short sum counts.
  const trueTotal = trueTotalFromFacets(parentFacets);
  const chosenSum = chosen.values.reduce((sum, v) => sum + v.count, 0);
  let incomplete = trueTotal !== null && chosenSum < trueTotal * SPLIT_COVERAGE_MIN_RATIO;

  const jobs = [];
  for (const value of chosen.values) {
    const sliceAppliedFacets = { ...appliedFacetsSoFar, [chosen.facetParameter]: [value.id] };
    const slice = await runQuerySlice(entry, ctx, ep, postOpts, sliceAppliedFacets, budget);
    jobs.push(...slice.jobs);
    if (slice.incomplete) incomplete = true;

    // A slice can be clamped in its own right, on a facet that has not been
    // applied yet — recurse before moving to the next sibling value, so a
    // deeply nested clamp doesn't strand postings behind a slice that was
    // never re-split.
    if (looksClamped(slice.total, slice.facets)) {
      const sub = await runFacetSplit(entry, ctx, ep, postOpts, sliceAppliedFacets, slice.facets, depth + 1, budget);
      jobs.push(...sub.jobs);
      if (sub.incomplete) incomplete = true;
    }
  }

  return { jobs, incomplete };
}

/** @type {Provider} */
export default {
  id: 'workday',
  dedupKey: workdayDedupKey,

  detect(entry) {
    const ep = resolveEndpoint(entry);
    return ep ? { url: ep.api } : null;
  },

  /**
   * Fetch all job postings for a Workday-backed entry, paginating through
   * the tenant's CXS API.
   *
   * Some tenants front their CXS API with Cloudflare bot management (seen
   * live: geico) that 500s requests missing ordinary browser headers — the
   * default UA/accept-language-less request trips it even over plain HTTPS
   * with no other red flags. A real Chrome UA + accept-language + matching
   * origin/referer clears it without needing per-tenant config (same fix
   * as providers/glints.mjs's firewall).
   *
   * @param {{ name?: string, api?: string, careers_url?: string, max_pages?: number }} entry
   * @param {{ fetchJson: (url: string, opts?: object) => Promise<any>, sinceMs?: number, maxPages?: number, syntheticEntries?: boolean }} ctx
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string, postedAt?: number}>>}
   */
  async fetch(entry, ctx) {
    const ep = resolveEndpoint(entry);
    if (!ep) throw new Error(`workday: cannot derive CXS endpoint for ${entry.name}`);

    const postOpts = {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': BROWSER_LIKE_USER_AGENT,
        'accept-language': 'en-US,en;q=0.9',
        origin: ep.origin,
        referer: `${ep.jobBase}/`,
      },
    };
    const makeBody = (offset) => JSON.stringify({ limit: PAGE_SIZE, offset, searchText: '', appliedFacets: {} });
    const sinceMs = typeof ctx?.sinceMs === 'number' ? ctx.sinceMs : null;

    const first = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(0) }, RETRY_POLICY);
    const jobs = parseWorkdayResponse(first, entry);

    const total = typeof first?.total === 'number' ? first.total : null;
    const facets = Array.isArray(first?.facets) ? first.facets : [];
    const firstPostings = Array.isArray(first?.jobPostings) ? first.jobPostings : [];
    const maxPages = resolveMaxPages(entry);

    // How many pages to fetch in total (including the first, already-fetched
    // one): bounded by `total` when the server reports it, always capped at
    // maxPages. When `total` is absent, only probe further pages if the first
    // one was full — a short first page already means there's nothing more.
    let pagesToFetch = total !== null
      ? Math.min(Math.ceil(total / PAGE_SIZE), maxPages)
      : (firstPostings.length >= PAGE_SIZE ? maxPages : 1);

    // Honor a context page cap — verify-portals' liveness probe sets
    // `ctx.maxPages: 1` so it only needs to know a board is live, not its full
    // count. Without this we'd fetch page 0, then request page 1 and trip the
    // probe's second-request sentinel; fetchJsonWithRetry treats that abort as
    // transient and retries it RETRY_POLICY.retries times (with backoff) before giving up
    // — noisy in the logs and rude to the tenant. Capping here makes workday a
    // "cooperating provider" that stops after one page and reports an exact
    // first-page count. Kept separate from `maxPages` so the entry-cap warning
    // below (pagesToFetch === maxPages) stays quiet. No effect on real scans,
    // which don't set ctx.maxPages.
    const ctxCap = Number.isInteger(ctx?.maxPages) && ctx.maxPages > 0 ? ctx.maxPages : Infinity;
    pagesToFetch = Math.min(pagesToFetch, ctxCap);

    // Why pagination stopped — drives which warning (if any) fires below.
    // 'fetch-error' must NOT produce the "raise max_pages" advice: that knob
    // does nothing for a tenant that died on a rate limit rather than hit the cap.
    let stopReason = 'complete';
    if (pageIsPastWindow(jobs, sinceMs)) stopReason = 'early-stop';
    // Some tenants' CXS responses never include postedOn at all (e.g.
    // adventhealth, on every page). Early-stop can't apply then — there's
    // no dated posting to recognize as "past the window".
    const sawAnyDatedPosting = jobs.some((j) => typeof j.postedAt === 'number');

    // Zero dated postings on page 0, --include-undated off, --since-bounded
    // scan: further pagination is pure waste — every posting from this
    // tenant will be dropped downstream as undated regardless of page count
    // (newest-first sort means if the *freshest* postings lack a date, older
    // ones will too). Return page 0's results instead of grinding to maxPages.
    if (stopReason === 'complete' && sinceMs !== null && ctx?.includeUndated !== true
      && !sawAnyDatedPosting && jobs.length > 0) {
      stopReason = 'no-date-skip';
    }

    // Sequential, not concurrent (mirrors providers/4dayweek.mjs, thehub.mjs,
    // arbeitnow.mjs, jibeapply.mjs) — a single tenant's API has no reason to
    // receive a burst of parallel requests, and a mid-run failure stops
    // cleanly with whatever pages were already gathered instead of
    // discarding them (Promise.all would fail the whole batch on one error).
    let page = 1;
    // Counts every request this crawl actually issues (page 0 plus every
    // subsequent page attempted, success or failure alike) — seeds the
    // facet-split budget below so a tenant's total page spend (unfaceted
    // crawl + split) is bounded as ONE ceiling, not the crawl's own pages
    // plus a full separate allowance on top.
    let requestsMade = 1;
    if (stopReason === 'complete') {
      for (; page < pagesToFetch; page++) {
        await sleep(INTER_PAGE_DELAY_MS, ctx);
        let json;
        requestsMade++;
        try {
          json = await fetchJsonWithRetry(ctx, ep.api, { ...postOpts, body: makeBody(page * PAGE_SIZE) }, RETRY_POLICY);
        } catch (err) {
          const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
          // err.attempts (set by fetchJsonWithRetry) is the actual request count —
          // a non-retryable error can end the loop after just one attempt, well
          // short of RETRY_POLICY.retries + 1.
          const attempts = err.attempts ?? RETRY_POLICY.retries + 1;
          console.error(`⚠️  workday: ${entry.name} truncated at ${page + 1} of ${pagesToFetch} pages after ${attempts} attempts (${jobsSummary}): ${err.message}`);
          stopReason = 'fetch-error';
          break;
        }
        const pageJobs = parseWorkdayResponse(json, entry);
        jobs.push(...pageJobs);
        if (total === null) {
          const postings = Array.isArray(json?.jobPostings) ? json.jobPostings : [];
          if (postings.length < PAGE_SIZE) break; // short page → last page reached
        }
        if (pageIsPastWindow(pageJobs, sinceMs)) { stopReason = 'early-stop'; break; }
      }
      if (stopReason === 'complete' && page === pagesToFetch && pagesToFetch === maxPages) {
        stopReason = 'cap';
      }
    }

    // The cap is a safety net, not a working limit — silent by design, but a
    // tenant that actually hits it needs to be surfaced, in one short line
    // (a full-directory scan can hit this on dozens of tenants).
    //
    // "raise max_pages" only applies when `entry` is a real portals.yml
    // tracked_companies entry — there is something to edit. scan-ats-full.mjs's
    // reverse scan synthesizes entries from the external dataset, so there's no
    // portal entry to point at, and no fixed cap can guarantee full coverage of
    // an unbounded company directory anyway; nothing else to suggest there.
    //
    // The branch below used to key on `sinceMs === null` as a proxy for that
    // distinction, which held only because scan-ats-full.mjs was the sole
    // caller setting it. #2418 broke the proxy — `scan.mjs --since` sets
    // ctx.sinceMs too, so a tracked entry lost the actionable half of the
    // message on every --since run (#2495). Provenance is now stated by the
    // caller instead of inferred from an unrelated flag, so a future caller
    // that starts setting sinceMs cannot re-couple the two concerns.
    //
    // Absence means "tracked": scan-ats-full.mjs is the only caller that
    // synthesizes entries AND can reach the cap (discover-ats.mjs and
    // verify-portals.mjs both probe with ctx.maxPages: 1, which never sets
    // stopReason to 'cap'), so it is the one place that opts out.
    const syntheticEntries = ctx?.syntheticEntries === true;
    if (stopReason === 'cap') {
      const jobsSummary = `${jobs.length}${total !== null ? ` of ${total}` : ''} jobs`;
      if (!syntheticEntries) {
        console.error(`⚠️  workday: ${entry.name} truncated at max_pages=${maxPages} (${jobsSummary}) — raise max_pages on this entry for more`);
      } else {
        // Workday's CXS backend can report `total` as exactly
        // maxPages*PAGE_SIZE when the real count is far higher (e.g.
        // dickssportinggoods: total=2000, public site lists 7,120; requests
        // at offset 2000/4000 return the same first posting as offset 0).
        // Flag it, don't explain it here.
        const suspectTag = total !== null && total === maxPages * PAGE_SIZE ? ' (total may be Workday-capped, not real)' : '';
        console.error(`⚠️  workday: ${entry.name} truncated at ${maxPages} pages (${jobsSummary})${suspectTag}`);
      }
    }
    // 'no-date-skip' hits many tenants in a full-directory scan (a company
    // with several Workday sites, like a1group or ashealthnet, triggers it
    // once per site) — a console.error per hit would repeat thousands of
    // times, so tag the array instead; scan-ats-full.mjs aggregates it into
    // one summary line.
    if (stopReason === 'no-date-skip') jobs.workdayNoDateSkip = true;
    // 'fetch-error' means retries were exhausted mid-pagination while 19
    // other tenants were hammering the same uplink. scan-ats-full.mjs
    // collects tagged tenants and retries them sequentially after the
    // parallel sweep, when the line is quiet — same array-tag pattern as
    // workdayNoDateSkip (no extra per-tenant logging here).
    if (stopReason === 'fetch-error') jobs.workdayTruncated = true;

    // Offset-clamp recovery: Workday's CXS backend can refuse offsets beyond
    // a fixed ceiling and report `total` capped there regardless of the
    // board's real size — detectable only by comparing `total` against what
    // the tenant's OWN facet counts add up to (tests/providers/
    // workday-facet-split.test.mjs; measured live, dickssportinggoods:
    // total=2000, facets sum to ~8,400). Runs AFTER the pagination above has
    // already reached its own conclusion, so the split is strictly ADDITIVE
    // to that crawl — a bug here can only add postings it should not have,
    // never lose the ones already gathered.
    if (looksClamped(total, facets)) {
      // Seeded with the unfaceted crawl's own spend: the budget is a ceiling
      // on the tenant's TOTAL page spend (crawl + split), not an additional
      // allowance layered on top of whatever the crawl above already used.
      const budget = { used: requestsMade, max: maxPages * SPLIT_PAGE_BUDGET_FACTOR };
      const seenUrls = new Set(jobs.map((j) => j.url));
      const split = await runFacetSplit(entry, ctx, ep, postOpts, {}, facets, 0, budget);
      let added = 0;
      for (const job of split.jobs) {
        if (seenUrls.has(job.url)) continue;
        seenUrls.add(job.url);
        jobs.push(job);
        added++;
      }
      const label = split.incomplete ? ' (still incomplete)' : '';
      console.error(`⚠️  workday: ${entry.name} offset-clamped at ${total} — recovered ${added} more via facet split${label}`);
      if (split.incomplete) jobs.workdayTruncated = true;
    }

    return jobs;
  },
};
