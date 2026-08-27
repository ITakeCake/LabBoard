// GET /api/stats — the Stats tab's data (theFuture item 8).
//   ?metric=installs|errors|active|card|finished|avgdone
//   &from=YYYY-MM-DD&to=YYYY-MM-DD     real date range (X axis is always time)
//   &room=<machine-name prefix>        room OR building split ("10101" = a room,
//                                      "55" = the whole building; blank = all)
//   &app=<id>                          the card sub-selection (metric=card only)
//   ?list=apps                         card ids for the sub-select dropdown
// Metrics: installs = programs installed/day · errors = errors/day · active =
// distinct machines seen/day · card = installs/day of ONE program · finished =
// cumulative machines COMPLETELY done (every expected app + GP + CM) · avgdone =
// avg days from first-seen to completely-done, by completion day.
// Day bucket = the observation's local ts (falls back to server received_at).
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  if (url.searchParams.get('list') === 'apps') {
    try {
      const rows = (await env.DB.prepare(
        "SELECT DISTINCT app_id FROM observations WHERE app_id NOT IN ('__gp__','__cm__') ORDER BY app_id").all()).results || [];
      return json({ ok: true, apps: rows.map((r) => r.app_id) });
    } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
  }
  const metric = (url.searchParams.get('metric') || 'installs');
  const room = (url.searchParams.get('room') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const app = (url.searchParams.get('app') || '').slice(0, 128);
  const day = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') ? s : '');
  const from = day(url.searchParams.get('from'));
  const to = day(url.searchParams.get('to'));

  if (metric === 'avgdone' || metric === 'finished') return doneMetrics(env, metric, room, from, to);

  const dayExpr = "substr(COALESCE(NULLIF(ts,''),received_at),1,10)";
  let where = "WHERE app_id NOT IN ('__gp__','__cm__')";
  const binds = [];
  if (metric === 'errors') { where += " AND verdict='error'"; }
  else if (metric === 'active') { /* any verdict; count distinct machines */ }
  else if (metric === 'card') {
    if (!app) return json({ ok: false, error: 'metric=card needs &app=' }, 400);
    where += " AND verdict='installed' AND app_id = ?"; binds.push(app);
  }
  else { where += " AND verdict='installed'"; }
  if (room) { where += ' AND machine LIKE ?'; binds.push(room + '%'); }
  if (from) { where += ` AND ${dayExpr} >= ?`; binds.push(from); }
  if (to) { where += ` AND ${dayExpr} <= ?`; binds.push(to); }
  const countExpr = metric === 'active' ? 'COUNT(DISTINCT machine)' : 'COUNT(*)';
  const sql = `SELECT ${dayExpr} AS day, ${countExpr} AS n FROM observations ${where} GROUP BY day ORDER BY day ASC LIMIT 400`;
  try {
    const rows = (await env.DB.prepare(sql).bind(...binds).all()).results || [];
    return json({ ok: true, metric, room, from, to, series: rows });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

// Shared "when did each machine finish?" derivation (Blake's rule: first "nothing
// done" run -> first "everything Gucci" run). Per machine: startDay = its earliest
// observation; doneDay = the LATEST of the first-installed days across every expected
// app (master-pushed room_apps) + __gp__ + __cm__. Machines missing any expected piece
// have no done-day yet and never count.
//   finished -> cumulative machines done, plotted by doneDay
//   avgdone  -> avg (doneDay - startDay) in days, for the cohort finishing each day
async function doneMetrics(env, metric, room, from, to) {
  try {
    // GENERATION PARTITION (2026-08-20): machine identity is (hostname, image date).
    // All three per-machine aggregations are grouped by imaged_gen and then reduced to
    // the machine's NEWEST generation — otherwise a re-imaged machine "finishes" off
    // installs from its previous life (10101LAB34-63's 08-03 life vs its 08-19 one).
    const firstDone = (await env.DB.prepare(
      "SELECT machine, app_id, COALESCE(imaged_gen,'') AS g, MIN(substr(COALESCE(NULLIF(ts,''),received_at),1,10)) AS d " +
      "FROM observations WHERE verdict='installed' GROUP BY machine, app_id, COALESCE(imaged_gen,'')").all()).results || [];
    const firstSeen = (await env.DB.prepare(
      "SELECT machine, COALESCE(imaged_gen,'') AS g, MIN(substr(COALESCE(NULLIF(ts,''),received_at),1,10)) AS d " +
      "FROM observations GROUP BY machine, COALESCE(imaged_gen,'')").all()).results || [];
    const genRows = (await env.DB.prepare(
      "SELECT machine, COALESCE(imaged_gen,'') AS g FROM (" +
      "SELECT machine, imaged_gen, ROW_NUMBER() OVER (PARTITION BY machine ORDER BY (ts IS NULL), ts DESC, id DESC) AS rn " +
      "FROM observations) WHERE rn = 1").all()).results || [];
    const roomApps = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps').all()).results || [];

    const genBy = {};
    for (const g of genRows) genBy[g.machine] = g.g;
    const appsBy = {};
    for (const a of roomApps) (appsBy[a.room_key] = appsBy[a.room_key] || []).push(a.app_id);
    const seenBy = {};
    for (const s of firstSeen) if (s.g === (genBy[s.machine] || '')) seenBy[s.machine] = s.d;
    const doneBy = {};
    for (const r of firstDone) { if (r.g === (genBy[r.machine] || '')) (doneBy[r.machine] = doneBy[r.machine] || {})[r.app_id] = r.d; }

    const finished = [];   // {machine, startDay, doneDay, span}
    for (const machine of Object.keys(doneBy)) {
      if (room && !machine.startsWith(room)) continue;
      const rk = (/^(\d+)[A-Za-z]/.exec(machine) || [])[1];
      const expected = (rk && appsBy[rk]) ? appsBy[rk] : null;
      if (!expected) continue;                     // no roster app list -> can't judge "done"
      const need = expected.concat(['__gp__', '__cm__']);
      const got = doneBy[machine];
      let doneDay = '', complete = true;
      for (const a of need) {
        const d = got[a];
        if (!d) { complete = false; break; }
        if (d > doneDay) doneDay = d;
      }
      if (!complete || !doneDay) continue;
      if (from && doneDay < from) continue;
      if (to && doneDay > to) continue;
      const start = seenBy[machine] || doneDay;
      finished.push({ machine, doneDay, span: Math.max(0, Math.round((Date.parse(doneDay) - Date.parse(start)) / 86400000)) });
    }
    finished.sort((a, b) => (a.doneDay < b.doneDay ? -1 : a.doneDay > b.doneDay ? 1 : 0));

    if (metric === 'finished') {
      const series = []; let cum = 0, cur = '';
      for (const f of finished) {
        if (f.doneDay !== cur) { cur = f.doneDay; series.push({ day: cur, n: 0 }); }
        cum++; series[series.length - 1].n = cum;
      }
      return json({ ok: true, metric, unit: 'machines', room, from, to, machinesDone: finished.length, series });
    }
    const byDay = {};
    for (const f of finished) { const b = byDay[f.doneDay] || (byDay[f.doneDay] = { t: 0, n: 0 }); b.t += f.span; b.n++; }
    const series = Object.keys(byDay).sort().map((d) => ({ day: d, n: Math.round((byDay[d].t / byDay[d].n) * 10) / 10 }));
    return json({ ok: true, metric, unit: 'days', room, from, to, machinesDone: finished.length, series });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
