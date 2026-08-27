// Shared throughput fold — pure function so tests/test-throughput.mjs can hit it
// without a D1. Same completion rule as stats.js doneMetrics, but at FULL
// timestamp resolution: a machine is complete when every roster app for its room
// (plus __gp__ + __cm__) has a first-'installed' time; finish = the LATEST of
// those firsts, start = the machine's earliest observation of any kind.
//
// Gaps: quiet stretches between consecutive observations of one machine, start
// to finish only. Only gaps >= MIN_GAP_SECS ship to the client (the "ignore
// gaps > X hours" checkbox needs candidates, not every 40s pause between
// installers), capped at MAX_GAPS longest per machine.

export const MIN_GAP_SECS = 30 * 60;
export const MAX_GAPS = 24;

// ts strings are LOCAL wall-clock 'yyyy-MM-ddTHH:mm:ss.fff' — parse consistently;
// only DIFFERENCES are used, so the missing zone offset cancels out.
const t = (s) => { const n = Date.parse(s || ''); return Number.isFinite(n) ? n : null; };

// firstInstalled: [{machine, app_id, ts, imaged_gen}] — MIN(ts) per machine+app+gen, verdict='installed'
// allObs:         [{machine, ts, imaged_gen}]         — every observation, any verdict
// roomApps:       [{room_key, app_id}]                — master-pushed roster app lists
//
// GENERATION PARTITION (2026-08-20): machine identity is (hostname, image date). Only
// the NEWEST generation's rows count — a re-imaged machine must never inherit start
// times, installs, or gaps from its previous life.
export function foldThroughput(firstInstalled, allObs, roomApps) {
  const appsBy = {};
  for (const a of roomApps || []) (appsBy[a.room_key] = appsBy[a.room_key] || []).push(a.app_id);

  // newest generation per machine = the imaged_gen on its newest observation
  const genBy = {}, genTs = {};
  for (const o of allObs || []) {
    const n = t(o.ts);
    if (n === null) continue;
    if (!(o.machine in genTs) || n > genTs[o.machine]) { genTs[o.machine] = n; genBy[o.machine] = String(o.imaged_gen == null ? '' : o.imaged_gen); }
  }
  const inGen = (m, g) => String(g == null ? '' : g) === (genBy[m] || '');

  const doneBy = {};
  for (const r of firstInstalled || []) { if (inGen(r.machine, r.imaged_gen)) (doneBy[r.machine] = doneBy[r.machine] || {})[r.app_id] = r.ts; }

  const tsBy = {};
  for (const o of allObs || []) { if (inGen(o.machine, o.imaged_gen)) (tsBy[o.machine] = tsBy[o.machine] || []).push(o.ts); }

  const machines = [];
  let incomplete = 0, unjudgeable = 0;
  for (const machine of Object.keys(tsBy)) {
    const rk = (/^(\d+)[A-Za-z]/.exec(machine) || [])[1] || '';
    const expected = rk && appsBy[rk] ? appsBy[rk] : null;
    if (!expected) { unjudgeable++; continue; }        // no roster list -> can't judge "done"
    const got = doneBy[machine] || {};
    const need = expected.concat(['__gp__', '__cm__']);
    let finish = null, finishT = -Infinity, complete = true;
    for (const a of need) {
      const ts = got[a], tt = t(ts);
      if (!ts || tt === null) { complete = false; break; }
      if (tt > finishT) { finishT = tt; finish = ts; }
    }
    if (!complete) { incomplete++; continue; }

    // keep the ORIGINAL wall-clock strings alongside the parsed times — a gap's
    // "at" must ship back as the string the stick logged, never re-serialised
    // through Date (the ts has no zone offset; toISOString would shift it).
    const stamped = tsBy[machine].map((s) => ({ s, n: t(s) })).filter((x) => x.n !== null).sort((a, b) => a.n - b.n);
    if (!stamped.length) { incomplete++; continue; }
    const startT = stamped[0].n, start = stamped[0].s;

    // gaps between consecutive observations, clipped to [start, finish]
    const gaps = [];
    for (let i = 1; i < stamped.length; i++) {
      const a = stamped[i - 1], b = stamped[i];
      if (a.n >= finishT) break;
      const secs = Math.round((Math.min(b.n, finishT) - a.n) / 1000);
      if (secs >= MIN_GAP_SECS) gaps.push({ at: a.s.slice(0, 16), secs });
    }
    gaps.sort((a, b) => b.secs - a.secs);
    const kept = gaps.slice(0, MAX_GAPS);

    // app timeline: first-installed moment of every roster app that has one
    const apps = [];
    for (const a of expected.concat(['__gp__', '__cm__'])) if (got[a]) apps.push({ app: a, ts: got[a] });
    apps.sort((x, y) => (t(x.ts) || 0) - (t(y.ts) || 0));

    machines.push({
      machine, rk, start, finish,
      secs: Math.max(0, Math.round((finishT - startT) / 1000)),
      gaps: kept, apps,
    });
  }
  machines.sort((a, b) => b.secs - a.secs);
  return { machines, incomplete, unjudgeable };
}
