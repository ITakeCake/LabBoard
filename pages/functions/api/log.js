// GET /api/log?id=<obs_id> — fetch a failed-install log blob for the dashboard.
// Basic Auth is enforced by functions/_middleware.js. Reads the r2_key recorded in
// D1, then the blob from R2 (both bound to this Pages project). Plain text out.
export async function onRequest(context) {
  const { env, request } = context;
  if (!env.LOGS) return new Response('log storage (R2) not enabled yet', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return new Response('missing id', { status: 400, headers: { 'Content-Type': 'text/plain' } });
  const row = await env.DB.prepare('SELECT r2_key, truncated FROM logs WHERE obs_id = ?').bind(id).first();
  if (!row) return new Response('no log for this observation', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const obj = await env.LOGS.get(row.r2_key);
  if (!obj) return new Response('log blob missing', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const note = row.truncated ? '*** capped for transport: 16 KB head + tail up to 1 MB; middle removed ***\n\n' : '';
  const text = await obj.text();
  return new Response(note + text, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
