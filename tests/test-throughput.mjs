// node tests/test-throughput.mjs — the Timing/throughput fold, no D1 needed.
import { foldThroughput, MIN_GAP_SECS } from '../pages/functions/api/_throughput.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('PASS ' + msg); } else { fail++; console.log('FAIL ' + msg); } };

const roomApps = [
  { room_key: '10103', app_id: 'A' },
  { room_key: '10103', app_id: 'B' },
];
const M = '10103LAB30-22';

// --- 1. a clean complete machine ---
{
  const firsts = [
    { machine: M, app_id: 'A', ts: '2026-08-20T11:20:00.000' },
    { machine: M, app_id: 'B', ts: '2026-08-20T11:35:00.000' },
    { machine: M, app_id: '__gp__', ts: '2026-08-20T11:23:00.000' },
    { machine: M, app_id: '__cm__', ts: '2026-08-20T11:24:00.000' },
  ];
  const obs = [
    { machine: M, ts: '2026-08-20T11:06:00.000' },
    { machine: M, ts: '2026-08-20T11:20:00.000' },
    { machine: M, ts: '2026-08-20T11:35:00.000' },
  ];
  const r = foldThroughput(firsts, obs, roomApps);
  ok(r.machines.length === 1, 'complete machine folds to one record');
  const m = r.machines[0];
  ok(m.start === '2026-08-20T11:06:00.000', 'start = earliest observation of ANY kind');
  ok(m.finish === '2026-08-20T11:35:00.000', 'finish = latest first-install across the need set');
  ok(m.secs === 29 * 60, 'duration = finish - start (29 min)');
  ok(m.apps.length === 4 && m.apps[0].app === 'A', 'app timeline present, sorted by install time');
}

// --- 2. missing __cm__ -> incomplete, never listed ---
{
  const firsts = [
    { machine: M, app_id: 'A', ts: '2026-08-20T11:20:00.000' },
    { machine: M, app_id: 'B', ts: '2026-08-20T11:35:00.000' },
    { machine: M, app_id: '__gp__', ts: '2026-08-20T11:23:00.000' },
  ];
  const obs = [{ machine: M, ts: '2026-08-20T11:06:00.000' }];
  const r = foldThroughput(firsts, obs, roomApps);
  ok(r.machines.length === 0 && r.incomplete === 1, 'machine missing GP/CM or an app counts incomplete');
}

// --- 3. no roster list -> unjudgeable, not silently "complete" ---
{
  const r = foldThroughput([], [{ machine: '99999LATS30-01', ts: '2026-08-20T11:06:00.000' }], roomApps);
  ok(r.machines.length === 0 && r.unjudgeable === 1, 'machine with no roster app list is unjudgeable');
}

// --- 4. gap detection: only >= 30 min, clipped to finish, original wall-clock kept ---
{
  const firsts = [
    { machine: M, app_id: 'A', ts: '2026-08-20T09:05:00.000' },
    { machine: M, app_id: 'B', ts: '2026-08-20T13:00:00.000' },
    { machine: M, app_id: '__gp__', ts: '2026-08-20T09:06:00.000' },
    { machine: M, app_id: '__cm__', ts: '2026-08-20T09:07:00.000' },
  ];
  const obs = [
    { machine: M, ts: '2026-08-20T09:00:00.000' },
    { machine: M, ts: '2026-08-20T09:10:00.000' },   // then 3.5h of silence (lunch)
    { machine: M, ts: '2026-08-20T12:40:00.000' },
    { machine: M, ts: '2026-08-20T13:00:00.000' },
    { machine: M, ts: '2026-08-20T18:00:00.000' },   // AFTER finish - must not count
  ];
  const r = foldThroughput(firsts, obs, roomApps);
  const m = r.machines[0];
  ok(m.gaps.length === 1, 'one gap >= 30 min (small pauses + post-finish silence ignored)');
  ok(m.gaps[0].secs === 3.5 * 3600, 'gap length 3.5h');
  ok(m.gaps[0].at === '2026-08-20T09:10', "gap 'at' is the stick's own wall-clock string, not re-zoned");
  ok(MIN_GAP_SECS === 1800, 'gap floor is 30 min so a 1h client threshold always has candidates');
}

// --- 5. slowest-first ordering ---
{
  const mk = (name, startH, finishH) => ({
    firsts: [
      { machine: name, app_id: 'A', ts: `2026-08-20T${finishH}:00:00.000` },
      { machine: name, app_id: 'B', ts: `2026-08-20T${startH}:30:00.000` },
      { machine: name, app_id: '__gp__', ts: `2026-08-20T${startH}:20:00.000` },
      { machine: name, app_id: '__cm__', ts: `2026-08-20T${startH}:21:00.000` },
    ],
    obs: [{ machine: name, ts: `2026-08-20T${startH}:00:00.000` }],
  });
  const a = mk('10103LAB30-01', '09', '10'), b = mk('10103LAB30-02', '09', '12');
  const r = foldThroughput(a.firsts.concat(b.firsts), a.obs.concat(b.obs), roomApps);
  ok(r.machines[0].machine === '10103LAB30-02', 'slowest machine sorts first');
}

// --- 6. generation partition: a re-imaged machine never inherits its old life ---
{
  const firsts = [
    // OLD life: fully complete
    { machine: M, app_id: 'A', ts: '2026-08-04T10:00:00.000', imaged_gen: '2026-08-03' },
    { machine: M, app_id: 'B', ts: '2026-08-04T10:10:00.000', imaged_gen: '2026-08-03' },
    { machine: M, app_id: '__gp__', ts: '2026-08-04T10:20:00.000', imaged_gen: '2026-08-03' },
    { machine: M, app_id: '__cm__', ts: '2026-08-04T10:21:00.000', imaged_gen: '2026-08-03' },
    // NEW life: only gp/cm so far
    { machine: M, app_id: '__gp__', ts: '2026-08-20T14:48:00.000', imaged_gen: '2026-08-19' },
    { machine: M, app_id: '__cm__', ts: '2026-08-20T14:42:00.000', imaged_gen: '2026-08-19' },
  ];
  const obs = [
    { machine: M, ts: '2026-08-04T09:00:00.000', imaged_gen: '2026-08-03' },
    { machine: M, ts: '2026-08-20T14:40:00.000', imaged_gen: '2026-08-19' },
    { machine: M, ts: '2026-08-20T14:48:00.000', imaged_gen: '2026-08-19' },
  ];
  const r = foldThroughput(firsts, obs, roomApps);
  ok(r.machines.length === 0 && r.incomplete === 1, 're-imaged machine is NOT complete off its old life');
}
{
  // new life completes on its own -> start/duration come from the NEW life only
  const firsts = [
    { machine: M, app_id: 'A', ts: '2026-08-04T10:00:00.000', imaged_gen: '2026-08-03' },
    { machine: M, app_id: 'A', ts: '2026-08-20T15:00:00.000', imaged_gen: '2026-08-19' },
    { machine: M, app_id: 'B', ts: '2026-08-20T15:10:00.000', imaged_gen: '2026-08-19' },
    { machine: M, app_id: '__gp__', ts: '2026-08-20T14:48:00.000', imaged_gen: '2026-08-19' },
    { machine: M, app_id: '__cm__', ts: '2026-08-20T14:42:00.000', imaged_gen: '2026-08-19' },
  ];
  const obs = [
    { machine: M, ts: '2026-08-04T09:00:00.000', imaged_gen: '2026-08-03' },
    { machine: M, ts: '2026-08-20T14:40:00.000', imaged_gen: '2026-08-19' },
    { machine: M, ts: '2026-08-20T15:10:00.000', imaged_gen: '2026-08-19' },
  ];
  const r = foldThroughput(firsts, obs, roomApps);
  ok(r.machines.length === 1, 'new life completes on its own evidence');
  ok(r.machines[0].start === '2026-08-20T14:40:00.000', 'start is the NEW life first obs, not the old life');
  ok(r.machines[0].secs === 30 * 60, 'duration measured within the new life (30 min)');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
