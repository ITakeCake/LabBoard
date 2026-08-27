// GET /api/auditinfo?room=<key> — prefill data for the Software Auditor form
// (theFuture lines 46-53). Returns the room's expected programs (master-pushed
// room_apps) plus, per program, the most recent NOTE from earlier audit
// submissions for that room — that is the "[Current Instructions + Notes from
// last year]" column: each year's audit feeds the next one's.
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const room = (url.searchParams.get('room') || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  if (!room) return json({ ok: false, error: 'need ?room=' }, 400);
  try {
    const apps = ((await env.DB.prepare('SELECT app_id FROM room_apps WHERE room_key = ? ORDER BY app_id')
      .bind(room).all()).results || []).map((r) => r.app_id);
    // newest submissions first; the FIRST note seen per program wins (most recent)
    const subs = (await env.DB.prepare(
      'SELECT by, payload, received_at FROM audit_submissions WHERE room = ? ORDER BY received_at DESC LIMIT 20')
      .bind(room).all()).results || [];
    const prev = {};
    for (const s of subs) {
      let rows = [];
      try { rows = JSON.parse(s.payload) || []; } catch { continue; }
      for (const r of rows) {
        const p = String(r && r.program || '').trim();
        if (!p || prev[p]) continue;
        const note = String(r && r.notes || '').trim();
        const cur = String(r && r.current || '').trim();
        if (note || cur) prev[p] = { note, current: cur, by: s.by || '', at: (s.received_at || '').slice(0, 10) };
      }
    }
    return json({ ok: true, room, apps, prev });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
