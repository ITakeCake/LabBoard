// GET /api/fleet[?year=<label>] — live fleet in the 6-colour model, read from D1.
//
// Basic Auth is enforced by functions/_middleware.js. Touched machines are coloured
// from their own observations (+ the __gp__/__cm__ pseudo-apps the client pushes);
// untouched slots come from the synced room roster. Each room is sized to
// max(highest machine seen, the roster's expected_count). Master marks + applied
// request-edits override the observed colour under newest-sighting-wins. ?year=
// partitions by machine generation (image date) using the master-pushed year pages;
// default = the master's current year. The authoritative reconciliation still lives in
// the master's Get-FleetRollup — this is the display view. Fold + year logic live in
// _fleetfold.js (unit-tested with node).
//
// Colours: green = all programs present + GP + CM run; yellow = a program missing;
// purple = programs present but GP/CM owed; red = untouched, needs programs;
// orange = untouched, GP/CM-only room; blue = reported missing; broken = blue + X.
import { foldFleet } from './_fleetfold.js';
import { readConfigKey } from './_config.js';

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const yearParam = url.searchParams.get('year');
  const sql = `
    SELECT machine, app_id, verdict, code, ts, stick_id, obs_id, has_log, imaged_gen FROM (
      SELECT o.machine, o.app_id, o.verdict, o.code, o.ts, o.stick_id, o.obs_id, o.imaged_gen,
        (SELECT 1 FROM logs l WHERE l.obs_id = o.obs_id) AS has_log,
        ROW_NUMBER() OVER (PARTITION BY o.machine, o.app_id
                           ORDER BY (o.ts IS NULL),
                             -- GP/CM are once-per-image tasks: a SUCCESSFUL run this
                             -- image outranks a later transient failure (CM sometimes
                             -- reports failed=10 in a burst and succeeds on retry 15s
                             -- later; newest-wins let one bad reading erase a real
                             -- success and strand machines purple - 2026-08-21).
                             -- Real apps keep pure newest-wins (CASE is constant 1).
                             CASE WHEN o.app_id IN ('__gp__','__cm__') AND o.verdict='installed' THEN 0 ELSE 1 END,
                             o.ts DESC, o.id DESC) AS rn
      FROM observations o
    ) WHERE rn = 1`;
  let results = [], roomRows = [], markRows = [], reqRows = [], noteRows = [], yearsRow = null, roomAppRows = [];
  try {
    results = (await env.DB.prepare(sql).all()).results || [];
    roomRows = (await env.DB.prepare('SELECT room_key, building_abbr, expected_count, requires_programs, prog_nums FROM rooms').all()).results || [];
    markRows = (await env.DB.prepare('SELECT machine, state, ts, by, note FROM marks').all()).results || [];
    reqRows = (await env.DB.prepare('SELECT machine, state, by, note, ts FROM mark_requests WHERE applied = 1').all()).results || [];
    noteRows = (await env.DB.prepare('SELECT machine, note, by, ts FROM machine_notes').all()).results || [];
    yearsRow = await env.DB.prepare("SELECT json FROM config_kv WHERE key = 'years'").first();
    roomAppRows = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps').all()).results || [];
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
  // which apps require the "I opened it" confirmation, and which machine+app pairs
  // ever recorded one — powers "installed on X, but never marked as checked" (line 41).
  let needsOpen = new Set(), openedSet = new Set();
  try {
    const noRow = await env.DB.prepare("SELECT json FROM config_kv WHERE key = 'needsopen'").first();
    if (noRow && noRow.json) { const arr = JSON.parse(noRow.json); if (Array.isArray(arr)) needsOpen = new Set(arr); }
    if (needsOpen.size) {
      const op = (await env.DB.prepare("SELECT DISTINCT machine, app_id FROM observations WHERE verdict = 'opened'").all()).results || [];
      for (const o of op) openedSet.add(o.machine + '|' + o.app_id);
    }
  } catch {}

  // apps the master excludes from fleet-health colouring (excludeFromFleetHealth), pushed as
  // a config_kv list — so a machine only missing one of these (e.g. MatlabLabDefaults) is
  // never coloured yellow, mirroring the master.
  let healthExcluded = [];
  {
    const arr = await readConfigKey(env, 'health_excluded', null);
    if (Array.isArray(arr)) healthExcluded = arr;
  }

  // The assignment ledger: hostname -> room (+ optional machine number), authored on
  // the master for fleets whose hostnames carry no decodable naming scheme. Display
  // placement only — see the header of _fleetfold.js.
  const assignments = await readConfigKey(env, 'assignments', null);

  let years = null;
  try { if (yearsRow && yearsRow.json) years = JSON.parse(yearsRow.json); } catch { years = null; }
  const pages = years && Array.isArray(years.pages) && years.pages.length ? years.pages : null;
  const currentYear = years && years.current != null ? years.current : null;
  const selectedYear = (yearParam != null && yearParam !== '') ? yearParam
    : (currentYear != null ? String(currentYear) : null);

  const { summary, rooms } = foldFleet({
    results, roomRows, markRows, reqRows, noteRows, roomAppRows, healthExcluded, assignments,
    year: pages ? selectedYear : null, pages, currentYear,
  });

  // "Never attempted" (theFuture line 37): expected apps (master-pushed room_apps) with
  // NO observation row at all on a touched machine — distinct from 'missing', which
  // means a scan looked and found it absent. Untouched machines skip this entirely
  // (of course a machine never seen by a stick has no attempts).
  const appsBy = {};
  for (const a of roomAppRows) (appsBy[a.room_key] = appsBy[a.room_key] || []).push(a.app_id);
  for (const room of rooms) {
    const expected = appsBy[room.room] || [];
    for (const m of room.slots) {
      if (m.untouched || !m.machine) continue;
      if (expected.length) {
        const seen = new Set(m.apps.map((x) => x.app));
        const na = expected.filter((a) => !seen.has(a));
        if (na.length) m.notAttempted = na;
      }
      // installed, needs the opened-confirm, and no 'opened' fact ever recorded
      if (needsOpen.size) {
        for (const a of m.apps) {
          if (a.verdict === 'installed' && needsOpen.has(a.app) && !openedSet.has(m.machine + '|' + a.app)) a.neverChecked = true;
        }
      }
    }
  }
  return json({ ok: true, generated: new Date().toISOString(), year: selectedYear, years: years || null, summary, rooms });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
