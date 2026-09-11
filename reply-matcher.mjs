/**
 * reply-matcher.mjs — deterministic matcher that maps email reply candidates to application tracker entries.
 */

export function extractDomain(emailStr) {
  if (!emailStr) return null;
  const match = emailStr.match(/@([\w.-]+)/);
  return match ? match[1].toLowerCase() : null;
}

export function normalizeStr(s) {
  return (s || '').toLowerCase().replace(/\s+/g, '');
}

export function normalizeChinese(s) {
  return (s || '')
    .replace(/有限公司/g, '')
    .replace(/公司/g, '')
    .replace(/股份/g, '')
    .replace(/集团/g, '')
    .trim();
}

// A company value that carries no letter and no digit is a PLACEHOLDER, not a
// name: `?` is the documented marker for an unknown end employer (#1596), and a
// hand-edited row can hold the tracker's other no-data sentinels (`—`, `-`).
// Substring-matching those turns punctuation into a company signal — and since
// replies ask questions, `?` matched almost every mail, scoring 2, corroborating
// partial role matches, and reaching confidence `high` next to any
// post-application keyword.
function isPlaceholderCompany(company) {
  return !/[\p{L}\p{N}]/u.test(company);
}

// Short names must land on a word boundary. The normalized check further down
// has always required more than two characters, but the two substring checks
// above it had no floor at all, so `HP` matched the word `PHP`. A boundary
// keeps the short names that are real — HP, 3M, IBM — while refusing the ones
// that merely occur inside a longer word.
const SHORT_NAME_MAX = 3;

// ...but only where a word boundary can exist. Chinese and Japanese run without
// separators, so every neighbour of a name is itself a letter and the boundary
// NEVER holds — requiring one would refuse `腾讯` inside `我们是腾讯的招聘团队`,
// and two-character names are the norm in those scripts. They keep the
// substring path and the normalizeChinese() handling written for them below.
//
// Hangul is deliberately NOT here. Korean orthography separates words with
// spaces (띄어쓰기), so the boundary holds for it exactly as it does for Latin —
// listing it would have waived the guard for no gain, letting a short Korean
// name match inside a longer word, which is the very bug this rule exists to
// stop. Found because the test asked for it never failed when Hangul was
// removed (CodeRabbit, #3001).
const NO_WORD_SEPARATOR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function matchesOnWordBoundary(text, company) {
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

export function checkCompanyMatch(text, company) {
  if (!company || !text) return false;
  if (isPlaceholderCompany(company)) return false;

  // A short name is decided by the boundary test alone: falling through to the
  // substring checks below would reinstate the very match it just refused.
  // Length is counted in CODE POINTS — `String.length` counts UTF-16 units, so a
  // three-character supplementary-plane name reported 4 and slipped past the
  // threshold into the substring path its BMP equivalent was refused.
  const alphanumeric = company.replace(/[^\p{L}\p{N}]/gu, '');
  const isShortName = Array.from(alphanumeric).length <= SHORT_NAME_MAX;
  if (isShortName && !NO_WORD_SEPARATOR_RE.test(company)) {
    return matchesOnWordBoundary(text, company);
  }

  // Exact substring
  if (text.includes(company)) return true;
  
  const textLower = text.toLowerCase();
  const compLower = company.toLowerCase();
  
  if (textLower.includes(compLower)) return true;

  // Ignore spacing
  const tNorm = normalizeStr(text);
  const cNorm = normalizeStr(company);
  if (cNorm.length > 2 && tNorm.includes(cNorm)) return true;

  // Chinese names normalisation
  const cChi = normalizeChinese(company);
  if (cChi && cChi.length >= 2 && text.includes(cChi)) return true;

  return false;
}

// Generic recruiting/HR vocabulary. These words are common enough in unrelated
// senders' signatures, job titles, and boilerplate (e.g. "Talent Acquisition &
// Diversity" in a recruiter's signature for a *different* company/role) that
// they must never, by themselves, count as a "significant word" match against
// a tracker role title — regardless of length (see #2671).
const GENERIC_ROLE_WORDS = new Set([
  'talent', 'acquisition', 'specialist', 'coordinator', 'operations',
  'recruiter', 'recruiting', 'human', 'resources', 'people'
]);

// Matches any CJK ideograph. Chinese role titles are normally written with no
// whitespace/underscore separators at all ("python开发工程师" is one semantic
// phrase, not one "word"), so the single-word rule below must not treat them
// as a bare single word the way it does for Latin-script titles.
const CJK_RE = /[一-鿿㐀-䶿]/;

// A role title that reduces to a single word — whether that word is generic
// recruiting vocabulary ("Recruiter") or a specific one ("Engineer") — is not
// specific enough to stand alone as an "exact" match: checking it as a whole-
// role substring degenerates into exactly the same bare-word check the
// corroboration requirement exists to gate. Such roles fall through to the
// partial-match path in checkRoleMatch(), which requires company/domain
// corroboration in matchCandidates(). Chinese compound titles are exempted:
// they carry no separators to split on, so "single part" doesn't mean
// "single word" for them.
function isSingleWordRole(role) {
  const parts = role.split(/[\s_\\/()-]+/).filter(Boolean);
  return parts.length === 1 && !CJK_RE.test(parts[0]);
}

// True only when the *entire* role title (or its Chinese, symbol-stripped form)
// appears in the text as one contiguous substring. This is specific enough to
// stand on its own, with no need for a corroborating company/domain signal —
// unless the role is nothing but a single word (see isSingleWordRole).
export function checkRoleMatchExact(text, role) {
  if (!role || !text) return false;
  if (isSingleWordRole(role)) return false;

  const tNorm = normalizeStr(text);
  const rNorm = normalizeStr(role);
  // A whitespace-only role normalizes to '' (normalizeStr strips whitespace),
  // and String.prototype.includes('') is always true — without this guard a
  // blank role would "exactly" match any text at all, bypassing corroboration
  // entirely. isSingleWordRole doesn't catch this: splitting a whitespace-only
  // string on separators yields zero parts, not one.
  if (!rNorm) return false;
  if (tNorm.includes(rNorm)) return true;

  // Handle Chinese role titles ignoring symbols
  const cleanRole = role.replace(/[\s_\\/()-]+/g, '');
  if (cleanRole.length > 2 && tNorm.includes(cleanRole.toLowerCase())) return true;

  return false;
}

// Latin-script routing gate for the whole-word boundary rule below (#3455,
// #3535). Deliberately includes \p{N} (digits inside titles like "Web3",
// "K8s" must not fall through to the substring path just for carrying a
// digit) and \p{M} (combining marks: NFD-decomposed accented text — "e" +
// combining acute — carries the mark as a separate codepoint in the ORIGINAL
// string, not just something toLowerCase() can introduce, e.g. Turkish
// "İ" -> "i" + U+0307). A part is routed to the boundary-matching branch only
// when it is ENTIRELY Latin+digit+mark — a mixed Latin+Han part like
// "python开发工程师" fails this (correctly): it is one semantic phrase, not a
// Latin word, and keeps the original substring behavior.
const LATIN_WORD_RE = /^[\p{Script=Latin}\p{N}\p{M}]+$/u;

// matchesOnWordBoundary (above) builds `new RegExp(..., 'iu')`, and V8
// stack-overflows constructing a case-insensitive Unicode pattern around a
// long enough literal — it THROWS at construction. checkCompanyMatch's call
// site is gated by isShortName and can never reach that; a role part has no
// such ceiling (a JD pasted into a tracker's role field, a merged CSV column),
// so cap it and fall back to a plain substring test rather than let the throw
// escape matchCandidates() uncaught and take reply-watch down for the whole run.
const MAX_BOUNDARY_NEEDLE = 128;

/**
 * Whole-word boundary test for a Latin-script needle, reusing the boundary
 * shape matchesOnWordBoundary() established for checkCompanyMatch — but the
 * lookarounds here also exclude \p{M}: a combining mark adjacent to the match
 * means the position is mid-grapheme, not a boundary (#3535). "datá" (data +
 * combining acute) must not match "Data" just because the mark itself is
 * not a letter or digit — \p{L}/\p{N} alone would call that a boundary.
 */
function matchesLatinWordBoundary(text, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'iu').test(text);
}

export function checkRoleMatch(text, role) {
  if (!role || !text) return false;

  if (checkRoleMatchExact(text, role)) return true;

  const tNorm = normalizeStr(text);

  // Sometimes role has extra descriptors, we check if a significant part matches
  // Like "PY01_python开发工程师" vs "python开发工程师". Generic recruiting words
  // (see GENERIC_ROLE_WORDS) are excluded no matter how long they are — a bare
  // "Talent" or "Specialist" match is exactly the false-positive pattern from
  // #2671, not evidence of a real match.
  const roleParts = role.split(/[\s_\\/()-]+/);
  for (const part of roleParts) {
    if (!part) continue;

    // Strip attached punctuation before deciding the script: [\s_\\/()-]+ is
    // what roleParts was split on, so a trailing comma survives onto a part
    // ("Director," from "Senior Director, AI Data") and a trailing ideographic
    // period survives onto a CJK part ("工程师。"). The STRIPPED form is what
    // decides Latin-vs-not — script routing runs BEFORE the length and
    // generic-word gates, not after: "工程师。" strips to "工程师" (3 chars),
    // and gating every script on that length would silently drop three-
    // character Chinese titles (工程师, 设计师) the substring path always
    // matched. Non-Latin parts fall through unchanged to the original
    // raw-part behavior below; only a part whose stripped form is entirely
    // Latin+digit+mark gets the new gates and the boundary match.
    const stripped = part.replace(/[^\p{L}\p{N}\p{M}]+/gu, '');

    if (LATIN_WORD_RE.test(stripped)) {
      // The length and generic-word gates run on the STRIPPED form. "Recruiter,"
      // is not in GENERIC_ROLE_WORDS; "recruiter" is — checking the raw part
      // lets attached punctuation walk a generic word straight past the #2671
      // protection. Likewise "AI!!" stripped to "AI" (2 chars) must not clear
      // a gate meant to admit only words with more than three significant
      // characters.
      if (stripped.length <= 3) continue;
      if (GENERIC_ROLE_WORDS.has(stripped.toLowerCase())) continue;

      if (stripped.length > MAX_BOUNDARY_NEEDLE) {
        // Pathological input (a JD pasted into a role field): building the
        // boundary RegExp around it can stack-overflow at construction, so
        // fall back to the plain substring test that ran before this fix.
        if (tNorm.includes(normalizeStr(stripped))) return true;
        continue;
      }

      // A real word-boundary match: plain substring matching alone matches
      // "Analytic" inside "Analytics", "Data" inside "database", "Web3"
      // inside "Web3D" (#3455) — all false positives that inflate whichever
      // tracker row is already ahead in matchCandidates(). The lookarounds use
      // \p{L}\p{N}\p{M} rather than \b: \b is defined on [A-Za-z0-9_], which
      // is wrong twice over — a CJK ideograph is not \w, so \b would see a
      // boundary INSIDE a Chinese compound word ("data工程师"), and "_" IS \w,
      // so \b would miss a genuine "data_engineer" mention.
      if (matchesLatinWordBoundary(text, stripped)) return true;
      continue;
    }

    // Non-Latin (or punctuation-only) part: unchanged original behavior —
    // gate and match on the RAW part, exactly as before this fix, so CJK,
    // Cyrillic, Arabic, and mixed-script parts keep their substring matching.
    if (part.length > 3 && !GENERIC_ROLE_WORDS.has(part.toLowerCase()) && tNorm.includes(normalizeStr(part))) {
      return true; // partial match on a significant word
    }
  }

  return false;
}

// Shared ATS, job board, and webmail hosts. Mail from one of these identifies a
// vendor, never an employer, so it must never become a candidate domain: every
// message from the host would then score a sender-domain match against whichever
// application happened to mention it.
const SHARED_DOMAINS = [
  'linkedin.com',
  'applytojob.com',
  'greenhouse.io',
  'lever.co',
  'icims.com',
  'myworkday.com',
  'ashbyhq.com',
  'smartrecruiters.com',
  'taleo.net',
  'successfactors.com',
  'gmail.com',
  'outlook.com',
  'yahoo.com',
  'hotmail.com'
];

// Dot-separated labels ending in a letters-only TLD. Rejects the shapes tracker
// prose produces: sentence-final words ("gaps."), bare numerics ("3.34.5."), and
// paths or filenames ("output/cv-2026-06-23.pdf").
const DOMAIN_SHAPE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

// Extensions of the artifacts career-ops writes into tracker notes. Several parse
// as a valid TLD, so shape alone cannot tell a filename from a hostname: "cv.md"
// would otherwise read as a Moldovan domain. Deliberately excludes extensions that
// are common employer TLDs (io, co, ai, sh, me, dev, app).
const FILE_EXTENSIONS = [
  'pdf', 'md', 'doc', 'docx', 'txt', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'csv', 'tsv', 'json', 'yaml', 'yml', 'mjs'
];

function isUsableDomain(domain) {
  if (!DOMAIN_SHAPE.test(domain)) return false;
  if (FILE_EXTENSIONS.includes(domain.slice(domain.lastIndexOf('.') + 1))) return false;
  return !SHARED_DOMAINS.some(shared => domain === shared || domain.endsWith(`.${shared}`));
}

function addDomain(domains, value) {
  const domain = (value || '').toLowerCase();
  if (isUsableDomain(domain)) domains.add(domain);
}

export function getAppDomains(app, followups) {
  const domains = new Set();
  
  // Extract from notes
  if (app.notes) {
    const emails = app.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
    for (const email of emails) {
      addDomain(domains, extractDomain(email));
    }
    // Also look for explicit domains in notes (e.g. "ATS: lever.co")
    const words = app.notes.split(/\s+/);
    for (const w of words) {
      if (w.includes('.') && !w.includes('@')) {
        // Notes are prose, so trim the punctuation wrapping the token rather than
        // deleting every disallowed character: dropping "/" would splice a path
        // like "output/cv-2026-06-23.pdf" into one plausible-looking hostname.
        addDomain(domains, w.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, ''));
      }
    }
  }

  // Followups
  const appFollowups = followups.filter(f => f.appNum === app.num);
  for (const fu of appFollowups) {
    if (fu.contact) {
      addDomain(domains, extractDomain(fu.contact));
    }
    if (fu.notes) {
       const emails = fu.notes.match(/[\w.-]+@[\w.-]+\.\w+/g) || [];
       for (const email of emails) {
         addDomain(domains, extractDomain(email));
       }
    }
  }

  // Add common company domain guess (companyname.com). "?" is the structural
  // marker for a confidential employer, not a name, so there is nothing to guess.
  const cNorm = normalizeStr(app.company);
  if (cNorm && cNorm !== '?') {
    addDomain(domains, `${cNorm}.com`);
    addDomain(domains, `${cNorm}.co`);
    addDomain(domains, `${cNorm}.io`);
  }

  return Array.from(domains);
}

export function matchCandidates(candidates, apps, followups = []) {
  const results = [];
  
  for (const cand of candidates) {
    const textContext = `${cand.from || ''} ${cand.subject || ''} ${cand.body_snippet || ''}`;
    const fromDomain = extractDomain(cand.from);
    
    let bestMatches = [];
    let highestScore = -1;
    
    for (const app of apps) {
      let score = 0;
      let signals = [];
      let companyHint = '';
      let roleHint = '';
      
      const isCompanyMatch = checkCompanyMatch(textContext, app.company);
      if (isCompanyMatch) {
        score += 2;
        signals.push('company-name');
        companyHint = app.company;
      }

      let hasDomainMatch = false;
      if (fromDomain) {
        const appDomains = getAppDomains(app, followups);
        if (appDomains.some(d => fromDomain === d || fromDomain.endsWith(`.${d}`))) {
          hasDomainMatch = true;
          score += 2;
          signals.push('sender-domain');
          companyHint = companyHint || app.company;
        }
      }

      // A role match on the *entire* role title is specific enough to stand on
      // its own. A match on just one "significant word" of the role (e.g. the
      // role split into descriptor parts) is not — those partial matches must be
      // corroborated by a company-name or sender-domain signal, otherwise a
      // generic multi-word title (e.g. "Talent Acquisition Specialist") lets any
      // unrelated email that happens to contain one of those words falsely
      // attribute itself to this application (#2671).
      const isRoleExactMatch = checkRoleMatchExact(textContext, app.role);
      const isRolePartialMatch = !isRoleExactMatch && checkRoleMatch(textContext, app.role);
      const isRoleMatch = isRoleExactMatch || (isRolePartialMatch && (isCompanyMatch || hasDomainMatch));
      if (isRoleMatch) {
        score += 1.5;
        signals.push('role-title');
        roleHint = app.role;
      }

      const postAppKeywords = ['interview', 'offer', 'rejection', '邀您面试', '简历通过', 'next steps', 'update on your application'];
      const strongSignals = ['interview_invite', 'offer', 'rejection'];
      const hasPostAppKeyword = (cand.signal && strongSignals.includes(cand.signal)) 
        || postAppKeywords.some(k => textContext.toLowerCase().includes(k.toLowerCase()));
      
      if (hasPostAppKeyword && (isCompanyMatch || hasDomainMatch)) {
         signals.push('post-application-keyword');
      }

      if (score > 0) {
        let confidence = 'low';
        if ((isCompanyMatch || hasDomainMatch) && isRoleMatch) {
          confidence = 'high';
        } else if ((isCompanyMatch || hasDomainMatch) && hasPostAppKeyword) {
          confidence = 'high';
        } else if (isCompanyMatch || hasDomainMatch) {
          confidence = 'medium';
        } else if (isRoleMatch) {
          confidence = 'low';
        }
        
        const matchInfo = {
          message_id: cand.message_id,
          company_hint: companyHint || app.company,
          role_hint: roleHint || app.role,
          application_num: app.num,
          confidence,
          signals: Array.from(new Set(signals)),
          score
        };
        
        if (score > highestScore) {
          highestScore = score;
          bestMatches = [matchInfo];
        } else if (score === highestScore) {
          bestMatches.push(matchInfo);
        }
      }
    }
    
    if (bestMatches.length === 1) {
      const match = bestMatches[0];
      delete match.score;
      results.push(match);
    } else if (bestMatches.length > 1) {
      // Ambiguous matches
      results.push({
        message_id: cand.message_id,
        company_hint: cand.from,
        role_hint: '',
        application_num: null, // ambiguous
        confidence: 'low',
        signals: ['ambiguous-match'],
      });
    } else {
      // No matches
      results.push({
        message_id: cand.message_id,
        company_hint: fromDomain || cand.from,
        role_hint: '',
        application_num: null,
        confidence: 'low',
        signals: ['no-match']
      });
    }
  }
  
  return results;
}

// Which Gmail label CATEGORY (a key into a user's own config/profile.yml
// `gmail_labels` map, never a raw label id — label ids are per-account) an
// email of this classifyReply() type should be filed under, for a consumer
// that wants to auto-label a classified message. Types absent from this map
// (Need Action, Responded, Noise, Unknown) are deliberately left for manual
// triage rather than auto-filed anywhere.
export const GMAIL_LABEL_CATEGORY_FOR_TYPE = {
  'Account Creation': 'account_creation',
  'Auto-confirmation': 'applications',
  'Interview': 'interviews_followups',
  'Offer': 'interviews_followups',
  'Rejected': 'rejections',
};

export function classifyReply(cand) {
  const subject = cand.subject || '';
  const body = cand.body_snippet || '';
  const text = `${cand.from || ''} ${subject} ${body}`;
  const textLower = text.toLowerCase();
  const signal = cand.signal || '';

  const evidence = [];

  // Define keyword match helper (case-insensitive)
  const check = (keywords) => {
    let found = false;
    for (const kw of keywords) {
      if (textLower.includes(kw.toLowerCase())) {
        evidence.push(kw);
        found = true;
      }
    }
    return found;
  };

  // 0. Account Creation keywords (candidate-portal signup/verification mail —
  // "verify your candidate account", "confirm your identity" OTP codes,
  // password resets, forgotten-username notices, "welcome/thanks for
  // creating account"). Checked FIRST and narrowly: these are transactional
  // account-lifecycle emails from an ATS, not a reply about any specific
  // application, so they must never fall through to Auto-confirmation just
  // because the surrounding text also happens to mention "application".
  const accountCreationKeywords = [
    'verify your candidate account', 'confirm your candidate account', 'activate your candidate account',
    'confirm your identity', 'confirm your email address and complete setup',
    'reset your password for your candidate account', 'forgot your username',
    'thanks for creating account', 'thank you for creating your account', 'welcome / thanks for creating account',
    'your one-time pass code', 'one-time passcode', 'one-time verification code',
  ];
  const isAccountCreation = check(accountCreationKeywords);
  if (isAccountCreation) {
    return {
      type: 'Account Creation',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  // 1. Noise keywords (checked first to separate alerts/leads from actual interviews)
  const noiseKeywords = [
    '邀请投递', '抢面试先机', '近期热招', '立即投递', '热招职位', '订阅职位', '职位推荐', '推荐职位',
    'job alert', 'invitation to apply', 'recommended jobs', 'newsletter', 'marketing digest', 'job recommendation', 'suggested jobs'
  ];

  // 2. Offer keywords — specific phrases only. A bare 'offer' substring is deliberately
  //    excluded: it collides with rejection wording such as 'unable to offer' (see
  //    rejectionKeywords) and would mis-type rejections as offers.
  const offerKeywords = [
    '录取通知书', '录用信', '录用通知', '录用', '薪资确认', '入职协议', '意向书',
    'offer letter', 'employment agreement', 'job offer', 'congratulations on the offer', 'compensation details', 'pleased to offer',
    // Common ATS/recruiter offer-template phrasing researched 2026-09-08
    // (recruitcrm.io template library) alongside the rejection-keyword sweep below.
    'offer you the position', 'you have been offered'
  ];

  // 3. Rejected keywords
  const rejectionKeywords = [
    '很遗憾', '暂不匹配', '不合适', '未能进入下一轮', '感谢您的时间', '未通过', '不再考虑', '决定不推进',
    'unfortunately', 'not a match', 'not matching', 'decided not to proceed', 'will not be moving forward', 'position has been filled', 'role has been closed', 'unable to offer',
    // "not selected for further consideration" is one of the single most common
    // ATS-templated rejection phrases (Ashby, Greenhouse, Workday all use close
    // variants of it) and was missing entirely — a real Kraken/Ashby rejection
    // fell all the way through to 'Unknown' with no signal matched (2026-09-08).
    'not selected for further consideration', 'not selected to move forward', 'not be moving forward with your application', 'pursue other candidates', 'moving forward with other candidates', 'other candidates whose qualifications',
    // Additional common phrases researched 2026-09-08 (status.net / recruitcrm.io
    // rejection-template surveys) to widen coverage beyond the one Kraken phrase
    // that surfaced the original gap.
    'unable to move forward with your application', 'no longer moving forward with hiring', 'not to move forward with your candidacy', 'selected another candidate', 'decided to move forward with another candidate',
    "haven't been selected for the role", 'have not been selected for the role', 'unable to shortlist you', 'reject your application',
    // "move forward with other applicants" (plural "applicants", not "candidate")
    // is a distinct template from the "another candidate" phrase above and was
    // missing entirely — a real Liberty Mutual rejection (2026-09-10) fell
    // through to 'Unknown' and would have sat as 'Applied' indefinitely without
    // a manual catch. Kept broad enough to catch both orderings.
    'move forward with other applicants', 'other applicants whose skills and experience', 'other candidates whose skills and experience'
  ];

  // 4. Auto-confirmation keywords
  const autoKeywords = [
    '自动回复', '收到您的申请', '申请已收到', '投递成功', '确认收到',
    'thank you for applying', 'application received', 'received your application', 'auto-confirmation', 'confirmation of application', 'automatic reply'
  ];

  // 5. Need Action keywords
  const actionKeywords = [
    '补充信息', '提供信息', '完成测评', '在线测评', '笔试题', '做个测试', '截止日期前', '截止时间',
    'complete a form', 'provide information', 'finish an assessment', 'coding challenge', 'online test', 'respond by a deadline', 'pick a time', 'schedule a time', 'book a time',
    'complete assessment', 'take a test', 'assessment', 'coding test', 'deadline', 'fill out', 'complete the form', 'provide details', 'submit info'
  ];

  // 6. Interview keywords
  const interviewKeywords = [
    '邀您面试', '邀约面试', '微信小程序面试', 'AI微信小程序', '面试形式', '面试时间', '面试时长', '安排面试', '预约面试', '首轮面试', '视频面试', '电话面试', '现场面试', '面试邀请', '面试流程', '简历通过',
    'interview invitation', 'schedule an interview', 'scheduling link', 'ai interview', 'video interview', 'phone screen', 'onsite interview', 'final round', 'invite you to interview', 'interview request', 'interview schedule',
    // Common phrases researched 2026-09-08 (recruitcrm.io template library).
    // Safe against the rejection keywords added the same day: e.g. 'unable to
    // move forward with your application' literally contains 'move forward
    // with your application', but Rejection is checked and returns BEFORE
    // Interview ever runs, so a real 'unable to...' rejection is never
    // reachable here — this only fires on the bare positive phrasing.
    'second interview', 'in-person interview', 'move forward with your application'
  ];

  // 7. Responded keywords
  const respondedKeywords = [
    '联系您', '回复您', '想沟通', '想聊聊', '进一步沟通',
    'would like to chat', 'reach out', 'connect with you', 'hiring manager responded'
  ];

  const isNoise = check(noiseKeywords);
  if (isNoise) {
    return {
      type: 'Noise',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  // Rejection is decided before Offer: an explicit rejection signal or rejection
  // wording (e.g. 'unable to offer', or 'we will not be sending an offer letter'
  // which still contains the 'offer letter' phrase) must win even when offer-ish
  // phrasing is present. Deciding Offer first would type such replies as Offer and
  // push a spurious Offer tracker update.
  const hasRejectionKeywords = check(rejectionKeywords);
  const isRejected = signal === 'rejection' || hasRejectionKeywords;
  if (isRejected) {
    if (signal === 'rejection' && !evidence.includes('rejection')) evidence.push('rejection');
    return {
      type: 'Rejected',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Rejected'
    };
  }

  const hasOfferKeywords = check(offerKeywords);
  const isOffer = signal === 'offer' || hasOfferKeywords;
  if (isOffer) {
    if (signal === 'offer' && !evidence.includes('offer')) evidence.push('offer');
    return {
      type: 'Offer',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Offer'
    };
  }

  const isAuto = check(autoKeywords);
  if (isAuto) {
    return {
      type: 'Auto-confirmation',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'none'
    };
  }

  const isAction = check(actionKeywords);
  if (isAction) {
    const hasSchedulingWording = textLower.includes('schedule') || textLower.includes('pick a time') || textLower.includes('book a time') || textLower.includes('book a slot') ||
                                 textLower.includes('choose a time') || textLower.includes('select a time') || textLower.includes('appointment') ||
                                 text.includes('预约') || text.includes('选择时间') || text.includes('选择面试') || text.includes('安排时间');
    return {
      type: 'Need Action',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: hasSchedulingWording ? 'Interview' : 'Responded'
    };
  }

  const hasInterviewKeywords = check(interviewKeywords);
  const isInterview = signal === 'interview_invite' || hasInterviewKeywords;
  if (isInterview) {
    if (signal === 'interview_invite' && !evidence.includes('interview_invite')) evidence.push('interview_invite');
    return {
      type: 'Interview',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Interview'
    };
  }

  const hasRespondedKeywords = check(respondedKeywords);
  const isResponded = signal === 'update' || hasRespondedKeywords;
  if (isResponded) {
    if (signal === 'update' && !evidence.includes('update')) evidence.push('update');
    return {
      type: 'Responded',
      evidence: Array.from(new Set(evidence)),
      suggestedTrackerUpdate: 'Responded'
    };
  }

  const recruitingTerms = [
    'application', 'career', 'job', 'recruiter', 'hiring', 'interview', 'resume',
    '简历', '职位', '招聘', '应聘'
  ];
  const isRecruiting = recruitingTerms.some(term => textLower.includes(term.toLowerCase()));
  if (isRecruiting) {
    return {
      type: 'Unknown',
      evidence: [],
      suggestedTrackerUpdate: 'Needs Review'
    };
  }

  return {
    type: 'Unknown',
    evidence: [],
    suggestedTrackerUpdate: 'Needs Review'
  };
}

