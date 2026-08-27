// POST /api/admin/note — set (or clear) the free-form note on ONE machine FROM THE
// DASHBOARD. Behind the same Basic Auth + X-Requested-With guard as the other admin
// POSTs (functions/_middleware.js). Append-only into machine_notes; fleet.js/image.js
// fold the NEWEST note per machine under newest-ts-wins, so editing is just a fresh row
// and clearing is an empty note. A note is ORTHOGONAL to a mark — it never recolours a
// tile; it's a tech's scratchpad ("cracked screen", "missing from cart 3").
//   machine: "10103LAB30-06"  OR a never-seen slot key "10101#7"
//   note:    free text (empty string clears it)
//   ts:      caller's LOCAL wall-clock (matches observation/mark ts so newest-wins compares right)
export async function onRequest(context) {
  const { env, request } = context;
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  const clean = (s, n) => (s == null ? '' : String(s)).slice(0, n);
  const machine = clean(b.machine, 128);
  if (!machine) return json({ ok: false, error: 'need machine' }, 400);
  const note = clean(b.note, 500);   // may be '' — that clears the note

  // who: derive from the Basic Auth user (unspoofable), never a client field.
  let by = 'dashboard';
  try {
    const h = request.headers.get('Authorization') || '';
    if (h.startsWith('Basic ')) { const d = atob(h.slice(6).trim()); const i = d.indexOf(':'); by = (i > 0 ? d.slice(0, i) : 'dashboard'); }
  } catch {}
  by = clean(by, 64) || 'dashboard';
  const ts = clean(b.ts, 40) || new Date().toISOString().slice(0, 23);

  const sha1 = async (s) => {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 40);
  };
  const noteId = await sha1(`${by}|${machine}|${ts}`);
  try {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO machine_notes (note_id, machine, note, by, ts) VALUES (?,?,?,?,?)')
      .bind(noteId, machine, note, by, ts).run();
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
  return json({ ok: true, machine, by, cleared: note === '' });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
