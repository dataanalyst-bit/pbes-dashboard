// functions/api/data.js
// v3 — adds ROLE-BASED ACCESS on top of v2's edge-cache + streaming.
//   Roles (Supabase app_metadata.role):
//     • management / (no role & no branch) → full data, all branches
//     • admin_manager                      → full data (client shows Admin/Vigilance/Purchase/Transport/IT)
//     • hr                                 → full data (client shows HR only; ranking needs ALL branches)
//     • principal (any user with a branch) → branch-filtered DETAIL, but the cross-branch
//       aggregates the Head-to-Head scorecard needs (TRACKER, OBS_DATA, HR_RECORDS,
//       MONTH_CONFIG) are kept full so "all branches" comparison still renders.

const CACHE_TTL_SECONDS = 60; // dashboard data freshness window

export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

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

  // ── 2. Get the dashboard payload: edge cache first, Apps Script second ──
  const cache = caches.default;
  const cacheKey = new Request("https://pbes-dashboard-cache.internal/api/data");

  let upstream = await cache.match(cacheKey);

  if (!upstream) {
    const base = env.APPS_SCRIPT_URL;
    const sep = base.includes("?") ? "&" : "?";
    const keyParam = env.APPS_SCRIPT_KEY
      ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY)
      : "";
    const upstreamUrl = base + sep + "_t=" + Date.now() + keyParam;

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

    upstream = new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=" + CACHE_TTL_SECONDS,
      },
    });
    await cache.put(cacheKey, upstream.clone());
  }

  // ── 3. Full-access roles: stream straight through (no parse) ──
  //   management, admin_manager, hr, and any user WITHOUT a branch get everything.
  //   The browser then applies tab/branch visibility per role.
  const fullAccess =
    !userBranch || role === "admin_manager" || role === "hr" || role === "management";
  if (fullAccess) {
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // ── 4. Branch principals: parse once and filter DETAIL to their branch ──
  //   Cross-branch aggregates needed by the Head-to-Head scorecard stay full.
  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return json({ error: true, message: "Cached payload unreadable: " + err.message }, 502);
  }
  return json(filterByBranch(data, userBranch));
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
