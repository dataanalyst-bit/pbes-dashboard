// functions/api/meet.js
// v1 — saves the Meeting Actions transcript so every user sees the same one.
//
// WHY THIS EXISTS
//   The transcript was held in the uploader's own browser (IndexedDB). That
//   made it invisible to everybody else: each person had to paste it again,
//   and a principal never saw it at all. It is now written to the workbook, so
//   there is ONE copy and every user reads it.
//
// WHO MAY WRITE
//   Reading goes through /api/data?section=meet like any other section. Writing
//   comes here, and only from a group-wide account (no branch on the profile,
//   or the management role). A branch principal uploading a transcript would
//   silently replace the group's copy for everyone, which is not a decision one
//   branch should be able to make.

export async function onRequestPost({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  // ── 1. Authenticate against Supabase, exactly as /api/data does ──
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
  const branch = user?.app_metadata?.branch || null;

  // ── 2. Only a group-wide account may replace the shared copy ──
  const mayWrite = !branch || role === "management" || role === "admin_manager";
  if (!mayWrite) {
    return json({
      error: true,
      message: "Only a group-wide account can upload the meeting transcript. " +
               "You can read the one that has been uploaded, but not replace it.",
    }, 403);
  }

  // ── 3. Read the body ──
  let body;
  try { body = await request.json(); }
  catch { return json({ error: true, message: "Body was not valid JSON" }, 400); }

  const text = String(body?.text ?? "");
  const date = String(body?.date ?? "");
  // A transcript beyond this is almost certainly a wrong file, and the sheet
  // would take a long time to write it.
  if (text.length > 2000000) {
    return json({ error: true, message: "Transcript is too large (over 2 MB of text)." }, 413);
  }

  // ── 4. Hand it to Apps Script, which owns the workbook ──
  const base = env.APPS_SCRIPT_URL;
  if (!base) return json({ error: true, message: "APPS_SCRIPT_URL is not set." }, 500);
  const sep = base.includes("?") ? "&" : "?";
  const keyParam = env.APPS_SCRIPT_KEY ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY) : "";
  const url = base + sep + "action=meet_save" + keyParam;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, date, who: user?.email || user?.id || "" }),
      redirect: "follow",
    });
  } catch (err) {
    return json({ error: true, message: "Could not reach Apps Script: " + err.message }, 502);
  }

  let out;
  try { out = await resp.json(); }
  catch {
    return json({
      error: true,
      message: "Apps Script did not return JSON (HTTP " + resp.status + "). " +
               "The deployment may predate doPost — redeploy Code.gs as a NEW VERSION " +
               "of the existing deployment, with access = Anyone.",
    }, 502);
  }
  if (out?.error) return json(out, 502);

  // The edge copy of the section is now stale by definition.
  try {
    await caches.default.delete(new Request("https://pbes-dashboard-cache.internal/api/data/meet"));
  } catch (err) { /* the 30-second TTL covers it anyway */ }

  return json({ ok: true, chars: out?.chars ?? text.length, savedBy: user?.email || "" });
}
