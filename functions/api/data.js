// functions/api/data.js
// v6 — branch matching is normalised (see sameBranch) and a tab emptied by the
//      filter carries a `_branchFilter` note so the dashboard can explain it.
//      `diag` blocks from Apps Script pass through untouched (they are not
//      {hdr,rows} tables, so the filter leaves them alone).
// v5 — the Exam Analytics section is replaced by the PT-1 / IA-1 Academic Review.
//   ?section=pt1    → the three raw marks/staff/period tabs, cached under their
//                     own edge key and branch-filtered for principals.
//   ?section=audit  → the raw School Audit tab, same treatment.
//   ?section=civil  → the raw Civil work tracker, same treatment.
//   ?section=ptm    → the raw PTM parent-feedback tab, same treatment. Carries
//                     parent names, contacts and verbatim comments, so the
//                     branch filter matters more here than anywhere else.
//                     Unlike ?section=exams this is RAW sheet data: the browser
//                     derives the review, so the filtering here is row-level.
//   ?section=term1  → the raw term-end parent feedback & NPS survey. Carries
//                     parent names, contact numbers and verbatim comments, so
//                     it is branch-filtered row by row like ?section=ptm.
//   Adding a future section needs ONE entry in ALLOWED_SECTIONS below — and, if
//   it carries personal data, one line in step 4 to filter it by branch.
//
// v4 — added LAZY SECTION PASS-THROUGH on top of v3's role-based access.
//
// v3 — ROLE-BASED ACCESS on top of v2's edge-cache + streaming.
//   Roles (Supabase app_metadata.role):
//     • management / (no role & no branch) → full data, all branches
//     • admin_manager                      → full data (client shows Admin/Vigilance/Purchase/Transport/IT)
//     • hr                                 → full data (client shows HR only; ranking needs ALL branches)
//     • principal (any user with a branch) → branch-filtered DETAIL, but the cross-branch
//       aggregates the Head-to-Head scorecard needs (TRACKER, OBS_DATA, HR_RECORDS,
//       MONTH_CONFIG) are kept full so "all branches" comparison still renders.

const CACHE_TTL_SECONDS = 300; // edge freshness window (Apps Script keep-warm keeps upstream fast)

// Sections the browser is allowed to request. Anything else is ignored, so a bad
// or hand-typed ?section= can never be used to probe the upstream script.
// 22 Oct 2026 — `meet` and `term1` were missing from this list.
// Anything not named here has its ?section= stripped a few lines down, and the
// Function then quietly fetches and returns the MAIN payload instead. The
// caller gets a valid 200 with the wrong body, so the failure looks like "no
// data in the sheet" rather than a routing fault:
//   • term1 — the Term 1 Feedback tab reported "No responses returned", because
//     the main payload carries no TERM1_RAW.
//   • meet  — meetLoadShared() looks for MEET_RAW.text, found none, and fell
//     back to its built-in seed transcript. Every transcript uploaded through
//     /api/meet since has been stored and never read back.
// `dm` is listed too: it already has a TTL override and a branch-filter branch
// below, so leaving it out was the same oversight. Adding a future section is
// still one entry here — plus one line in step 4 if it carries personal data.
const ALLOWED_SECTIONS = {
  pt1: 1, audit: 1, ptm: 1, civil: 1, syl: 1, vchk: 1, kptm: 1, sylc: 1,
  term1: 1, meet: 1, dm: 1, naa: 1, bio: 1, adm27: 1
};

// Heavier than the main payload and most sections change only when marks are
// entered, so they can sit in the edge cache far longer. The syllabus/notebook
// ledger is the exception: floor incharges enter checks through the day, so a
// 30-minute edge copy hides the morning's work until lunchtime.
const SECTION_TTL_SECONDS = 1800;
// meet changes the instant somebody uploads a transcript, and every other user
// needs that on their next load rather than half an hour later.
/* The biometric sheets are replaced once a month, so a long edge copy is right
   — but a short one the day they are pasted in matters more than saving a
   fetch, hence the same 5 minutes the audit uses. */
/* dm is a 1.3 MB payload rebuilt from six tabs that are replaced once a month,
   so a two-minute edge copy was costing a full rebuild for no freshness. */
/* The 2027-28 enquiry tracker is worked all day by counsellors, so a long
   edge copy would show a principal this morning's pipeline at four o'clock. */
const SECTION_TTL_OVERRIDE = { syl: 120, sylc: 120, meet: 30, dm: 900, naa: 300, bio: 300, adm27: 120 };

// Column headers that carry the campus name, in the order they are looked for.
// The three PT-1 tabs all use "Branch", but this keeps a rename from silently
// disabling the filter and leaking other campuses to a principal.
const BRANCH_HEADERS = ["Branch", "branch", "BRANCH", "Campus", "campus", "Branch Name", "branchName"];

// Branch values are compared loosely: "bachupally", "Bachupally ", "BACHUPALLY"
// and "Bachupally Branch" all belong to Bachupally. The five campus names are
// distinct words, so a normalised contains-match cannot cross campuses. Exact
// string equality was silently emptying the syllabus/notebook feed for
// principals whenever the ledger spelled the branch differently from Supabase.
function normBranch(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
}
function sameBranch(cell, branch) {
  const a = normBranch(cell), b = normBranch(branch);
  if (!a || !b) return false;
  return a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1;
}

// ── Photo pass ──
// An <img> tag cannot carry an Authorization header, so /api/photo cannot be
// protected the way this endpoint is. Instead, once a caller has been
// authenticated here, they are issued a short-lived signed cookie; /api/photo
// accepts that cookie and nothing else. The cookie is HttpOnly, so page script
// (or anything injected into it) cannot read it, and it carries the branch so a
// principal cannot pull another campus's photographs.
export const PHOTO_COOKIE = "pbes_ph";
const PHOTO_TTL_SECONDS = 3600;

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function signPhotoToken(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}
export async function verifyPhotoToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body] = token.split(".");
  const expect = await signPhotoToken(
    JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))), secret);
  // constant-length compare is enough here; the tokens are the same length
  if (expect !== token) return null;
  let claims;
  try { claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))); }
  catch { return null; }
  if (!claims || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

/* The configured Apps Script URL with its query string removed, so a failure
   message can name the endpoint it called without printing the shared key into
   a browser. The deployment id is the part that actually needs comparing. */
function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.origin + x.pathname;
  } catch (err) {
    return "(APPS_SCRIPT_URL is not a valid URL: " + String(u).slice(0, 60) + ")";
  }
}

export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  // ── 0. Which payload is being asked for? ──
  const reqUrl = new URL(request.url);
  const rawSection = (reqUrl.searchParams.get("section") || "").trim().toLowerCase();
  const section = ALLOWED_SECTIONS[rawSection] ? rawSection : "";
  // The dashboard's ↻ Refresh sends nocache=1. Without honouring it here, the edge
  // cache would keep serving the old snapshot for its whole TTL and "Refresh" would
  // appear to do nothing after a redeploy.
  const bypassCache = reqUrl.searchParams.get("nocache") === "1";
  // ?fresh=1 skips only the EDGE copy and reads Apps Script's own cache. The
  // dashboard sends it right after a Refresh that outran its timeout: the
  // rebuild keeps running in Apps Script and stores its result there, and this
  // picks it up instead of being handed the edge's older copy or starting a
  // second rebuild.
  const freshOnly = reqUrl.searchParams.get("fresh") === "1";

  // ── 1. Authenticate the caller against Supabase ──
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: true, message: "Not authenticated" }, 401);

  let check;
  try {
    check = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
  } catch (err) {
    return json({ error: true, message: "Auth check failed: " + err.message }, 502);
  }
  if (!check.ok) return json({ error: true, message: "Invalid or expired session" }, 401);

  const user = await check.json();
  const role = (user?.app_metadata?.role || "").toLowerCase().trim();
  const userBranch = user?.app_metadata?.branch || null;

  // ── 1a. A section this deployment does not serve ──
  // A caller that names a section this deployment does not know used to be
  // handed the MAIN dashboard payload with a 200, because an unknown name was
  // quietly mapped to "". The tab that asked then received a valid response
  // with none of its data in it and could only report "no rows" — which reads
  // as a problem with the spreadsheet when the real cause is that this file is
  // older than the dashboard calling it. Saying no plainly costs nothing and
  // names the fix. An absent section parameter still means the main payload.
  // Checked after authentication: the reply names the sections this build
  // serves, which is for the signed-in operator, not for anonymous callers.
  if (rawSection && !ALLOWED_SECTIONS[rawSection]) {
    return json({
      error: true,
      message: 'This deployment of /api/data does not know the section "' + rawSection +
        '". It serves: ' + Object.keys(ALLOWED_SECTIONS).join(", ") +
        '. Add it to ALLOWED_SECTIONS in functions/api/data.js and redeploy Pages.',
      section: rawSection,
      allowed: Object.keys(ALLOWED_SECTIONS),
    }, 400);
  }

  // Mint the photo cookie for this caller. Failure here is not fatal: the rest
  // of the dashboard works, only the vigilance photographs would not load.
  let photoCookie = null;
  try {
  // The signing secret. PHOTO_SECRET if it has been set, otherwise
  // APPS_SCRIPT_KEY, otherwise the Supabase anon key — which is always
  // configured, or nothing on this dashboard would load at all. Without this
  // last fallback the cookie was never issued on deployments that carry the
  // Apps Script key inside APPS_SCRIPT_URL rather than as its own variable,
  // and every photograph failed with no visible reason.
    const secret = env.PHOTO_SECRET || env.APPS_SCRIPT_KEY || env.SUPABASE_ANON_KEY;
    if (secret) {
      const token = await signPhotoToken({
        sub: user?.id || "", branch: userBranch || "", role,
        exp: Math.floor(Date.now() / 1000) + PHOTO_TTL_SECONDS,
      }, secret);
      photoCookie = PHOTO_COOKIE + "=" + token + "; Path=/api/photo; Max-Age=" +
        PHOTO_TTL_SECONDS + "; HttpOnly; Secure; SameSite=Strict";
    }
  } catch (err) { /* photographs will simply not load */ }
  const withCookie = (resp) => {
    if (photoCookie) resp.headers.append("Set-Cookie", photoCookie);
    return resp;
  };

  // ── 2. Get the payload: edge cache first, Apps Script second ──
  //   Each section gets its OWN cache key, so the exam payload never overwrites
  //   the main dashboard snapshot (or vice versa).
  const cache = caches.default;
  const cacheKey = new Request(
    "https://pbes-dashboard-cache.internal/api/data" + (section ? "/" + section : "")
  );

  let upstream = (bypassCache || freshOnly) ? undefined : await cache.match(cacheKey);

  if (!upstream) {
    const base = env.APPS_SCRIPT_URL;
    const sep = base.includes("?") ? "&" : "?";
    const keyParam = env.APPS_SCRIPT_KEY
      ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY)
      : "";
    // ← the line that was missing: pass the section through to Apps Script
    const sectionParam = section ? "&section=" + encodeURIComponent(section) : "";
    // Also rebuild the Apps Script side, not just the edge copy.
    const bustParam = bypassCache ? "&nocache=1" : "";
    const upstreamUrl =
      base + sep + "_t=" + Date.now() + keyParam + sectionParam + bustParam;

    let resp;
    try {
      resp = await fetch(upstreamUrl, { redirect: "follow" });
    } catch (err) {
      return json({ error: true, message: "Upstream fetch failed: " + err.message }, 502);
    }

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!resp.ok || ct.indexOf("json") === -1) {
      const head = (await resp.text()).slice(0, 180).replace(/</g, "‹");
      return json(
        {
          error: true,
          message:
            "Apps Script returned non-JSON (HTTP " + resp.status + ")" +
            (section ? " for ?section=" + section : " for the main payload") + ". " +
            (resp.status === 404
              ? "A 404 means the deployment id in APPS_SCRIPT_URL does not exist. " +
                "This Function is calling: " + safeUrl(base) + " \u2014 compare the id in that URL " +
                "against Deploy \u2192 Manage deployments in Apps Script. If they differ, paste the " +
                "current /exec URL into the APPS_SCRIPT_URL variable in Cloudflare Pages and REDEPLOY " +
                "the Pages project (an environment variable change does not take effect until you do). " +
                "If they match, the deployment was deleted \u2014 edit the existing deployment and " +
                "publish a New version rather than creating a new deployment."
              : resp.status === 401 || resp.status === 403
              ? "Apps Script refused the request. The deployment's access must be \"Anyone\", not " +
                "\"Anyone with a Google account\" \u2014 this Function calls it without a signed-in user."
              : "Check the deployment is the latest version with access = Anyone.") +
            " First bytes: " + head,
        },
        502
      );
    }

    const ttl = section
      ? (SECTION_TTL_OVERRIDE[section] || SECTION_TTL_SECONDS)
      : CACHE_TTL_SECONDS;
    upstream = new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=" + ttl + ", stale-while-revalidate=3600",
      },
    });
    await cache.put(cacheKey, upstream.clone());
  }

  // ── 2b. The non-academic audit has its own access rule ──
  //   It is read by more roles than any other section, and two of them do not
  //   fit the global rule a few lines below, so it is decided here rather than
  //   by accident:
  //
  //     all branches  — management, auditor, admin_manager (senior admin
  //                     manager), vigilance_officer, and anyone with no branch
  //                     on their account.
  //     own branch    — principal, admin, hr, coordinator and the three
  //                     grievance roles. The remarks column names individual
  //                     staff, drivers, ayahs and vendors, so one campus's
  //                     observations are not another campus's reading.
  //
  //   The two that do not fit the global rule:
  //
  //   `hr` is waved through unfiltered for every other section, because the HR
  //   Analytics tab ranks recruitment across branches and collapses to one row
  //   without it. That exception must NOT extend to this audit: a branch HR
  //   user would otherwise receive all five campuses' observations. Deciding
  //   naa before that shortcut is what keeps HR branch-scoped here only.
  //
  //   `vigilance_officer` and `auditor` are group-wide roles that the rest of
  //   this file expresses by leaving the branch blank. If such an account does
  //   carry a branch, the global rule would filter it. Naming them here means
  //   they get every campus for this audit either way, without widening their
  //   access to the sections that carry parent contact numbers and student
  //   marks.
  const NAA_ALL_BRANCH = { management: 1, auditor: 1, admin_manager: 1, vigilance_officer: 1 };
  if (section === "naa") {
    if (!userBranch || NAA_ALL_BRANCH[role]) {
      return withCookie(new Response(upstream.body, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }));
    }
    let naaData;
    try {
      naaData = await upstream.json();
    } catch (err) {
      return json({ error: true, message: "Cached payload unreadable: " + err.message }, 502);
    }
    /* The document register inside the same payload carries no Branch column
       and is passed through whole: it is the list of records every campus is
       expected to hold, not a record of any one campus. */
    return withCookie(json(filterTablesByBranch(naaData, userBranch, "NAA_RAW")));
  }

  /* ── 2c. The biometric report has its own access rule ──
     Group-wide: management, auditor and the senior admin manager. Everyone
     else carrying a branch sees their own campus only — `hr` included, which
     is why this sits ABOVE the full-access passthrough: branch HR is sent the
     whole payload for HR Analytics, and that must not also hand them every
     campus's punch records. */
  const BIO_ALL_BRANCH = { management: 1, auditor: 1, admin_manager: 1 };
  if (section === "bio") {
    if (!userBranch || BIO_ALL_BRANCH[role]) {
      return withCookie(new Response(upstream.body, {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      }));
    }
    let bioData;
    try {
      bioData = await upstream.json();
    } catch (err) {
      return json({ error: true, message: "Cached payload unreadable: " + err.message }, 502);
    }
    return withCookie(json(filterBioByBranch(bioData, userBranch)));
  }

  // ── 3. Full-access roles: stream straight through (no parse) ──
//   Anyone WITHOUT a branch on their account gets the whole payload: that is how
//   the group-wide roles are expressed (management, auditor, admin_manager,
//   vigilance_officer). Everyone else is filtered to their own campus BELOW —
//   and that filtering is the real security boundary. Hiding a tab in the
//   browser only tidies the menu; it does not keep data out of the page.
//
//   Branch-scoped roles, all filtered: branch_admin, grievance_officer,
//   hr_grievance, principal, and any unrecognised role carrying a branch.
//
//   `hr` is the one deliberate exception. The HR Analytics tab ranks recruitment
//   performance ACROSS branches, so a branch HR user is sent the full payload and
//   the browser pins their branch filter. If you would rather branch HR saw only
//   their own campus, delete `role === "hr" ||` from the line below — their tab
//   still works, but the cross-branch ranking collapses to a single row.
  const fullAccess =
    !userBranch || role === "admin_manager" || role === "hr" || role === "management";
  if (fullAccess) {
    return withCookie(new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }));
  }

  // ── 4. Branch principals: parse once and filter DETAIL to their branch ──
  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return json({ error: true, message: "Cached payload unreadable: " + err.message }, 502);
  }

  // The review carries student-level marks and named staff, so other campuses are
  // stripped server-side rather than relying on the browser to hide them.
  if (section === "pt1")   return withCookie(json(filterTablesByBranch(data, userBranch, "PT1_RAW")));
  if (section === "audit") return withCookie(json(filterTablesByBranch(data, userBranch, "AUDIT_RAW")));
  if (section === "ptm")   return withCookie(json(filterTablesByBranch(data, userBranch, "PTM_RAW")));
  if (section === "civil") return withCookie(json(filterTablesByBranch(data, userBranch, "CIVIL_RAW")));
  if (section === "syl")   return withCookie(json(filterTablesByBranch(data, userBranch, "SYL_RAW")));
  if (section === "vchk")  return withCookie(json(filterTablesByBranch(data, userBranch, "VCHK_RAW")));
  if (section === "kptm")  return withCookie(json(filterTablesByBranch(data, userBranch, "KPTM_RAW")));
  if (section === "sylc")  return withCookie(json(filterTablesByBranch(data, userBranch, "SYLC_RAW")));
  /* naa is decided in step 2b above, before the full-access shortcut. */
  /* The term-end survey is the most sensitive raw feed on the dashboard: it
     carries parent names, student names, verbatim complaints AND the contact
     number of every parent who asked to be rung. A principal must receive only
     their own campus's rows, so this filter is not optional. */
  if (section === "term1") return withCookie(json(filterTablesByBranch(data, userBranch, "TERM1_RAW")));
  // The meeting transcript is one group-wide document with no branch column;
  // filtering it by branch would blank it for every principal.
  if (section === "meet")  return withCookie(json(data));
  /* Admissions 2027-28 carries every enquiring parent's name and phone
     number, plus nine thousand historic students. A principal gets their own
     campus and nothing else, and the year grids are recomputed from what is
     left rather than sent whole — a grid built over all five branches would
     hand back the totals the row filter just removed. */
  if (section === "adm27") return withCookie(json(filterAdm27ByBranch(data, userBranch)));
  // Digital marketing: a record belongs to the campus its ads were run FOR,
  // which is not always the account that paid — a Boduppal account runs
  // Bachupally hiring ads. servedList is what the builder resolved, so filter on
  // that rather than on the ad account.
  if (section === "dm") {
    const dm = data && data.DM_RAW;
    if (!dm || !Array.isArray(dm.scorecard)) return withCookie(json(data));
    return withCookie(json({ ...data, DM_RAW: filterDmByBranch(dm, userBranch) }));
  }

  //   Cross-branch aggregates needed by the Head-to-Head scorecard stay full.
  return withCookie(json(filterByBranch(data, userBranch)));
}

// ── Raw section payloads: keep only this branch's rows in every tab ──
// Shape: { <WRAPPER>: { generatedAt, <tabName>:{hdr,rows}, … } }
//
// This is raw sheet data, so the filter is a row-level one: find the Branch
// column by header and drop every row belonging to another campus. A tab with
// no Branch column is passed through untouched rather than blanked, so a future
// lookup tab cannot silently disappear for principals.
//
// Note the review still renders correctly on a single branch: its comparisons
// fall back to within-branch ones when there is nothing to compare against.
/* ── the biometric payload's own branch filter ──────────────────────────────
   BIO_RAW is not a table of rows with a Branch column, so filterTablesByBranch
   cannot touch it: it is a staff dictionary plus an array of punch records that
   point into it by index. Those records carry names and arrival times, so a
   branch-scoped user must never receive another campus's copy — the tab being
   hidden in the browser is not a boundary.

   What IS passed through whole is the calendar: how many staff across the group
   punched on each date, and whether that made it a working day. Those are
   counts with no names in them, and the working-day verdict is sounder computed
   over the whole group than over eighteen people at one campus. */
/* ── the Digital Marketing payload's own branch filter ─────────────────────
   This tab is a cross-branch comparison, and today only the group-wide roles
   can open it — so in practice this never runs. It is written properly anyway,
   because the day someone adds 'dm' to a principal's tab list, the difference
   between "the filter was never needed" and "the filter does not exist" is
   every other campus's ad spend and post captions arriving in their browser.

   Every array in the payload is either keyed by a branch field or is a global
   lookup. The branch-keyed ones are filtered; the model's topics, drivers and
   the hour-of-day curve are group-level shapes with no branch in them and are
   passed through. */
const DM_BRANCH_KEYS = {
  Branch: 1, branch: 1,          // Google blocks use Branch, organic/Meta use branch
};
function filterDmByBranch(dm, branch) {
  const keepRow = (r) => {
    if (!r || typeof r !== "object") return true;
    for (const k in DM_BRANCH_KEYS) {
      if (Object.prototype.hasOwnProperty.call(r, k)) return sameBranch(r[k], branch);
    }
    return true;                 // no branch field: a group-level row, keep it
  };
  const out = {};
  for (const k of Object.keys(dm)) {
    const v = dm[k];
    out[k] = Array.isArray(v) ? v.filter(keepRow) : v;
  }
  /* branch_terms is keyed BY branch rather than carrying one */
  if (dm.branch_terms && typeof dm.branch_terms === "object") {
    const bt = {};
    for (const b of Object.keys(dm.branch_terms)) {
      if (sameBranch(b, branch)) bt[b] = dm.branch_terms[b];
    }
    out.branch_terms = bt;
  }
  return out;
}

function filterBioByBranch(data, branch) {
  const R = data && data.BIO_RAW;
  if (!R || !Array.isArray(R.staff) || !Array.isArray(R.recs)) return data;
  const bi = (R.branches || []).indexOf(branch);

  /* A campus with no biometric sheet in the workbook yet gets a well-formed
     empty payload, so the tab says "no records" instead of failing. */
  if (bi < 0) {
    return Object.assign({}, data, { BIO_RAW: Object.assign({}, R, {
      branches: [], staff: [], recs: [], codes: [], cohorts: [], overrides: []
    }) });
  }

  const map = new Map();
  const staff = [];
  R.staff.forEach((p, i) => {
    if (p && p.b === bi) { map.set(i, staff.length); staff.push(Object.assign({}, p, { b: 0 })); }
  });
  const recs = [];
  R.recs.forEach((r) => {
    if (!Array.isArray(r)) return;
    const j = map.get(r[0]);
    if (j === undefined) return;
    const c = r.slice();
    c[0] = j;
    recs.push(c);
  });
  const own = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && x.branch === branch) : []);

  return Object.assign({}, data, { BIO_RAW: Object.assign({}, R, {
    branches: [branch], staff: staff, recs: recs,
    codes: own(R.codes), cohorts: own(R.cohorts), overrides: own(R.overrides)
  }) });
}

function filterAdm27ByBranch(data, branch) {
  const R = data && data.ADM27_RAW;
  if (!R) return data;
  const own = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && x.b === branch) : []);
  const enq = own(R.enq), hist = own(R.hist), trend = own(R.trend);

  /* The grids are aggregates over every branch, so they are rebuilt here from
     the rows this user may see. Shipping the originals would leak the group
     totals through a chart even with the detail rows stripped. */
  const MONTHS = Array.isArray(R.months) ? R.months
    : ["APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC","JAN","FEB","MAR"];
  const grid = {}, clsN = {}, monN = {}, ays = {};
  hist.forEach((r) => {
    ays[r.ay] = 1;
    const g = r.ay + "\u0000" + r.b;       grid[g] = (grid[g] || 0) + 1;
    const c = r.ay + "\u0000" + r.cls;     clsN[c] = (clsN[c] || 0) + 1;
    if (r.d) {
      const mo = MONTHS[(parseInt(r.d.slice(5, 7), 10) + 8) % 12];
      const k = r.ay + "\u0000" + mo;      monN[k] = (monN[k] || 0) + 1;
    }
  });

  const tabs = Array.isArray(R.tabs)
    ? R.tabs.filter((t) => !t || !t.branch || t.branch === branch) : [];

  return Object.assign({}, data, { ADM27_RAW: Object.assign({}, R, {
    branches: [branch],
    histBranches: Object.keys(ays).length ? [branch] : [],
    histAys: Object.keys(ays).sort(),
    targets:     { [branch]: (R.targets || {})[branch] },
    leadTargets: { [branch]: (R.leadTargets || {})[branch] },
    plan:        { [branch]: (R.plan || {})[branch] },
    enq, hist, trend, tabs,
    histGrid: grid, histClass: clsN, histMonth: monN,
    quality: Object.assign({}, R.quality || {}, {
      total: enq.length,
      dups:        enq.filter((r) => r.dup).length,
      crossBranch: enq.filter((r) => r.xbr).length,
      ranges:      enq.filter((r) => r.rng).length,
      unreadable:  enq.filter((r) => r.cur === "(unreadable)").length,
      /* The cleanup worklist is a to-do list, so a principal must be given
         their own campus's counts rather than the group's. */
      drop:        enq.filter((r) => r.verdict === "drop").length,
      decide:      enq.filter((r) => r.verdict === "decide").length,
      fix:         enq.filter((r) => r.verdict === "fix").length,
      junk:        enq.filter((r) => (r.fl || []).some((f) => f[0] === "junk")).length,
      badPhone:    enq.filter((r) => (r.fl || []).some((f) => f[0] === "phone")).length,
      siblings:    enq.filter((r) => r.same === "sib").length,
      dupChild:    enq.filter((r) => r.same === "dup").length,
      dupUnknown:  enq.filter((r) => r.same === "unknown").length,
      noName:      enq.filter((r) => !r.name).length,
      badClass:    enq.filter((r) => (r.fl || []).some((f) => f[0] === "class")).length,
      phoneInName: enq.filter((r) => (r.fl || []).some((f) => f[0] === "inname")).length,
      tests:       enq.filter((r) => r.test).length,
      blankType:   enq.filter((r) => !r.typ).length,
      blankCur:    enq.filter((r) => !r.cur).length,
      blankClass:  enq.filter((r) => r.cls === "(not recorded)").length,
      blankDate:   enq.filter((r) => !r.d).length,
    }),
  }) });
}

function filterTablesByBranch(data, branch, wrapper) {
  const src = data && data[wrapper];
  if (!src) return data;

  const out = {};
  Object.keys(src).forEach((key) => {
    const tab = src[key];
    if (!tab || !Array.isArray(tab.hdr) || !Array.isArray(tab.rows)) {
      out[key] = tab;               // generatedAt and anything else scalar
      return;
    }
    let col = -1;
    for (const name of BRANCH_HEADERS) {
      col = tab.hdr.indexOf(name);
      if (col >= 0) break;
    }
    if (col < 0) { out[key] = tab; return; }
    const rows = tab.rows.filter((r) => sameBranch(r[col], branch));
    out[key] = { ...tab, rows };
    // Say so when the filter removed everything: the tab then shows this
    // instead of a bare "no rows", and the fix (branch spelling) is obvious.
    if (tab.rows.length && !rows.length) {
      const seen = {};
      tab.rows.forEach((r) => { const v = String(r[col] == null ? "" : r[col]).trim() || "(blank)"; seen[v] = 1; });
      out[key]._branchFilter = {
        branch, before: tab.rows.length, after: 0,
        valuesInSheet: Object.keys(seen).slice(0, 12),
        note: "No row in this tab matched the branch on your account (" + branch + ").",
      };
    }
  });
  return { ...data, [wrapper]: out };
}

// ── Filters individual-record datasets down to one branch ──
// KEEPS full (needed for the all-branch Head-to-Head comparison):
//   TRACKER (care-call rate), OBS_DATA (observation completion), HR_RECORDS (HR overall),
//   MONTH_CONFIG (working days per branch). These are aggregate/operational, not student PII.
function filterByBranch(data, branch) {
  const out = { ...data };
  // SCORE_SLIM is deliberately kept whole: it carries no names and no free text,
  // only the statuses and dates the head-to-head scorecard needs, so every
  // branch can be compared without any campus seeing another's detail.
  const KEEP_FULL = { TRACKER: 1, OBS_DATA: 1, HR_RECORDS: 1, SCORE_SLIM: 1 };
  const arrayKeys = [
    // CARE_CLASS used to be counts only and streamed whole. It now carries the
    // NAMES of the students still to be called, so it is filtered like every
    // other student-level feed.
    "CARE_DATA", "CARE_CLASS", "GO_DATA", "GRIEVANCE_DATA", "ADM_TRENDS", "ALL_TEACHER",
    "ADMIN_DATA", "PUR_DATA", "VIG_DATA", "OWNER_STATS",
    "COMBINED_ADM", "ADM1_DATA", "ADM2_DATA", "LEAD_DATES", "AVIS_DATA",
    "ADMP_DATA",
  ];
  /* The observation log: a branch account sees its own branch's entries plus
     anything filed by a group-wide account (which carries no branch), since
     those are usually instructions that concern them. It does not see other
     branches' internal notes. */
  if (Array.isArray(out.OBS_LOG)) {
    out.OBS_LOG = out.OBS_LOG.filter((r) => !r.branch || sameBranch(r.branch, branch));
  }

  // Digital marketing is filtered on the campus the ads were run FOR, not the
  // account that paid — a Boduppal account runs Bachupally hiring ads.
  if (Array.isArray(out.DM_DATA)) {
    out.DM_DATA = out.DM_DATA.filter((r) => {
      const list = Array.isArray(r.servedList) ? r.servedList : [r.served];
      return list.some((b) => sameBranch(b, branch));
    });
  }
  arrayKeys.forEach((k) => {
    if (!KEEP_FULL[k] && Array.isArray(out[k])) {
      out[k] = out[k].filter((r) => sameBranch(r.Branch || r.branch, branch));
    }
  });
  // Transport & IT are nested objects of arrays — filter each inner array to the branch.
  ["TRANSPORT", "IT_DATA_ALL"].forEach((k) => {
    if (out[k] && typeof out[k] === "object") {
      const nk = {};
      Object.entries(out[k]).forEach(([kk, arr]) => {
        nk[kk] = Array.isArray(arr) ? arr.filter((r) => sameBranch(r.Branch || r.branch, branch)) : arr;
      });
      out[k] = nk;
    }
  });
  // Branch-keyed objects → keep only this branch (MONTH_CONFIG stays FULL for Head-to-Head).
  const branchKeyedObjects = ["STUDENTS_BY_BRANCH", "LEAD_SUMMARY", "COMBINED_SUMMARY"];
  branchKeyedObjects.forEach((k) => {
    if (out[k] && typeof out[k] === "object") {
      out[k] = Object.fromEntries(Object.entries(out[k]).filter(([key]) => sameBranch(key, branch)));
    }
  });
  if (out.OWNER_QUALITY && typeof out.OWNER_QUALITY === "object") {
    out.OWNER_QUALITY = Object.fromEntries(
      Object.entries(out.OWNER_QUALITY).filter(([, v]) => sameBranch(v.branch, branch))
    );
  }
  out.TOTAL_STUDENTS = Object.values(out.STUDENTS_BY_BRANCH || {})[0] || 0;
  return out;
}
