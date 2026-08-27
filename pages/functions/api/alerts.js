// GET /api/alerts — recent anomaly alerts for the dashboard banner.
// Basic Auth enforced by functions/_middleware.js. Newest first; the banner shows
// the ones that are still unacknowledged.
export async function onRequest(context) {
  const { env } = context;
  try {
    const r = await env.DB.prepare(
      'SELECT id, level, kind, detail, stick_id, machine, ts, acknowledged FROM alerts ORDER BY ts DESC LIMIT 50'
    ).all();
    const rows = r.results || [];
    const openCount = rows.filter((a) => !a.acknowledged).length;
    return new Response(JSON.stringify({ ok: true, alerts: rows, openCount }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message ? e.message : e) }), {
      status: 500, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}
