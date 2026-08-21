// functions/api/data.js
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
//   Adding a future section needs ONE entry in ALLOWED_SECTIONS below.
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
const ALLOWED_SECTIONS = { pt1: 1, audit: 1, ptm: 1, civil: 1, syl: 1 };

// Heavier than the main payload and it changes only when marks are entered, so it
// can sit in the edge cache far longer.
const SECTION_TTL_SECONDS = 1800;

// Column headers that carry the campus name, in the order they are looked for.
// The three PT-1 tabs all use "Branch", but this keeps a rename from silently
// disabling the filter and leaking other campuses to a principal.
const BRANCH_HEADERS = ["Branch", "branch", "BRANCH"];

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

  // ── 2. Get the payload: edge cache first, Apps Script second ──
  //   Each section gets its OWN cache key, so the exam payload never overwrites
  //   the main dashboard snapshot (or vice versa).
  const cache = caches.default;
  const cacheKey = new Request(
    "https://pbes-dashboard-cache.internal/api/data" + (section ? "/" + section : "")
  );

  let upstream = bypassCache ? undefined : await cache.match(cacheKey);

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
            "Apps Script returned non-JSON (HTTP " + resp.status + "). " +
            "Check the deployment is the latest version with access = Anyone. " +
            "First bytes: " + head,
        },
        502
      );
    }

    const ttl = section ? SECTION_TTL_SECONDS : CACHE_TTL_SECONDS;
    upstream = new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=" + ttl + ", stale-while-revalidate=3600",
      },
    });
    await cache.put(cacheKey, upstream.clone());
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
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
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
  if (section === "pt1")   return json(filterTablesByBranch(data, userBranch, "PT1_RAW"));
  if (section === "audit") return json(filterTablesByBranch(data, userBranch, "AUDIT_RAW"));
  if (section === "ptm")   return json(filterTablesByBranch(data, userBranch, "PTM_RAW"));
  if (section === "civil") return json(filterTablesByBranch(data, userBranch, "CIVIL_RAW"));
  if (section === "syl")   return json(filterTablesByBranch(data, userBranch, "SYL_RAW"));

  //   Cross-branch aggregates needed by the Head-to-Head scorecard stay full.
  return json(filterByBranch(data, userBranch));
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
    out[key] = {
      ...tab,
      rows: tab.rows.filter((r) => String(r[col] || "").trim() === branch),
    };
  });
  return { ...data, [wrapper]: out };
}

// ── Filters individual-record datasets down to one branch ──
// KEEPS full (needed for the all-branch Head-to-Head comparison):
//   TRACKER (care-call rate), OBS_DATA (observation completion), HR_RECORDS (HR overall),
//   MONTH_CONFIG (working days per branch). These are aggregate/operational, not student PII.
function filterByBranch(data, branch) {
  const out = { ...data };
  const KEEP_FULL = { TRACKER: 1, OBS_DATA: 1, HR_RECORDS: 1 };
  const arrayKeys = [
    "CARE_DATA", "GO_DATA", "GRIEVANCE_DATA", "ADM_TRENDS", "ALL_TEACHER",
    "ADMIN_DATA", "PUR_DATA", "VIG_DATA", "OWNER_STATS",
    "COMBINED_ADM", "ADM1_DATA", "ADM2_DATA", "LEAD_DATES", "AVIS_DATA",
  ];
  arrayKeys.forEach((k) => {
    if (!KEEP_FULL[k] && Array.isArray(out[k])) {
      out[k] = out[k].filter((r) => (r.Branch || r.branch) === branch);
    }
  });
  // Transport & IT are nested objects of arrays — filter each inner array to the branch.
  ["TRANSPORT", "IT_DATA_ALL"].forEach((k) => {
    if (out[k] && typeof out[k] === "object") {
      const nk = {};
      Object.entries(out[k]).forEach(([kk, arr]) => {
        nk[kk] = Array.isArray(arr) ? arr.filter((r) => (r.Branch || r.branch) === branch) : arr;
      });
      out[k] = nk;
    }
  });
  // Branch-keyed objects → keep only this branch (MONTH_CONFIG stays FULL for Head-to-Head).
  const branchKeyedObjects = ["STUDENTS_BY_BRANCH", "LEAD_SUMMARY", "COMBINED_SUMMARY"];
  branchKeyedObjects.forEach((k) => {
    if (out[k] && typeof out[k] === "object") {
      out[k] = Object.fromEntries(Object.entries(out[k]).filter(([key]) => key === branch));
    }
  });
  if (out.OWNER_QUALITY && typeof out.OWNER_QUALITY === "object") {
    out.OWNER_QUALITY = Object.fromEntries(
      Object.entries(out.OWNER_QUALITY).filter(([, v]) => v.branch === branch)
    );
  }
  out.TOTAL_STUDENTS = out.STUDENTS_BY_BRANCH?.[branch] || 0;
  return out;
}
