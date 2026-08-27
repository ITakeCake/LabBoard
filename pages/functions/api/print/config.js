// GET /api/print/config — printable per-room program checklist (theFuture item 13).
// "Lists what every room has installed according to the config, with a checkbox.
//  1 page per room — rooms NEVER share a page (a room may span pages)."
// Data = the master-pushed roster (rooms) + expected apps (room_apps). Print from the
// browser or feed to Edge headless for a real .pdf (master Export-PrintPdf).
//
// Query params: rooms=all | 10101,60201   (multi-select with an ALL option)
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const roomsParam = (url.searchParams.get('rooms') || 'all').trim();
  let roomRows = [], appRows = [];
  try {
    roomRows = (await env.DB.prepare('SELECT room_key, building, room, building_abbr, expected_count FROM rooms ORDER BY room_key').all()).results || [];
    appRows = (await env.DB.prepare('SELECT room_key, app_id FROM room_apps ORDER BY room_key, app_id').all()).results || [];
  } catch (e) { return html('<h1>Could not read the roster: ' + esc(String(e.message || e)) + '</h1>', 500); }

  const appsBy = {};
  for (const a of appRows) (appsBy[a.room_key] = appsBy[a.room_key] || []).push(a.app_id);
  const wanted = roomsParam.toLowerCase() === 'all' ? null
    : new Set(roomsParam.split(',').map((s) => s.trim()).filter(Boolean));

  let body = '';
  for (const r of roomRows) {
    if (wanted && !wanted.has(r.room_key)) continue;
    const apps = appsBy[r.room_key] || [];
    body += '<section class="roompage"><h2>' + esc(r.building_abbr || r.building || '') + ' — Room ' + esc(r.room || r.room_key) +
      '</h2><div class="meta">' + (r.expected_count ? r.expected_count + ' machines · ' : '') + apps.length + ' program(s) per config</div>' +
      (apps.length
        ? apps.map((a) => '<div class="item"><span class="box"></span>' + esc(a) + '</div>').join('')
        : '<p class="none">No program cards configured for this room (GP/CM-only room).</p>') +
      '</section>';
  }
  if (!body) body = '<p class="none">No rooms matched. The master pushes the roster (and each room\'s app list) on Refresh — if this is empty, hit Refresh on the master first.</p>';

  return html('<header class="noprint"><h1>LabDeploy — Program Config Sheets</h1><div class="meta">' +
    esc(roomsParam.toLowerCase() === 'all' ? 'all rooms' : roomsParam) +
    ' · generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') +
    '</div><button onclick="print()">🖨 Print</button></header>' + body);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function html(body, status = 200) {
  const page = '<!doctype html><html><head><meta charset="utf-8"><title>Program Config Sheets</title><style>' +
    'body{font:13px/1.6 system-ui,Segoe UI,sans-serif;color:#111;background:#fff;margin:28px;max-width:800px}' +
    'h1{font-size:19px;margin:0}h2{font-size:16px;margin:0 0 2px}' +
    '.meta{color:#555;font-size:11.5px;margin:2px 0 12px}.none{color:#555}' +
    // ONE ROOM PER PAGE: every room section forces a page break after itself and
    // never starts mid-page share. A long room flows onto extra pages naturally.
    '.roompage{page-break-after:always;break-after:page;padding-top:6px}' +
    '.roompage:last-of-type{page-break-after:auto;break-after:auto}' +
    '.item{padding:4px 0;border-bottom:1px dotted #ccc;page-break-inside:avoid}' +
    '.box{display:inline-block;width:12px;height:12px;border:1.5px solid #333;border-radius:2px;margin-right:8px;vertical-align:-1px}' +
    'header button{float:right;padding:6px 14px;cursor:pointer}' +
    '@media print{.noprint{display:none}} @page{margin:16mm}' +
    '</style></head><body>' + body + '</body></html>';
  return new Response(page, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
