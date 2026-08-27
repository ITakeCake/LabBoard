// GET /api/feed[?limit=] — recent activity, newest first (theFuture item 10):
// "[machine] installed X" / "[machine] error Y". Ordered by the server's received_at
// so it reflects when the fact arrived. Excludes the __gp__/__cm__ pseudo-apps and
// bulk 'snapshot' rows (those are inventory, not events). Read-only.
export async function onRequest(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '60', 10) || 60, 200);
  try {
    const feed = (await env.DB.prepare(
      "SELECT machine, app_id, verdict, code, ts, received_at, stick_id FROM observations " +
      "WHERE app_id NOT IN ('__gp__','__cm__') AND verdict IN ('installed','error','removed') " +
      "ORDER BY received_at DESC, id DESC LIMIT ?").bind(limit).all()).results || [];
    return json({ ok: true, feed });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
