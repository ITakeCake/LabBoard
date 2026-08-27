// GET /api/burndown — live rollout burndown (theFuture item 9). Cumulative machines
// "onboarded" (first seen by a stick) over time, against the roster target (sum of
// room expected_count). The remaining = target - touched is the burndown. Read-only.
export async function onRequest(context) {
  const { env } = context;
  try {
    const firsts = (await env.DB.prepare(
      "SELECT machine, MIN(substr(COALESCE(NULLIF(ts,''),received_at),1,10)) AS d FROM observations " +
      "WHERE app_id NOT IN ('__gp__','__cm__') GROUP BY machine").all()).results || [];
    const byDay = {};
    for (const r of firsts) { if (!r.d) continue; byDay[r.d] = (byDay[r.d] || 0) + 1; }
    const days = Object.keys(byDay).sort();
    let cum = 0;
    const series = days.map((d) => { cum += byDay[d]; return { day: d, touched: cum }; });
    const tgt = await env.DB.prepare("SELECT COALESCE(SUM(expected_count),0) AS t FROM rooms").first();
    const target = tgt ? (tgt.t | 0) : 0;
    return json({ ok: true, series, target, touchedTotal: cum });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
