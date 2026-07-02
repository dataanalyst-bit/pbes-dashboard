export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

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

  // ── Get the caller's branch restriction, if any ──
  const user = await check.json();
  const userBranch = user?.app_metadata?.branch || null; // null = sees all branches

  try {
    const base = env.APPS_SCRIPT_URL;
    const sep = base.includes("?") ? "&" : "?";
    const keyParam = env.APPS_SCRIPT_KEY ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY) : "";
    const upstreamUrl = base + sep + "_t=" + Date.now() + keyParam;
    const upstream = await fetch(upstreamUrl, { redirect: "follow" });
    const data = await upstream.json();

    const filtered = userBranch ? filterByBranch(data, userBranch) : data;
    return json(filtered);
  } catch (err) {
    return json({ error: true, message: "Upstream fetch failed: " + err.message }, 502);
  }
}

// ── Filters every dataset in the payload down to one branch ──
function filterByBranch(data, branch) {
  const out = { ...data };

  // Arrays of records with a Branch/branch field
  const arrayKeys = [
    'CARE_DATA','TRACKER','GO_DATA','GRIEVANCE_DATA','ADM_TRENDS','ALL_TEACHER',
    'OBS_DATA','ADMIN_DATA','PUR_DATA','VIG_DATA','HR_RECORDS','OWNER_STATS',
    'COMBINED_ADM','ADM1_DATA','ADM2_DATA','LEAD_DATES'
  ];
  arrayKeys.forEach(k => {
    if (Array.isArray(out[k])) {
      out[k] = out[k].filter(r => (r.Branch || r.branch) === branch);
    }
  });

  // Objects keyed by branch name
  const branchKeyedObjects = ['STUDENTS_BY_BRANCH','LEAD_SUMMARY','MONTH_CONFIG','COMBINED_SUMMARY'];
  branchKeyedObjects.forEach(k => {
    if (out[k] && typeof out[k] === 'object') {
      out[k] = Object.fromEntries(
        Object.entries(out[k]).filter(([key]) => key === branch)
      );
    }
  });

  // OWNER_QUALITY: object keyed by owner name, each value has a .branch field
  if (out.OWNER_QUALITY && typeof out.OWNER_QUALITY === 'object') {
    out.OWNER_QUALITY = Object.fromEntries(
      Object.entries(out.OWNER_QUALITY).filter(([, v]) => v.branch === branch)
    );
  }

  // Recompute the single-number total
  out.TOTAL_STUDENTS = out.STUDENTS_BY_BRANCH?.[branch] || 0;

  return out;
}
