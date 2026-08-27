// GET /api/throughput — per-machine start→finish records for the Timing tab and
// the Stats tab's per-day throughput chart. Read-only. All filtering (room
// prefix, date range, gap threshold) happens CLIENT-side so the checkbox and
// sliders are instant — this just ships every completed machine once.
import { foldThroughput } from './_throughput.js';

export async function onRequest(context) {
  const { env } = context;
  try {
    const ts2 = "COALESCE(NULLIF(ts,''),received_at)";
    const firstInstalled = (await env.DB.prepare(
      `SELECT machine, app_id, COALESCE(imaged_gen,'') AS imaged_gen, MIN(${ts2}) AS ts FROM observations WHERE verdict='installed' GROUP BY machine, app_id, COALESCE(imaged_gen,'')`
    ).all()).results || [];
    const allObs = (await env.DB.prepare(
      `SELECT machine, ${ts2} AS ts, COALESCE(imaged_gen,'') AS imaged_gen FROM observations LIMIT 200000`
    ).all()).results || [];
    const roomApps = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps').all()).results || [];
    // stick attribution for the leaderboard's "who did it" column
    const stickRows = (await env.DB.prepare(
      'SELECT machine, stick_id, COUNT(*) AS n FROM observations GROUP BY machine, stick_id'
    ).all()).results || [];

    const r = foldThroughput(firstInstalled, allObs, roomApps);
    const sticksBy = {};
    for (const s of stickRows) (sticksBy[s.machine] = sticksBy[s.machine] || []).push(s.stick_id);
    for (const m of r.machines) m.sticks = sticksBy[m.machine] || [];
    return json({ ok: true, machines: r.machines, incomplete: r.incomplete, unjudgeable: r.unjudgeable });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
