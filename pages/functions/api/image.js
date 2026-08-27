// GET /api/image — the Image board (theFuture item 19, reworked 2026-08-19). Same
// room/building layout as the fleet page, but every tile answers "what's this PC's
// imaging status?" in THREE colours:
//   green  = imaged — reported an image date IN THE CURRENT CALENDAR YEAR
//   yellow = unknown — no stick has ever seen this PC (never-touched slot, or a
//            mark-only tile), so we can't know its image status
//   red    = stale — a stick HAS seen it, but its image date is from a prior year
//            (or it reported no image date at all) => it needs re-imaging
// Year cutoff is calendar Jan 1 → Dec 31: an image dated this year is current (green),
// anything older is stale (red). Reuses the fleet fold for room sizing/rostering +
// per-PC notes, then recolours.
import { foldFleet } from './_fleetfold.js';
import { readConfigKey } from './_config.js';

export async function onRequest(context) {
  const { env } = context;
  const sql = `
    SELECT machine, app_id, verdict, code, ts, stick_id, obs_id, imaged_gen, 0 AS has_log FROM (
      SELECT o.machine, o.app_id, o.verdict, o.code, o.ts, o.stick_id, o.obs_id, o.imaged_gen,
        ROW_NUMBER() OVER (PARTITION BY o.machine, o.app_id
                           ORDER BY (o.ts IS NULL), o.ts DESC, o.id DESC) AS rn
      FROM observations o
    ) WHERE rn = 1`;
  let results = [], roomRows = [], noteRows = [];
  try {
    results = (await env.DB.prepare(sql).all()).results || [];
    roomRows = (await env.DB.prepare('SELECT room_key, building_abbr, expected_count, requires_programs, prog_nums FROM rooms').all()).results || [];
    noteRows = (await env.DB.prepare('SELECT machine, note, by, ts FROM machine_notes').all()).results || [];
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }

  // "Seen a stick" = this machine actually has an observation row. Override-only tiles
  // and untouched roster slots are NOT in results, so they read as never-seen => yellow.
  const observed = new Set();
  for (const r of results) if (r.machine) observed.add(r.machine);
  const curYear = String(new Date().getFullYear());   // calendar-year cutoff (Jan 1 → Dec 31)

  // reuse the fleet room grid (sizing + roster + notes), but ignore marks for colour -
  // imaging status is its own thing.
  const assignments = await readConfigKey(env, 'assignments', null);
  const { rooms } = foldFleet({ results, roomRows, noteRows, assignments });

  let imaged = 0, unknown = 0, stale = 0;
  for (const room of rooms) {
    for (const s of room.slots) {
      const seenStick = !!(s.machine && observed.has(s.machine));
      const gen = s.imagedGen ? String(s.imagedGen).trim() : '';
      const imagedThisYear = seenStick && gen.slice(0, 4) === curYear;
      let state;
      if (imagedThisYear) { state = 'green'; imaged++; }
      else if (!seenStick) { state = 'yellow'; unknown++; }   // never saw a stick => unknown
      else { state = 'red'; stale++; }                        // seen, but last-year (or no) image
      s.state = state;
      s.imaged = imagedThisYear;
      s.imagedGen = s.imagedGen || null;
      // strip fleet-only fields so the tile only conveys imaging status (+ its note badge)
      s.apps = []; s.mark = undefined; s.error = 0;
      s.untouched = (state === 'yellow');   // hatch the unknowns like the fleet page does
    }
  }
  return json({ ok: true, generated: new Date().toISOString(), summary: { imaged, unknown, stale, total: imaged + unknown + stale }, rooms });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
