// POST /api/admin/data — the data isolate / restore / delete tool (theFuture item 15).
//
// Sits behind the dashboard's Basic Auth (functions/_middleware.js allows POST only on
// /api/admin/*). the design: "move this specific chunk of data to its own isolated
// area where the rest of the code can't see it, then either delete or restore it."
//
//   isolate  {by, why, machine?, stick?, from?, to?}  -> moves matching rows from
//            observations into observations_isolated under a new iso_batch id. At
//            least one filter is required (never "isolate everything" by accident).
//   restore  {batch}                                  -> moves a batch back.
//   delete   {batch, confirm:"DELETE"}                -> permanently removes a batch
//            FROM THE ISOLATED AREA ONLY. A hard delete can never touch live rows;
//            data must be isolated first, so there is always a review step.
//   list     {}                                       -> batches currently isolated.
//
// Every action is loudly logged: console + an alerts row (delete = critical), so it
// shows on the dashboard's alert banner and (if the webhook is set) pings the admin.
export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const action = String(b && b.action || '');
  // WHO: the authenticated dashboard user (Basic Auth), never a client-supplied body
  // field - the audit trail must be truthful and unspoofable. Same derivation as
  // admin/mark.js. Middleware has already verified this user, so it is trustworthy.
  const by = authUser(request);
  try {
    if (action === 'list') return await doList(env);
    if (action === 'isolate') return await doIsolate(env, b, by);
    if (action === 'restore') return await doRestore(env, b, by);
    if (action === 'delete') return await doDelete(env, b, by);
    return json({ ok: false, error: 'unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500);
  }
}

// Pull the logged-in username out of the Basic Auth header the middleware already
// validated. Falls back to 'dashboard' only if the header is somehow missing.
function authUser(request) {
  try {
    const h = request.headers.get('Authorization') || '';
    if (h.startsWith('Basic ')) {
      const d = atob(h.slice(6).trim());
      const i = d.indexOf(':');
      const u = i > 0 ? d.slice(0, i) : '';
      if (u) return u.slice(0, 64);
    }
  } catch {}
  return 'dashboard';
}

const OBS_COLS = 'id, obs_id, stick_id, machine, imaged_gen, app_id, verdict, code, ts, seq, session, token_id, received_at';

async function alert(env, level, kind, detail) {
  try { console.error(JSON.stringify({ ts: new Date().toISOString(), ALERT: true, level, kind, detail })); } catch {}
  try {
    await env.DB.prepare('INSERT INTO alerts (level, kind, detail) VALUES (?,?,?)')
      .bind(level, kind, String(detail).slice(0, 500)).run();
  } catch {}
  if (env.ALERT_WEBHOOK) {
    const msg = `[labboard ${level.toUpperCase()}] ${kind}: ${detail}`;
    try { await fetch(env.ALERT_WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: msg, text: msg }) }); } catch {}
  }
}

async function doList(env) {
  const rows = (await env.DB.prepare(
    'SELECT iso_batch, iso_by, iso_why, MIN(iso_at) AS iso_at, COUNT(*) AS rows_n, ' +
    'COUNT(DISTINCT machine) AS machines, MIN(ts) AS lo_ts, MAX(ts) AS hi_ts ' +
    'FROM observations_isolated GROUP BY iso_batch ORDER BY iso_at DESC').all()).results || [];
  return json({ ok: true, batches: rows });
}

async function doIsolate(env, b, by) {
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const why = clean(b.why, 240);
  const machine = clean(b.machine, 128);
  const stick = clean(b.stick, 64);
  const from = clean(b.from, 40);
  const to = clean(b.to, 40);
  if (!machine && !stick && !from && !to) {
    return json({ ok: false, error: 'need at least one filter (machine, stick, from, to) - refusing to isolate everything' }, 400);
  }
  let where = 'WHERE 1=1'; const binds = [];
  if (machine) { where += ' AND machine = ?'; binds.push(machine); }
  if (stick) { where += ' AND stick_id = ?'; binds.push(stick); }
  if (from) { where += " AND COALESCE(NULLIF(ts,''),received_at) >= ?"; binds.push(from); }
  if (to) { where += " AND COALESCE(NULLIF(ts,''),received_at) <= ?"; binds.push(to); }

  const batch = 'iso-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.floor(Math.random() * 1e6);
  // move = copy with batch metadata, then delete ONLY the rows that actually landed in
  // THIS batch. Deleting by the raw filter would also remove rows whose obs_id already
  // sits in a prior un-restored batch (INSERT OR IGNORE skips them) -> silent data loss.
  // Both statements run in one D1 batch() (single transaction) - no half-moved chunk.
  const ins = env.DB.prepare(
    `INSERT OR IGNORE INTO observations_isolated (${OBS_COLS}, iso_batch, iso_by, iso_why) ` +
    `SELECT ${OBS_COLS}, ?, ?, ? FROM observations ${where}`).bind(batch, by, why, ...binds);
  const del = env.DB.prepare(
    'DELETE FROM observations WHERE obs_id IN (SELECT obs_id FROM observations_isolated WHERE iso_batch = ?)').bind(batch);
  const res = await env.DB.batch([ins, del]);
  const moved = res && res[1] && res[1].meta ? res[1].meta.changes | 0 : 0;
  // only alert when data actually moved — a 0-row isolate is a no-op, not worth a banner.
  if (moved > 0) {
    await alert(env, 'warn', 'data-isolated',
      `${by} isolated ${moved} row(s) [${[machine && 'machine=' + machine, stick && 'stick=' + stick, from && 'from=' + from, to && 'to=' + to].filter(Boolean).join(' ')}]${why ? ' - ' + why : ''} (batch ${batch})`);
  }
  return json({ ok: true, batch, moved });
}

async function doRestore(env, b, by) {
  const batch = String(b.batch || '').slice(0, 80);
  if (!batch) return json({ ok: false, error: 'need batch' }, 400);
  const ins = env.DB.prepare(
    `INSERT OR IGNORE INTO observations (${OBS_COLS}) SELECT ${OBS_COLS} FROM observations_isolated WHERE iso_batch = ?`).bind(batch);
  const del = env.DB.prepare('DELETE FROM observations_isolated WHERE iso_batch = ?').bind(batch);
  const res = await env.DB.batch([ins, del]);
  const restored = res && res[0] && res[0].meta ? res[0].meta.changes | 0 : 0;
  await alert(env, 'warn', 'data-restored', `${by} restored batch ${batch} (${restored} row(s) back into observations)`);
  return json({ ok: true, batch, restored });
}

async function doDelete(env, b, by) {
  const batch = String(b.batch || '').slice(0, 80);
  if (!batch) return json({ ok: false, error: 'need batch' }, 400);
  if (b.confirm !== 'DELETE') return json({ ok: false, error: 'type DELETE to confirm - this is permanent' }, 400);
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM observations_isolated WHERE iso_batch = ?').bind(batch).first();
  const n = row ? row.n | 0 : 0;
  await env.DB.prepare('DELETE FROM observations_isolated WHERE iso_batch = ?').bind(batch).run();
  await alert(env, 'critical', 'data-deleted', `${by} PERMANENTLY deleted batch ${batch} (${n} row(s)) from the isolated area`);
  return json({ ok: true, batch, deleted: n });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
