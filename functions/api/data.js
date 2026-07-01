// ============================================================
// Cloudflare Pages Function  ·  route: /api/data
// Runs SERVER-SIDE on Cloudflare's edge (not in the browser).
// 1. Reads the caller's Supabase session token from the Authorization header
// 2. Asks Supabase to validate it
// 3. Only if valid, fetches the Google Apps Script data and returns it
//
// The Apps Script URL lives in an env var here, so it is NEVER sent to the browser.
// ============================================================

export async function onRequestGet({ request, env }) {
  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  // 1) Get the user's session token
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: true, message: "Not authenticated" }, 401);

  // 2) Validate the token with Supabase (returns the user if the token is good)
  let check;
  try {
    check = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: env.SUPABASE_ANON_KEY,
      },
    });
  } catch (err) {
    return json({ error: true, message: "Auth check failed: " + err.message }, 502);
  }
  if (!check.ok) return json({ error: true, message: "Invalid or expired session" }, 401);

  // 3) Token is valid — fetch the protected data source server-side
  try {
    const base = env.APPS_SCRIPT_URL;
    const sep = base.includes("?") ? "&" : "?";
    // Optional shared secret (only added if you set APPS_SCRIPT_KEY in Cloudflare)
    const keyParam = env.APPS_SCRIPT_KEY
      ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY)
      : "";
    const upstreamUrl = base + sep + "_t=" + Date.now() + keyParam;

    const upstream = await fetch(upstreamUrl, { redirect: "follow" });
    const body = await upstream.text(); // Apps Script returns JSON text
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (err) {
    return json({ error: true, message: "Upstream fetch failed: " + err.message }, 502);
  }
}
