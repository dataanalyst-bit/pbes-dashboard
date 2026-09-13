// functions/api/observe.js
// Records what a user saw on the dashboard and what they did about it.
//
// IDENTITY COMES FROM THE SESSION, NOT THE FORM.
//   The browser sends only the observation text and which tab it was written
//   from. The name, role and branch are read from the Supabase token here. If
//   the form supplied them, anyone could file an entry as a colleague or as
//   another branch — and the first time the log was used to settle a question
//   about who did what, it would be worthless. This is the whole reason the
//   submission goes through a Function rather than straight to Apps Script.

const MAX_TEXT = 4000;

async function authenticate(request, env) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { error: "Not authenticated", status: 401 };
  let check;
  try {
    check = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
  } catch (err) {
    return { error: "Auth check failed: " + err.message, status: 502 };
  }
  if (!check.ok) return { error: "Invalid or expired session", status: 401 };
  const user = await check.json();
  return {
    user,
    name: user?.email || user?.id || "unknown",
    role: (user?.app_metadata?.role || "").toLowerCase().trim() || "user",
    branch: user?.app_metadata?.branch || "",
  };
}

async function callAppsScript(env, action, body) {
  const base = env.APPS_SCRIPT_URL;
  if (!base) return { error: true, message: "APPS_SCRIPT_URL is not set." };
  const sep = base.includes("?") ? "&" : "?";
  const keyParam = env.APPS_SCRIPT_KEY ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY) : "";
  const url = base + sep + "action=" + action + keyParam;
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      redirect: "follow",
    });
  } catch (err) {
    return { error: true, message: "Could not reach Apps Script: " + err.message };
  }
  try {
    return await resp.json();
  } catch (err) {
    return {
      error: true,
      message:
        "Apps Script did not return JSON (HTTP " + resp.status + "). The deployment may " +
        "predate the observation log — redeploy Code.gs as a NEW VERSION of the existing " +
        "deployment, with access = Anyone.",
    };
  }
}

export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const who = await authenticate(request, env);
  if (who.error) return json({ error: true, message: who.error }, who.status);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: true, message: "Body was not valid JSON" }, 400); }

  // ── closing an entry ──
  if (body?.mode === "close") {
    if (!body.ts) return json({ error: true, message: "No entry identified." }, 400);
    // A group-wide account may close anyone's; everyone else only their own.
    const groupWide = !who.branch || who.role === "management" || who.role === "admin_manager";
    const out = await callAppsScript(env, "obs_close", {
      ts: String(body.ts),
      user: groupWide ? "" : who.name,
    });
    return json(out?.error ? out : { ok: true }, out?.error ? 502 : 200);
  }

  // ── a new entry ──
  const observation = String(body?.observation ?? "").trim();
  const action = String(body?.action ?? "").trim();
  if (observation.length < 5) {
    return json({ error: true, message: "Write what you saw before submitting." }, 400);
  }
  if (observation.length > MAX_TEXT || action.length > MAX_TEXT) {
    return json({ error: true, message: "That is longer than this form accepts." }, 413);
  }

  const out = await callAppsScript(env, "obs_save", {
    user: who.name,           // from the session
    role: who.role,           // from the session
    branch: who.branch,       // from the session
    tab: String(body?.tab ?? "").slice(0, 60),
    observation,
    action,
    next: String(body?.next ?? "").trim().slice(0, MAX_TEXT),
    due: String(body?.due ?? "").slice(0, 20),
    status: "Open",
  });
  if (out?.error) return json(out, 502);

  // The log rides in the main payload, so the edge copy is stale now.
  try {
    await caches.default.delete(new Request("https://pbes-dashboard-cache.internal/api/data"));
  } catch (err) { /* the short TTL covers it */ }

  return json({ ok: true, savedAs: who.name, branch: who.branch || "all branches" });
}
