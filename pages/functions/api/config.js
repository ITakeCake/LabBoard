// GET /api/config — the master-authored config the dashboard is allowed to read
// (years / whitelist / buildings / needsopen / health_excluded / assignments). READ-ONLY:
// the site can never write config. The master is the only writer (Worker POST /config);
// functions/_middleware.js already 405s any non-GET, which structurally enforces "the
// site cannot push config".
//
// Returns { ok, config: { <key>: <parsed blob>, ... }, updated: { <key>: <iso> } } with
// each value parsed from its stored JSON (falls back to the raw string if unparseable).
export async function onRequest(context) {
  const { env } = context;
  let rows = [];
  try {
    rows = (await env.DB.prepare('SELECT key, json, updated_at FROM config_kv').all()).results || [];
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
  const config = {};
  const updated = {};
  for (const r of rows) {
    let v;
    try { v = JSON.parse(r.json); } catch { v = r.json; }
    config[r.key] = v;
    updated[r.key] = r.updated_at;
  }
  return json({ ok: true, config, updated });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
