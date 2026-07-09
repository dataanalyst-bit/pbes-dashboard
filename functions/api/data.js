// functions/api/data.js
// v2 — fixes intermittent 503 / "Unexpected token '<'" errors.
// Key changes vs v1:
//   1. Edge-caches the Apps Script JSON for 60s  → one upstream call serves everyone
//   2. Management users (no branch restriction) get a STREAMED pass-through
//      → the Worker never parses the multi-MB payload → no CPU/memory blowups
//   3. Branch principals still get server-side filtering (small user group)
//   4. Non-JSON upstream responses return a clean JSON error instead of crashing

const CACHE_TTL_SECONDS = 60; // das hboard data freshness window

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
  const userBranch = user?.app_metadata?.branch || null; // null = management, sees all

  // ── 2. Get the dashboard payload: edge cache first, Apps Script second ──
  // Cache key is constant: the cached object is the FULL dataset; branch
  // filtering happens after the cache, and only authenticated users reach here.
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

    // Guard: Apps Script must answer with JSON. If Google returns an HTML
    // page (wrong access setting, quota page, sign-in page), say so clearly
    // instead of letting the browser choke on "Unexpected token '<'".
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

    // Store in the edge cache for CACHE_TTL_SECONDS
    upstream = new Response(resp.body, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "s-maxage=" + CACHE_TTL_SECONDS,
      },
    });
    await cache.put(cacheKey, upstream.clone());
  }

  // ── 3. Management (no branch restriction): stream straight through ──
  // No .json(), no JSON.stringify — the Worker just pipes bytes. This is the
  // fix for the 503s: the multi-MB payload is never parsed in the Worker.
  if (!userBranch) {
    return new Response(upstream.body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // ── 4. Branch principals: parse once and filter ──
  let data;
  try {
    data = await upstream.json();
  } catch (err) {
    return json({ error: true, message: "Cached payload unreadable: " + err.message }, 502);
  }
  return json(filterByBranch(data, userBranch));
}

// ── Filters every dataset in the payload down to one branch ──
function filterByBranch(data, branch) {
  const out = { ...data };
  const arrayKeys = [
    "CARE_DATA", "TRACKER", "GO_DATA", "GRIEVANCE_DATA", "ADM_TRENDS", "ALL_TEACHER",
    "OBS_DATA", "ADMIN_DATA", "PUR_DATA", "VIG_DATA", "HR_RECORDS", "OWNER_STATS",
    "COMBINED_ADM", "ADM1_DATA", "ADM2_DATA", "LEAD_DATES",
  ];
  arrayKeys.forEach((k) => {
    if (Array.isArray(out[k])) {
      out[k] = out[k].filter((r) => (r.Branch || r.branch) === branch);
    }
  });
  const branchKeyedObjects = ["STUDENTS_BY_BRANCH", "LEAD_SUMMARY", "MONTH_CONFIG", "COMBINED_SUMMARY"];
  branchKeyedObjects.forEach((k) => {
    if (out[k] && typeof out[k] === "object") {
      out[k] = Object.fromEntries(
        Object.entries(out[k]).filter(([key]) => key === branch)
      );
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
