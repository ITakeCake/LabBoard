// Basic-auth gate for every request to labboard.pages.dev.
//
// SECURITY MODEL: this middleware only decides "serve the static asset, or 401".
// It never reads request bodies, never fetches an origin, and answers GET/HEAD
// only. If DASH_PASSWORD is unset it FAILS CLOSED (503) rather than open.

// Dashboard logins. Each password lives in a Pages secret — never in code. A user
// whose secret is unset simply cannot log in (fail closed). Add a login by adding
// one line here and setting its secret with `wrangler pages secret put`.
const USERS = {
  admin: "DASH_PASSWORD",
};

// PAUSE SWITCH: true = the whole site answers a bare 404 for everyone, before
// auth — it looks like nothing exists at this URL. Nothing is deleted; D1,
// deployments and secrets stay intact, and the telemetry Worker is a separate
// service that keeps ingesting. Flip and redeploy to toggle.
const PAUSED = false;

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.byteLength !== bb.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < ab.byteLength; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

function unauthorized() {
  return new Response("401 Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="LabBoard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;

  if (PAUSED) {
    // Deliberately a bare 404, not a 503: a paused site should look like nothing
    // exists here at all — no name, no "maintenance", no hint.
    return new Response("404 Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const expected = env.DASH_PASSWORD;
  if (!expected) {
    return new Response("503 Not configured", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // GET/HEAD everywhere; POST only for the data-tools admin routes (item 15), which
  // sit behind this same Basic Auth. Config and every other API stay read-only, so
  // the "site can never push config" guarantee is untouched.
  const isAdminPost =
    request.method === "POST" && new URL(request.url).pathname.startsWith("/api/admin/");
  if (request.method !== "GET" && request.method !== "HEAD" && !isAdminPost) {
    return new Response("405 Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  // CSRF guard for the destructive admin POST: browsers auto-attach Basic creds to a
  // cross-site form submit, and a text/plain form is a "simple" request (no preflight).
  // Require BOTH a same-origin Origin (when present) AND our custom header — the header
  // alone forces a preflight, which this middleware 405s. A cross-site form can send
  // neither, so it can never reach the data tool.
  if (isAdminPost) {
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).origin !== new URL(request.url).origin) {
      return new Response("403 Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    if (request.headers.get("X-Requested-With") !== "labboard") {
      return new Response("403 Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } });
    }
  }

  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return unauthorized();

  let decoded;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(":");
  if (sep === -1) return unauthorized();
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  // constant-time compare against the matching user's secret; unknown user or an
  // unset secret both burn a comparison against DASH_PASSWORD and fail.
  const secretName = Object.prototype.hasOwnProperty.call(USERS, user) ? USERS[user] : null;
  const userSecret = secretName ? env[secretName] : null;
  const okPass = safeEqual(pass, userSecret || expected);
  if (!(secretName && userSecret && okPass)) return unauthorized();

  const response = await next();
  const gated = new Response(response.body, response);
  gated.headers.set("Cache-Control", "no-store, private");
  gated.headers.set("X-Robots-Tag", "noindex, nofollow");
  gated.headers.set("X-Content-Type-Options", "nosniff");
  gated.headers.set("Referrer-Policy", "no-referrer");
  return gated;
}
