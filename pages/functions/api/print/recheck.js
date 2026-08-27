// GET /api/print/recheck — printable recheck to-do sheet (theFuture item 12).
// A checkbox list of machines that need attention and WHAT each needs, grouped by
// room. Print it straight from the browser (Ctrl-P): the CSS is print-first, and
// the same page is what the master's Export-PrintPdf feeds to Edge headless for a
// real .pdf file.
//
// Query params:
//   rooms=all | 10101,60201        room selection ("all" default)
//   ignoreUntouched=1              "Ignore machines not touched by sticks"
//   ignoreUnchecked=1              "Ignore rooms not checked by sticks"
import { foldFleet } from '../_fleetfold.js';
import { readConfigKey } from '../_config.js';

export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const roomsParam = (url.searchParams.get('rooms') || 'all').trim();
  const ignoreUntouched = url.searchParams.get('ignoreUntouched') === '1';
  const ignoreUnchecked = url.searchParams.get('ignoreUnchecked') === '1';

  const sql = `
    SELECT machine, app_id, verdict, code, ts, stick_id, obs_id, imaged_gen, 0 AS has_log FROM (
      SELECT o.machine, o.app_id, o.verdict, o.code, o.ts, o.stick_id, o.obs_id, o.imaged_gen,
        ROW_NUMBER() OVER (PARTITION BY o.machine, o.app_id
                           ORDER BY (o.ts IS NULL), o.ts DESC, o.id DESC) AS rn
      FROM observations o
    ) WHERE rn = 1`;
  let results = [], roomRows = [], markRows = [], reqRows = [], roomAppRows = [];
  try {
    results = (await env.DB.prepare(sql).all()).results || [];
    roomRows = (await env.DB.prepare('SELECT room_key, building_abbr, expected_count, requires_programs FROM rooms').all()).results || [];
    markRows = (await env.DB.prepare('SELECT machine, state, ts, by, note FROM marks').all()).results || [];
    reqRows = (await env.DB.prepare('SELECT machine, state, by, note, ts FROM mark_requests WHERE applied = 1').all()).results || [];
    roomAppRows = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps').all()).results || [];
  } catch (e) { return html('<h1>Could not read the fleet: ' + esc(String(e.message || e)) + '</h1>', 500); }

  // roomAppRows => the recheck sheet only lists a program as missing/broken if the room
  // actually calls for it (same scope rule as the dashboard), so a print-out never sends a
  // tech chasing software a machine should never have.
  const assignments = await readConfigKey(env, 'assignments', null);
  const { rooms } = foldFleet({ results, roomRows, markRows, reqRows, roomAppRows, assignments });
  const wanted = roomsParam.toLowerCase() === 'all' ? null
    : new Set(roomsParam.split(',').map((s) => s.trim()).filter(Boolean));

  let body = '';
  let totalItems = 0;
  for (const room of rooms) {
    if (wanted && !wanted.has(room.room)) continue;
    const touchedAny = room.slots.some((m) => !m.untouched);
    if (ignoreUnchecked && !touchedAny) continue;
    const items = [];
    for (const m of room.slots) {
      if (m.state === 'green' || m.state === 'blue' || m.state === 'broken') continue;
      if (m.untouched) {
        if (ignoreUntouched) continue;
        items.push({ name: '#' + m.num, needs: m.state === 'red' ? 'Full setup: programs + GP update + CM actions' : 'GP update + CM actions (no program cards)' });
        continue;
      }
      const needs = [];
      const missing = m.apps.filter((a) => a.verdict === 'missing').map((a) => a.app);
      const errored = m.apps.filter((a) => a.verdict === 'error').map((a) => a.app + (a.code ? ' (' + a.code + ')' : ''));
      if (missing.length) needs.push('Install: ' + missing.join(', '));
      if (errored.length) needs.push('Fix failed: ' + errored.join(', '));
      if (m.owed && m.owed.length) needs.push('Run: ' + m.owed.join(' + '));
      if (!needs.length) continue;
      items.push({ name: m.machine || '#' + m.num, needs: needs.join(' · ') });
    }
    if (!items.length) continue;
    totalItems += items.length;
    body += '<section class="room"><h2>' + esc(room.room) + (room.abbr ? ' · ' + esc(room.abbr) : '') +
      ' <span class="cnt">' + items.length + ' machine(s)</span></h2>' +
      items.map((i) => '<div class="item"><span class="box"></span><b>' + esc(i.name) + '</b> — ' + esc(i.needs) + '</div>').join('') +
      '</section>';
  }
  if (!body) body = '<p class="none">Nothing needs a recheck with these filters. 🎉</p>';

  const opts = [roomsParam.toLowerCase() === 'all' ? 'all rooms' : roomsParam,
    ignoreUntouched ? 'ignoring untouched machines' : null,
    ignoreUnchecked ? 'ignoring unchecked rooms' : null].filter(Boolean).join(' · ');
  return html(
    '<header><h1>LabDeploy — Recheck To-Do List</h1><div class="meta">' + esc(opts) +
    ' · ' + totalItems + ' item(s) · generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') +
    '</div><button class="noprint" onclick="print()">🖨 Print</button></header>' + body);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function html(body, status = 200) {
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>Recheck To-Do</title><style>' +
    'body{font:13px/1.5 system-ui,Segoe UI,sans-serif;color:#111;background:#fff;margin:28px;max-width:800px}' +
    'h1{font-size:19px;margin:0}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:3px}' +
    '.meta{color:#555;font-size:11.5px;margin:4px 0 14px}.cnt{color:#666;font-weight:400;font-size:11px}' +
    '.item{padding:4px 0;border-bottom:1px dotted #ccc;page-break-inside:avoid}' +
    '.box{display:inline-block;width:12px;height:12px;border:1.5px solid #333;border-radius:2px;margin-right:8px;vertical-align:-1px}' +
    '.none{color:#555}.noprint{float:right;padding:6px 14px;cursor:pointer}' +
    '@media print{.noprint{display:none}} @page{margin:16mm}' +
    '</style></head><body>' + body + '</body></html>';
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
