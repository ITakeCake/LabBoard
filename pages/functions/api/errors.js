// GET /api/errors — error leaderboard (theFuture item 7). Two views:
//   A) most common error codes + which machine hits each the most.
//   B) which programs threw the most errors (and across how many machines).
// Counts are over ALL error observations (a recurring error is the point of a
// leaderboard). Read-only over the append-only observations table.
export async function onRequest(context) {
  const { env } = context;
  try {
    const byCode = (await env.DB.prepare(
      "SELECT code, COUNT(*) AS n, COUNT(DISTINCT machine) AS machines FROM observations " +
      "WHERE verdict='error' AND code IS NOT NULL AND code<>'' GROUP BY code ORDER BY n DESC LIMIT 25").all()).results || [];
    const worstMachineByCode = (await env.DB.prepare(
      "SELECT code, machine, n FROM (SELECT code, machine, COUNT(*) AS n, " +
      "ROW_NUMBER() OVER (PARTITION BY code ORDER BY COUNT(*) DESC, machine) AS rn " +
      "FROM observations WHERE verdict='error' AND code IS NOT NULL AND code<>'' GROUP BY code, machine) " +
      "WHERE rn=1").all()).results || [];
    const byApp = (await env.DB.prepare(
      "SELECT app_id, COUNT(*) AS n, COUNT(DISTINCT machine) AS machines FROM observations " +
      "WHERE verdict='error' GROUP BY app_id ORDER BY n DESC LIMIT 25").all()).results || [];
    const byMachine = (await env.DB.prepare(
      "SELECT machine, COUNT(*) AS n FROM observations WHERE verdict='error' GROUP BY machine ORDER BY n DESC LIMIT 25").all()).results || [];
    // stitch the worst machine onto each code row
    const worst = {};
    for (const w of worstMachineByCode) worst[w.code] = { machine: w.machine, n: w.n };
    for (const r of byCode) { const w = worst[r.code]; r.worstMachine = w ? w.machine : ''; r.worstMachineN = w ? w.n : 0; }
    return json({ ok: true, byCode, byApp, byMachine });
  } catch (e) { return json({ ok: false, error: String(e && e.message ? e.message : e) }, 500); }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
