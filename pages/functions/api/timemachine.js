// GET /api/timemachine[?at=<iso>] — the SURPRISE tab (theFuture item 20). Replays the
// fleet's 6-colour state as it stood at any past instant, using the append-only,
// timestamped observations. No new logging needed — the history is already there.
// Reuses the exact same fold as the live view, but over only the facts with ts <= at
// (marks/requests too). No `at` => just the slider bounds (earliest/latest observation).
import { foldFleet } from './_fleetfold.js';
import { readConfigKey } from './_config.js';

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const at = (url.searchParams.get('at') || '').slice(0, 40);
  let bounds = null;
  try { bounds = await env.DB.prepare("SELECT MIN(NULLIF(ts,'')) AS lo, MAX(NULLIF(ts,'')) AS hi FROM observations").first(); } catch (e) { bounds = null; }
  if (!at) return json({ ok: true, at: null, bounds, summary: null, rooms: [] });

  const sql = `
    SELECT machine, app_id, verdict, code, ts, stick_id, obs_id, imaged_gen, 0 AS has_log FROM (
      SELECT o.machine, o.app_id, o.verdict, o.code, o.ts, o.stick_id, o.obs_id, o.imaged_gen,
        ROW_NUMBER() OVER (PARTITION BY o.machine, o.app_id
                           ORDER BY (o.ts IS NULL), o.ts DESC, o.id DESC) AS rn
      FROM observations o WHERE o.ts IS NOT NULL AND o.ts <= ?
    ) WHERE rn = 1`;
  try {
    const results = (await env.DB.prepare(sql).bind(at).all()).results || [];
    const roomRows = (await env.DB.prepare('SELECT room_key, building_abbr, expected_count, requires_programs FROM rooms').all()).results || [];
    const markRows = (await env.DB.prepare('SELECT machine, state, ts, by, note FROM marks WHERE ts <= ?').bind(at).all()).results || [];
    const reqRows = (await env.DB.prepare('SELECT machine, state, by, note, ts FROM mark_requests WHERE applied = 1 AND ts <= ?').bind(at).all()).results || [];
    // roomAppRows => the replayed past state uses the same room-scoped rule as the live
    // fleet, so history never shows out-of-scope "missing" the dashboard would hide today.
    const roomAppRows = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps').all()).results || [];
    let healthExcluded = [];
    { const a = await readConfigKey(env, 'health_excluded', null); if (Array.isArray(a)) healthExcluded = a; }
    // The ledger is the CURRENT placement, not a past one — a replayed frame draws
    // machines where they live today. Room membership is not itself timestamped.
    const assignments = await readConfigKey(env, 'assignments', null);
    const { summary, rooms } = foldFleet({ results, roomRows, markRows, reqRows, roomAppRows, healthExcluded, assignments });
    return json({ ok: true, at, bounds, summary, rooms });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
