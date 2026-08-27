// POST /api/admin/mark — set a tech mark on one or more machines FROM THE DASHBOARD.
// Behind the same Basic Auth as the rest of the site (functions/_middleware.js allows
// POST on /api/admin/* + requires the X-Requested-With guard). Writes append-only
// request-edits into mark_requests (applied=1, since the dashboard user is authenticated)
// so fleet.js folds them under newest-sighting-wins - exactly like a whitelisted USB edit.
//   state: verified | override | missing | broken | clear
//   machines: ["10103LAB30-06", ...]   (multi-select supported)
//   ts: caller's LOCAL wall-clock (matches observation ts so newest-wins compares right)
export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const machines = Array.isArray(b.machines) ? b.machines : (b.machine ? [b.machine] : []);
  const state = String(b.state || '');
  const VALID = new Set(['verified', 'override', 'missing', 'broken', 'clear']);
  if (!machines.length || !VALID.has(state)) return json({ ok: false, error: 'need machines[] and a valid state' }, 400);

  // who: derive from the Basic Auth user, so the hover note is truthful.
  let by = 'dashboard';
  try {
    const h = request.headers.get('Authorization') || '';
    if (h.startsWith('Basic ')) { const d = atob(h.slice(6)); const i = d.indexOf(':'); by = (i > 0 ? d.slice(0, i) : 'dashboard'); }
  } catch {}
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  by = clean(by, 64) || 'dashboard';
  const note = clean(b.note, 240);
  // ts should be the caller's LOCAL wall-clock (client sends it); fall back to a local-ish
  // stamp derived from the request time if absent.
  const ts = clean(b.ts, 40) || new Date().toISOString().slice(0, 23);

  const verb = { verified: 'set to verified', override: 'overridden good', missing: 'reported missing', broken: 'marked broken', clear: 'cleared' }[state];

  const sha1 = async (s) => {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
  };
  const ins = env.DB.prepare(
    'INSERT OR IGNORE INTO mark_requests (req_id, machine, state, by, note, ts, stick_id, applied) VALUES (?,?,?,?,?,?,?,1)');
  const stmts = [];
  for (const mRaw of machines.slice(0, 500)) {
    const machine = clean(mRaw, 128);
    if (!machine) continue;
    const n = note || `${by} ${verb} on ${ts.slice(0, 10)}`;
    const reqId = await sha1(`${by}|${machine}|${state}|${ts}`);
    stmts.push(ins.bind(reqId, machine, state, by, n, ts, 'dashboard'));
  }
  if (!stmts.length) return json({ ok: false, error: 'no valid machines' }, 400);
  try {
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
  return json({ ok: true, marked: stmts.length, state, by });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
