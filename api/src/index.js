// labboard-api — the telemetry plane Worker.
//
// The ONLY code on the telemetry plane. Its whole job: append observations,
// append failed-install logs, serve them back. It has NO verbs beyond that — it
// cannot hold config, decide installs, add a card, modify a stick, or instruct any
// client. Nothing it returns is executed by a client.
//
// Auth: every DATA route needs `Authorization: Bearer <stick-token>`. The raw token
// is never stored — we look up SHA-256(token). `/health` is unauthenticated and
// returns no data, so a lab machine can test HTTPS reachability without a token.
//
// LOGGING: every step is console-logged as JSON (view with `wrangler tail` or the
// Cloudflare Observability tab). ANOMALIES (NaN/Infinity, out-of-bounds numbers,
// mostly-invalid batches, rate trips, oversized logs) are written to the `alerts`
// table, console.error'd, and — if ALERT_WEBHOOK is set — POSTed to Blake in real time.

const MAX_ROWS_PER_REQUEST = 5000;  // one request may carry a big backfill chunk
const MAX_REQUESTS_PER_MIN = 600;   // coarse runaway backstop — generous enough for a
                                    // first-run backfill (hundreds of files); a true flood
                                    // (1000s/min, "not a stick") still trips
const INSERT_BATCH = 100;           // D1 caps bound params at 100/query, so we bind ONE row
                                    // per statement (11 params) and batch() this many per round-trip
const MAX_LOG_BYTES = 1500000;      // server backstop; client caps at 1 MB tail + 16 KB head
const MAX_SEQ = 10000000;           // a session with >10M log lines is not real
const BAD_INVALID_RATIO = 0.5;      // >50% of a sizeable batch invalid -> suspicious

const VERDICTS = new Set(['installed', 'missing', 'error', 'opened', 'removed', 'snapshot']);

const MAX_CONFIG_BYTES = 200000;                        // a config blob (years/whitelist/buildings) is small
// The only keys the master may push. EVERY one of them is DISPLAY data: it changes
// what the dashboard draws and nothing else. The Worker stores each blob opaquely and
// never interprets it, so widening this list can never widen what the server can do to
// a client — the telemetry plane still has no verb that reaches a machine.
//   years           year pages + the current page (fleet partitioning)
//   whitelist       who may have a mark-request applied
//   buildings       building code -> abbreviation, for labels
//   needsopen       apps that require the "I opened it" confirmation
//   health_excluded apps that must never colour a tile yellow
//   assignments     the assignment ledger: hostname -> room (+ optional machine number),
//                   for fleets whose hostnames carry no decodable naming scheme
const CONFIG_KEYS = new Set(['years', 'whitelist', 'buildings', 'needsopen', 'health_excluded', 'assignments']);
// Per-key size cap. The ledger is the one blob that scales with the fleet (one entry
// per machine, ~80 bytes), so it gets a larger ceiling than the small label blobs.
const CONFIG_KEY_BYTES = { assignments: 1500000 };
const MARK_REQ_STATES = new Set(['verified', 'override', 'missing', 'broken', 'clear']);   // request-edit verbs

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// Structured step log — one JSON line per event. Cheap; this is the "hella logging".
function logStep(kind, obj) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), kind, ...obj })); }
  catch { console.log('step ' + kind); }
}

// Record an anomaly: alerts table + console + optional webhook (fire-and-forget).
async function raiseAlert(env, ctx, level, kind, detail, meta = {}) {
  const d = String(detail == null ? '' : detail).slice(0, 500);
  try {
    (level === 'critical' ? console.error : console.warn)(
      JSON.stringify({ ts: new Date().toISOString(), ALERT: true, level, kind, detail: d, ...meta }));
  } catch {}
  try {
    await env.DB.prepare(
      'INSERT INTO alerts (level, kind, detail, stick_id, machine, token_id) VALUES (?,?,?,?,?,?)'
    ).bind(level, kind, d, meta.stick_id || null, meta.machine || null, meta.token_id || null).run();
  } catch (e) { try { console.error('alert-insert-failed ' + e); } catch {} }
  if (env.ALERT_WEBHOOK) {
    const msg = `[labboard ${level.toUpperCase()}] ${kind}: ${d}` + (meta.stick_id ? ` (stick ${meta.stick_id})` : '');
    // Discord uses {content}, Slack uses {text}; sending both is harmless.
    const p = fetch(env.ALERT_WEBHOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg, text: msg }),
    }).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else { try { await p; } catch {} }
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function authToken(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  const raw = h.slice(7).trim();
  if (!raw) return null;
  const hash = await sha256Hex(raw);
  const row = await env.DB.prepare('SELECT id, stick_id, enabled FROM tokens WHERE token_hash = ?').bind(hash).first();
  if (!row || !row.enabled) return null;
  return { id: row.id, stick_id: row.stick_id };
}

async function rateCount(env, id) {
  const bucket = Math.floor(Date.now() / 60000);
  await env.DB.prepare(
    'INSERT INTO rate (token_id, bucket, count) VALUES (?, ?, 1) ON CONFLICT(token_id, bucket) DO UPDATE SET count = count + 1'
  ).bind(id, bucket).run();
  const row = await env.DB.prepare('SELECT count FROM rate WHERE token_id = ? AND bucket = ?').bind(id, bucket).first();
  return row ? row.count : 1;
}
async function rateOk(env, tokenId) { return (await rateCount(env, tokenId)) <= MAX_REQUESTS_PER_MIN; }
// a stable, per-IP bucket id for unauthenticated routes (kept in a distinct negative
// range so it can't collide with real positive token ids).
function ipBucketId(request) {
  const ip = request.headers.get('CF-Connecting-IP') || '0';
  let h = 0; for (let i = 0; i < ip.length; i++) h = (h * 31 + ip.charCodeAt(i)) | 0;
  return -2000000000 - (Math.abs(h) % 100000000);
}

// Is this observation's seq a real number in range? (NaN / Infinity / negative /
// absurdly large all fail — the "crazy out-of-bounds number stuff".)
function seqIsSane(v) {
  if (v === undefined || v === null || v === '') return true; // absent is fine
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SEQ;
}

function cleanObs(o) {
  if (!o || typeof o !== 'object') return null;
  if (!o.obs_id || !o.machine || !o.app_id || !o.verdict) return null;
  if (!VERDICTS.has(String(o.verdict))) return null;
  return {
    obs_id: String(o.obs_id).slice(0, 64),
    machine: String(o.machine).slice(0, 128),
    imaged_gen: o.imaged_gen != null ? String(o.imaged_gen).slice(0, 64) : null,
    app_id: String(o.app_id).slice(0, 128),
    verdict: String(o.verdict),
    code: o.code != null && o.code !== '' ? String(o.code).slice(0, 16) : null,
    ts: o.ts != null ? String(o.ts).slice(0, 40) : null,
    seq: seqIsSane(o.seq) && o.seq != null && o.seq !== '' ? (Number(o.seq) | 0) : null,
    session: o.session != null ? String(o.session).slice(0, 64) : null,
  };
}

async function handleObsPost(request, env, ctx, tok) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const arr = Array.isArray(body) ? body : (body && Array.isArray(body.observations) ? body.observations : null);
  if (!arr) return json({ ok: false, error: 'expected {observations:[...]}' }, 400);
  if (arr.length > MAX_ROWS_PER_REQUEST) {
    await raiseAlert(env, ctx, 'warn', 'oversized-batch', `${arr.length} rows > cap ${MAX_ROWS_PER_REQUEST}`, { stick_id: tok.stick_id, token_id: tok.id });
    return json({ ok: false, error: 'too many rows', max: MAX_ROWS_PER_REQUEST }, 413);
  }
  if (!(await rateOk(env, tok.id))) {
    await raiseAlert(env, ctx, 'warn', 'rate-trip', `>${MAX_REQUESTS_PER_MIN} requests/min`, { stick_id: tok.stick_id, token_id: tok.id });
    return json({ ok: false, error: 'rate limited' }, 429);
  }

  let badNumbers = 0;
  for (const o of arr) { if (o && !seqIsSane(o.seq)) badNumbers++; }
  const rows = arr.map(cleanObs).filter(Boolean);
  const invalid = arr.length - rows.length;
  logStep('obs.received', { stick: tok.stick_id, received: arr.length, valid: rows.length, invalid, badNumbers });

  if (badNumbers > 0) {
    await raiseAlert(env, ctx, 'warn', 'bad-number',
      `${badNumbers} observation(s) carried a NaN/Infinity/out-of-bounds seq`, { stick_id: tok.stick_id, token_id: tok.id });
  }
  if (arr.length >= 10 && invalid / arr.length > BAD_INVALID_RATIO) {
    await raiseAlert(env, ctx, 'warn', 'high-invalid-ratio',
      `${invalid}/${arr.length} rows rejected as malformed`, { stick_id: tok.stick_id, token_id: tok.id });
  }

  let inserted = 0;
  const ins = env.DB.prepare(
    'INSERT OR IGNORE INTO observations (obs_id, stick_id, machine, imaged_gen, app_id, verdict, code, ts, seq, session, token_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const chunk = rows.slice(i, i + INSERT_BATCH);
    const stmts = chunk.map((r) =>
      ins.bind(r.obs_id, tok.stick_id, r.machine, r.imaged_gen, r.app_id, r.verdict, r.code, r.ts, r.seq, r.session, tok.id));
    const res = await env.DB.batch(stmts);
    for (const rr of res) { inserted += (rr && rr.meta && rr.meta.changes) ? rr.meta.changes : 0; }
  }
  logStep('obs.inserted', { stick: tok.stick_id, inserted, valid: rows.length });
  return json({ ok: true, received: arr.length, valid: rows.length, inserted, invalid, badNumbers });
}

async function handleLogPost(request, env, ctx, tok) {
  if (!env.LOGS) return json({ ok: false, error: 'log storage (R2) not enabled yet' }, 503);
  const u = new URL(request.url);
  const clean = (s, n) => (s || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, n);
  const obsId = clean(u.searchParams.get('obs_id'), 64);
  const machine = clean(u.searchParams.get('machine'), 128);
  const session = clean(u.searchParams.get('session'), 64);
  const appId = clean(u.searchParams.get('app_id'), 128);
  const truncated = u.searchParams.get('truncated') === '1' ? 1 : 0;
  if (!obsId || !machine || !session || !appId) return json({ ok: false, error: 'missing obs_id/machine/session/app_id' }, 400);
  if (!(await rateOk(env, tok.id))) {
    await raiseAlert(env, ctx, 'warn', 'rate-trip', 'log upload rate exceeded', { stick_id: tok.stick_id, machine, token_id: tok.id });
    return json({ ok: false, error: 'rate limited' }, 429);
  }
  const bodyBuf = await request.arrayBuffer();
  if (bodyBuf.byteLength > MAX_LOG_BYTES) {
    await raiseAlert(env, ctx, 'warn', 'oversized-log', `${bodyBuf.byteLength} bytes > cap ${MAX_LOG_BYTES}`, { stick_id: tok.stick_id, machine, token_id: tok.id });
    return json({ ok: false, error: 'log too large', max: MAX_LOG_BYTES }, 413);
  }
  const key = `${machine}/${session}/${appId}.log`;
  await env.LOGS.put(key, bodyBuf, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
  await env.DB.prepare('INSERT OR REPLACE INTO logs (obs_id, r2_key, bytes, truncated) VALUES (?,?,?,?)')
    .bind(obsId, key, bodyBuf.byteLength, truncated).run();
  logStep('log.stored', { stick: tok.stick_id, machine, appId, bytes: bodyBuf.byteLength, truncated });
  return json({ ok: true, r2_key: key, bytes: bodyBuf.byteLength });
}

// POST /rooms — upsert the room roster (master only, in practice). Sizes the
// dashboard's rooms and decides untouched-slot colour. Config for DISPLAY only.
async function handleRoomsPost(request, env, ctx, tok) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const arr = Array.isArray(body) ? body : (body && Array.isArray(body.rooms) ? body.rooms : null);
  if (!arr) return json({ ok: false, error: 'expected {rooms:[...]}' }, 400);
  if (!(await rateOk(env, tok.id))) return json({ ok: false, error: 'rate limited' }, 429);
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const up = env.DB.prepare(
    "INSERT OR REPLACE INTO rooms (room_key, building, room, building_abbr, expected_count, requires_programs, prog_nums, updated_at) " +
    "VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))"
  );
  const delApps = env.DB.prepare('DELETE FROM room_apps WHERE room_key = ?');
  const insApp = env.DB.prepare('INSERT OR IGNORE INTO room_apps (room_key, app_id) VALUES (?,?)');
  // Build ONE statement group per room (upsert + delete-apps + re-insert-apps) and
  // never split a group across batch() calls — otherwise a room's DELETE could commit
  // in one transaction and its re-inserts fail/evict in the next, leaving it app-less.
  let pending = [], n = 0, nApps = 0, nRooms = 0;
  const flush = async () => { if (pending.length) { await env.DB.batch(pending); pending = []; } };
  for (const r of arr) {
    if (!r || !r.building || !r.room) continue;
    const key = clean(r.building, 16) + clean(r.room, 16);   // "55"+"103" -> "10101", matches the hostname parse
    let progNums = null;
    if (Array.isArray(r.prog_nums)) { try { progNums = JSON.stringify(r.prog_nums.map((x) => x | 0).filter((x) => x > 0).slice(0, 500)); } catch { progNums = null; } }
    const group = [up.bind(key, clean(r.building, 16), clean(r.room, 16), clean(r.building_abbr, 40),
      Number.isFinite(+r.expected_count) ? (+r.expected_count | 0) : 0, r.requires_programs ? 1 : 0, progNums)];
    if (Array.isArray(r.apps)) {
      group.push(delApps.bind(key));
      for (const a of r.apps.slice(0, 200)) {
        const id = clean(a, 128);
        if (id) { group.push(insApp.bind(key, id)); nApps++; }
      }
    }
    if (pending.length && pending.length + group.length > 200) await flush();
    pending.push(...group); n += group.length; nRooms++;
  }
  await flush();
  logStep('rooms.upsert', { stick: tok.stick_id, rooms: nRooms, stmts: n, apps: nApps });
  return json({ ok: true, upserted: nRooms, stmts: n, apps: nApps });
}

// POST /marks — FULL REPLACE of the tech marks (broken / reported-missing) so the
// dashboard shows the same blue / blue-with-X, and un-marking clears cleanly.
async function handleMarksPost(request, env, ctx, tok) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const arr = Array.isArray(body) ? body : (body && Array.isArray(body.marks) ? body.marks : null);
  if (!arr) return json({ ok: false, error: 'expected {marks:[...]}' }, 400);
  if (!(await rateOk(env, tok.id))) return json({ ok: false, error: 'rate limited' }, 429);
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const stmts = [env.DB.prepare('DELETE FROM marks')];
  // ts is the mark's OWN assertion time (local wall-clock) so newest-sighting-wins can
  // compare it to observation ts. If the master sends no ts we store '' — which the fold
  // treats as OLDEST (loses to any real sighting). We must NOT stamp server-now here:
  // the Worker's UTC clock would string-compare as newer than a genuine local sighting
  // and wrongly keep a machine blue after a stick has seen it.
  const ins = env.DB.prepare('INSERT OR REPLACE INTO marks (machine, state, ts, by, note) VALUES (?,?,?,?,?)');
  for (const m of arr) {
    if (m && m.machine && (m.state === 'broken' || m.state === 'missing')) {
      stmts.push(ins.bind(clean(m.machine, 128), m.state, clean(m.ts, 40), clean(m.by, 64) || 'master', clean(m.note, 240) || null));
    }
  }
  await env.DB.batch(stmts);
  logStep('marks.replace', { stick: tok.stick_id, marks: stmts.length - 1 });
  return json({ ok: true, marks: stmts.length - 1 });
}

// GET /marks — the master's full-replace tech marks (debugging / master cross-check). The
// dashboard reads marks straight from D1; this route just exposes them over the API.
async function handleMarksGet(env) {
  const rows = (await env.DB.prepare('SELECT machine, state, ts, by, note FROM marks').all()).results || [];
  return json({ ok: true, marks: rows });
}

// POST /config — the master mirrors its authored config here (see CONFIG_KEYS). The
// Worker stores opaque JSON; it never interprets it. Master-only in practice (any valid
// token can write, but only the master ever calls this). key must be a known config key.
// Body: { config: [ { key, value }, ... ] } — value may be an object or a JSON string.
async function handleConfigPost(request, env, ctx, tok) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const arr = Array.isArray(body) ? body : (body && Array.isArray(body.config) ? body.config : null);
  if (!arr) return json({ ok: false, error: 'expected {config:[{key,value}]}' }, 400);
  if (!(await rateOk(env, tok.id))) return json({ ok: false, error: 'rate limited' }, 429);
  const up = env.DB.prepare(
    "INSERT OR REPLACE INTO config_kv (key, json, updated_at) VALUES (?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))");
  const stmts = [];
  let skipped = 0;
  for (const c of arr) {
    if (!c || !CONFIG_KEYS.has(String(c.key))) { skipped++; continue; }
    // value may be a JSON string or an object; store as a compact JSON string either way.
    let jsonStr;
    try { jsonStr = typeof c.value === 'string' ? c.value : JSON.stringify(c.value); } catch { skipped++; continue; }
    const cap = CONFIG_KEY_BYTES[String(c.key)] || MAX_CONFIG_BYTES;
    if (jsonStr == null || jsonStr.length > cap) {
      await raiseAlert(env, ctx, 'warn', 'oversized-config', `config '${c.key}' ${jsonStr ? jsonStr.length : 0} bytes > cap ${cap}`, { stick_id: tok.stick_id, token_id: tok.id });
      skipped++; continue;
    }
    stmts.push(up.bind(String(c.key), jsonStr));
  }
  if (stmts.length) await env.DB.batch(stmts);
  logStep('config.upsert', { stick: tok.stick_id, keys: stmts.length, skipped });
  return json({ ok: true, keys: stmts.length, skipped });
}

// SHA-1 hex (Web Crypto) — used for the deterministic mark-request id.
async function sha1Hex(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// POST /mark-request — a whitelisted user (from a stick) asks to set a box's state.
// Recorded as an APPEND-ONLY fact in mark_requests (NOT the full-replace marks table).
// applied=1 only if the requester is on the master-pushed whitelist; the dashboard folds
// applied requests under newest-sighting-wins. Identity is self-reported (design §6.5) —
// this is routing, not hard permission; a wrong dashboard self-heals on the next sighting.
async function handleMarkRequestPost(request, env, ctx, tok) {
  let m;
  try { m = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!m || typeof m !== 'object') return json({ ok: false, error: 'expected a request object' }, 400);
  if (!(await rateOk(env, tok.id))) return json({ ok: false, error: 'rate limited' }, 429);
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const machine = clean(m.machine, 128);
  const state = String(m.state || '');
  const by = clean(m.by, 64);
  const ts = clean(m.ts, 40);
  const note = clean(m.note, 240) || null;
  if (!machine || !by || !ts || !MARK_REQ_STATES.has(state)) {
    return json({ ok: false, error: 'need machine, by, ts, and a valid state' }, 400);
  }
  // whitelist check against the master-pushed config_kv['whitelist'] = {users:[...]}.
  let applied = 0;
  try {
    const row = await env.DB.prepare('SELECT json FROM config_kv WHERE key = ?').bind('whitelist').first();
    if (row && row.json) {
      const wl = JSON.parse(row.json);
      const users = Array.isArray(wl) ? wl : (wl && Array.isArray(wl.users) ? wl.users : []);
      applied = users.map((u) => String(u).toLowerCase()).includes(by.toLowerCase()) ? 1 : 0;
    }
  } catch { applied = 0; }
  if (!applied) {
    await raiseAlert(env, ctx, 'warn', 'mark-request-denied',
      `'${by}' requested ${state} on ${machine} but is not whitelisted`, { stick_id: tok.stick_id, machine, token_id: tok.id });
  }
  const reqId = (await sha1Hex(`${by}|${machine}|${state}|${ts}`)).slice(0, 40);
  await env.DB.prepare(
    'INSERT OR IGNORE INTO mark_requests (req_id, machine, state, by, note, ts, stick_id, applied) VALUES (?,?,?,?,?,?,?,?)'
  ).bind(reqId, machine, state, by, note, ts, tok.stick_id, applied).run();
  logStep('mark_request', { stick: tok.stick_id, by, machine, state, applied });
  return json({ ok: true, req_id: reqId, applied: !!applied });
}

// GET /mark-requests?since=<received_at> — applied requests newest-first, for the master pull.
async function handleMarkRequestsGet(request, env, tok) {
  const u = new URL(request.url);
  const since = (u.searchParams.get('since') || '').slice(0, 40);
  const rows = (await env.DB.prepare(
    'SELECT req_id, machine, state, by, note, ts, received_at FROM mark_requests WHERE applied = 1 AND received_at > ? ORDER BY received_at ASC LIMIT 5000'
  ).bind(since || '').all()).results || [];
  logStep('mark_requests.pull', { stick: tok.stick_id, since, rows: rows.length });
  return json({ ok: true, requests: rows });
}

async function handleLogGet(env, obsId) {
  if (!env.LOGS) return json({ ok: false, error: 'log storage (R2) not enabled yet' }, 503);
  const row = await env.DB.prepare('SELECT r2_key FROM logs WHERE obs_id = ?').bind(obsId).first();
  if (!row) return json({ ok: false, error: 'not found' }, 404);
  const obj = await env.LOGS.get(row.r2_key);
  if (!obj) return json({ ok: false, error: 'blob missing' }, 404);
  return new Response(obj.body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// CORS for the one browser-origin write path (the Software Auditor form on the
// dashboard posts cross-origin to this Worker; Pages 405s non-GET, so it can't go there).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
function corsJson(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });
}

// POST /audit — EXPERIMENTAL Software Auditor form (theFuture item 18). Unauthenticated
// (the auditor is not a stick) + rate-limited under a reserved bucket. A dumb append
// store: who/department/room + opaque JSON rows. Nothing acts on it.
async function handleAuditPost(request, env, ctx) {
  let b;
  try { b = await request.json(); } catch { return corsJson({ ok: false, error: 'bad json' }, 400); }
  if (!b || typeof b !== 'object') return corsJson({ ok: false, error: 'expected an object' }, 400);
  // per-IP rate bucket; alert only on the FIRST trip of a bucket so a flood can't
  // amplify into unbounded D1 writes + webhook posts.
  const c = await rateCount(env, ipBucketId(request));
  if (c > MAX_REQUESTS_PER_MIN) {
    if (c === MAX_REQUESTS_PER_MIN + 1) await raiseAlert(env, ctx, 'warn', 'audit-rate', 'audit submissions over rate from one IP', {});
    return corsJson({ ok: false, error: 'rate limited' }, 429);
  }
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const by = clean(b.by, 120), department = clean(b.department, 120), room = clean(b.room, 120);
  let payload;
  try { payload = JSON.stringify(Array.isArray(b.rows) ? b.rows : []); } catch { payload = '[]'; }
  if (payload.length > 100000) return corsJson({ ok: false, error: 'payload too large' }, 413);
  if (!by && !room) return corsJson({ ok: false, error: 'need at least your name or a room' }, 400);
  try {
    await env.DB.prepare('INSERT INTO audit_submissions (by, department, room, payload) VALUES (?,?,?,?)').bind(by, department, room, payload).run();
  } catch (e) { return corsJson({ ok: false, error: 'store failed' }, 500); }
  let nrows = 0; try { nrows = (JSON.parse(payload) || []).length; } catch {}
  logStep('audit.submit', { by, room, rows: nrows });
  return corsJson({ ok: true });
}

// PAUSE SWITCH: true = every route (including /health) answers a bare 404, same
// as the paused dashboard. Nothing is deleted — D1 and tokens stay intact. Client-
// side this is safe by design: a failed push never advances the client's push
// cursor, so every session log queues locally and backfills on the first
// successful push after unpausing. Flip to false and redeploy to resume.
const PAUSED = false;

export default {
  async fetch(request, env, ctx) {
    if (PAUSED) {
      return new Response('404 Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    logStep('request', { method: request.method, path });

    if (path === '/health' && request.method === 'GET') {
      return json({ ok: true, service: 'labboard-api', ts: new Date().toISOString() });
    }
    // Software Auditor form (unauthenticated, CORS) — before the token gate.
    if (path === '/audit' && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/audit' && request.method === 'POST') return handleAuditPost(request, env, ctx);

    const tok = await authToken(request, env);
    if (!tok) { logStep('auth.reject', { method: request.method, path }); return json({ ok: false, error: 'unauthorized' }, 401); }

    if (path === '/obs' && request.method === 'POST') return handleObsPost(request, env, ctx, tok);
    if (path === '/rooms' && request.method === 'POST') return handleRoomsPost(request, env, ctx, tok);
    if (path === '/marks' && request.method === 'POST') return handleMarksPost(request, env, ctx, tok);
    if (path === '/marks' && request.method === 'GET') return handleMarksGet(env);
    if (path === '/config' && request.method === 'POST') return handleConfigPost(request, env, ctx, tok);
    if (path === '/mark-request' && request.method === 'POST') return handleMarkRequestPost(request, env, ctx, tok);
    if (path === '/mark-requests' && request.method === 'GET') return handleMarkRequestsGet(request, env, tok);
    if (path === '/log' && request.method === 'POST') return handleLogPost(request, env, ctx, tok);
    if (path.startsWith('/log/') && request.method === 'GET') return handleLogGet(env, decodeURIComponent(path.slice(5)));
    if (path === '/obs' && request.method === 'GET') return json({ ok: false, error: 'not implemented yet' }, 501); // Phase 2

    return json({ ok: false, error: 'not found' }, 404);
  },
};
