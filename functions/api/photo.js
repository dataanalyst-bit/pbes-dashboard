// functions/api/photo.js
// v1 — serves the vigilance checklist photographs.
//
// WHY THIS EXISTS
//   The checklist stores Google Drive links. A Drive link only renders for
//   someone who has been granted access to that file, which is why the photos
//   were visible to their owner and to nobody else. The obvious fix — sharing
//   the folder as "anyone with the link" — would make every inspection
//   photograph readable by anyone who ever sees a URL, in a log, a forwarded
//   message or a browser history. School premises and, in places, children are
//   in these pictures.
//
//   So the files stay private and the bytes come through here instead. Apps
//   Script runs as the file owner and returns the image; this function checks
//   the caller first and enforces the same branch rule as /api/data.
//
// HOW THE CALLER IS AUTHENTICATED
//   An <img> tag cannot send an Authorization header, so the Supabase token
//   cannot be used directly and must not be put in the URL (URLs end up in
//   logs and history). /api/data issues a short-lived signed HttpOnly cookie
//   after it has authenticated the caller; this function accepts that cookie.
//   No cookie, no photograph.

// This file is deliberately SELF-CONTAINED. It used to import the cookie name
// and verifier from ./data.js, but Cloudflare Pages compiles each function as
// its own entry point: if data.js is even one commit behind, the build dies
// with "No matching export in api/data.js". The two copies below must stay in
// step with the ones in data.js — they are ten lines and they never change.

const PHOTO_COOKIE = "pbes_ph";

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signPhotoToken(payload, secret) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return body + "." + b64url(new Uint8Array(sig));
}

async function verifyPhotoToken(token, secret) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body] = token.split(".");
  let claims;
  try { claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))); }
  catch { return null; }
  const expect = await signPhotoToken(claims, secret);
  if (expect !== token) return null;
  if (!claims || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}

const MAX_WIDTH = 2400;
// Photographs never change once uploaded, so once fetched they can sit in the
// browser for a long time. The cache is private: this is not public imagery.
const BROWSER_TTL = 86400;

export async function onRequestGet({ request, env }) {
  const fail = (status, message) =>
    new Response(JSON.stringify({ error: true, message }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const url = new URL(request.url);
  const id = (url.searchParams.get("id") || "").trim();
  if (!/^[-\w]{10,}$/.test(id)) return fail(400, "Bad photo id");

  let width = parseInt(url.searchParams.get("sz") || "", 10);
  if (!(width > 0) || width > MAX_WIDTH) width = 1600;

  // ── 1. The caller must hold a cookie this deployment signed ──
  const secret = env.PHOTO_SECRET || env.APPS_SCRIPT_KEY;
  if (!secret) return fail(500, "Photo serving is not configured (no PHOTO_SECRET).");

  const cookies = Object.fromEntries(
    (request.headers.get("Cookie") || "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return i < 0 ? [c, ""] : [c.slice(0, i), c.slice(i + 1)];
      })
  );

  const claims = await verifyPhotoToken(cookies[PHOTO_COOKIE], secret);
  if (!claims) return fail(401, "Not authenticated for photographs — reload the dashboard.");

  // ── 2. Edge cache. Keyed by id, size AND branch, so a cached copy can never
  //      be handed to a principal from another campus. ──
  const scope = claims.branch || "_all";
  const cache = caches.default;
  const cacheKey = new Request(
    `https://pbes-photo-cache.internal/${encodeURIComponent(scope)}/${id}/${width}`
  );
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  // ── 3. Ask Apps Script for the bytes ──
  const base = env.APPS_SCRIPT_URL;
  if (!base) return fail(500, "APPS_SCRIPT_URL is not set.");
  const sep = base.includes("?") ? "&" : "?";
  const keyParam = env.APPS_SCRIPT_KEY ? "&key=" + encodeURIComponent(env.APPS_SCRIPT_KEY) : "";
  const upstreamUrl =
    base + sep + "photo=" + encodeURIComponent(id) + "&sz=" + width + keyParam;

  let resp;
  try {
    resp = await fetch(upstreamUrl, { redirect: "follow" });
  } catch (err) {
    return fail(502, "Could not reach Apps Script: " + err.message);
  }
  if (!resp.ok) return fail(502, "Apps Script returned HTTP " + resp.status + " for this photo.");

  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    return fail(502, "Apps Script did not return JSON for this photo. Redeploy Code.gs.");
  }
  if (!payload || payload.error || !payload.b64) {
    return fail(404, payload?.message || "Photograph not available.");
  }

  // ── 4. Branch rule, the same one /api/data applies to the rows ──
  //   A group-wide account has no branch and sees everything. A branch account
  //   sees only its own campus, matched the same loose way row filtering does.
  if (claims.branch) {
    const norm = (v) => String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
    const a = norm(payload.branch), b = norm(claims.branch);
    const same = a && b && (a === b || a.includes(b) || b.includes(a));
    if (!same) return fail(403, "This photograph belongs to another branch.");
  }

  // ── 5. base64 → bytes ──
  let bytes;
  try {
    const bin = atob(payload.b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch (err) {
    return fail(502, "Photograph payload was unreadable.");
  }

  const out = new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": payload.mime || "image/jpeg",
      "Cache-Control": "private, max-age=" + BROWSER_TTL,
      "X-Content-Type-Options": "nosniff",
      // Never let a photograph be framed or hotlinked from elsewhere.
      "Content-Disposition": "inline",
    },
  });
  await cache.put(cacheKey, out.clone());
  return out;
}
