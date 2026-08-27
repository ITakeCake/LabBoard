// Unit tests for the load-bearing newest-sighting-wins fold (pages/functions/api/_fleetfold.js).
// Pure JS, no D1 — run: node tests/test-fleetfold.mjs   (exit 0 = all pass)
import assert from 'node:assert';
import { foldFleet, overrideTile, pageForGen, normalizeAssignments } from '../pages/functions/api/_fleetfold.js';

let pass = 0, fail = 0;
function ok(name, fn) { try { fn(); pass++; console.log('  ok  ' + name); } catch (e) { fail++; console.log('FAIL  ' + name + '\n      ' + e.message); } }

// helper: find a machine's folded object in the room slots
function findM(out, machine) {
  for (const room of out.rooms) for (const s of room.slots) if (s.machine === machine) return s;
  return null;
}
// a fully-green observed machine at time ts (installed app + gp + cm)
function green(machine, ts, stick = 's1') {
  return [
    { machine, app_id: 'appX', verdict: 'installed', ts, stick_id: stick, obs_id: machine + '-x' },
    { machine, app_id: '__gp__', verdict: 'installed', ts, stick_id: stick, obs_id: machine + '-gp' },
    { machine, app_id: '__cm__', verdict: 'installed', ts, stick_id: stick, obs_id: machine + '-cm' },
  ];
}

// sanity: tile mapping
ok('overrideTile maps states', () => {
  assert.equal(overrideTile('broken'), 'broken');
  assert.equal(overrideTile('missing'), 'blue');
  assert.equal(overrideTile('verified'), 'green');
  assert.equal(overrideTile('override'), 'green');
  assert.equal(overrideTile('clear'), null);
  assert.equal(overrideTile('wat'), null);
});

// A — observation NEWER than mark => observation wins (mark does NOT override)
ok('obs newer than mark -> observed green kept', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    markRows: [{ machine: '55A-1', state: 'missing', ts: '2026-08-01T09:00:00', by: 'admin', note: 'old' }],
  });
  assert.equal(findM(out, '55A-1').state, 'green');
});

// B — mark NEWER than observation => mark wins (blue), provenance carried
ok('mark newer than obs -> blue + provenance', () => {
  const out = foldFleet({
    results: green('55A-2', '2026-08-10T10:00:00'),
    markRows: [{ machine: '55A-2', state: 'missing', ts: '2026-08-15T09:00:00', by: 'admin', note: 'reported missing' }],
  });
  const m = findM(out, '55A-2');
  assert.equal(m.state, 'blue');
  assert.equal(m.markBy, 'admin');
  assert.equal(m.markNote, 'reported missing');
});

// C — request on a NEVER-observed machine surfaces as a tile (broken)
ok('request on unseen machine -> broken tile appears', () => {
  const out = foldFleet({
    results: [],
    reqRows: [{ machine: '55A-9', state: 'broken', ts: '2026-08-16T12:00:00', by: 'admin', note: 'phys broke', applied: 1 }],
  });
  const m = findM(out, '55A-9');
  assert.ok(m, 'machine 55A-9 should exist');
  assert.equal(m.state, 'broken');
});

// D — a newest 'clear' cancels a would-be-blue mark => observed green kept
ok('clear (newest) cancels a newer mark -> green kept', () => {
  const out = foldFleet({
    results: green('55A-3', '2026-08-10T10:00:00'),
    markRows: [{ machine: '55A-3', state: 'missing', ts: '2026-08-12T09:00:00', by: 'admin' }],
    reqRows: [{ machine: '55A-3', state: 'clear', ts: '2026-08-20T09:00:00', by: 'admin', applied: 1 }],
  });
  assert.equal(findM(out, '55A-3').state, 'green');
});

// E — request 'verified' (newer) turns a yellow machine green
ok('verified request (newer) turns yellow -> green', () => {
  const out = foldFleet({
    results: [{ machine: '55A-4', app_id: 'appX', verdict: 'missing', ts: '2026-08-10T10:00:00', stick_id: 's1', obs_id: '4x' }],
    reqRows: [{ machine: '55A-4', state: 'verified', ts: '2026-08-11T10:00:00', by: 'admin', note: 'looks fine', applied: 1 }],
  });
  const m = findM(out, '55A-4');
  assert.equal(m.state, 'green');
  assert.equal(m.markBy, 'admin');
});

// F — tie between mark and request at equal ts => request wins (more intentional)
ok('equal-ts tie: request beats mark', () => {
  const out = foldFleet({
    results: green('55A-5', '2026-08-10T10:00:00'),
    markRows: [{ machine: '55A-5', state: 'missing', ts: '2026-08-15T09:00:00', by: 'master' }],
    reqRows: [{ machine: '55A-5', state: 'broken', ts: '2026-08-15T09:00:00', by: 'admin', applied: 1 }],
  });
  assert.equal(findM(out, '55A-5').state, 'broken');
});

// G — untouched roster slots still colour red (needs programs) / orange (gp-cm only)
ok('roster untouched slots colour red vs orange', () => {
  const out = foldFleet({
    results: [],
    roomRows: [
      { room_key: '55', building_abbr: 'ENG', expected_count: 2, requires_programs: 1 },
      { room_key: '60', building_abbr: 'LIB', expected_count: 2, requires_programs: 0 },
    ],
  });
  assert.equal(out.summary.red, 2);
  assert.equal(out.summary.orange, 2);
});

// --- year pages (item 5) --- cutoff is the master's 'o' roundtrip format (local + offset),
// imaged_gen is date-only. This fixture matches what the master REALLY sends.
const YPAGES = [{ label: 2026, cutoff: '' }, { label: 2027, cutoff: '2027-06-01T00:00:00.0000000-04:00' }];
ok('pageForGen: before cutoff -> older page', () => {
  assert.equal(String(pageForGen('2026-08-14', YPAGES, 2027)), '2026');
});
ok('pageForGen: after cutoff -> newer page', () => {
  assert.equal(String(pageForGen('2027-07-01', YPAGES, 2027)), '2027');
});
ok('pageForGen: imaged ON the cutoff day -> newer page (matches master, not UTC-shifted)', () => {
  assert.equal(String(pageForGen('2027-06-01', YPAGES, 2027)), '2027');
});
ok('pageForGen: no stamp -> current page', () => {
  assert.equal(String(pageForGen('', YPAGES, 2027)), '2027');
  assert.equal(String(pageForGen('not-a-date', YPAGES, 2027)), '2027');
});
ok('pageForGen: very old -> first page', () => {
  assert.equal(String(pageForGen('2020-01-01', YPAGES, 2027)), '2026');
});

function genMachine(machine, gen, ts = '2026-08-10T10:00:00') {
  return [
    { machine, app_id: 'appX', verdict: 'installed', ts, imaged_gen: gen, stick_id: 's1', obs_id: machine + '-x' },
    { machine, app_id: '__gp__', verdict: 'installed', ts, imaged_gen: gen, stick_id: 's1', obs_id: machine + '-gp' },
    { machine, app_id: '__cm__', verdict: 'installed', ts, imaged_gen: gen, stick_id: 's1', obs_id: machine + '-cm' },
  ];
}
const YEAR_RESULTS = [...genMachine('55A-1', '2026-08-14'), ...genMachine('55A-2', '2027-07-01')];

ok('year filter: 2026 keeps only the 2026-imaged machine', () => {
  const out = foldFleet({ results: YEAR_RESULTS, year: '2026', pages: YPAGES, currentYear: 2027 });
  assert.ok(findM(out, '55A-1'), '55A-1 should be present on 2026');
  assert.equal(findM(out, '55A-2'), null, '55A-2 should be filtered out on 2026');
});
ok('year filter: 2027 keeps only the 2027-imaged machine', () => {
  const out = foldFleet({ results: YEAR_RESULTS, year: '2027', pages: YPAGES, currentYear: 2027 });
  assert.ok(findM(out, '55A-2'), '55A-2 should be present on 2027');
  assert.equal(findM(out, '55A-1'), null, '55A-1 should be filtered out on 2027');
});
ok('year filter: untouched roster shows on current year only', () => {
  const roomRows = [{ room_key: '55', building_abbr: 'ENG', expected_count: 4, requires_programs: 1 }];
  const cur = foldFleet({ results: [], roomRows, year: '2027', pages: YPAGES, currentYear: 2027 });
  const past = foldFleet({ results: [], roomRows, year: '2026', pages: YPAGES, currentYear: 2027 });
  assert.equal(cur.summary.red, 4, 'current year shows the 4 untouched red slots');
  assert.equal(past.summary.red, 0, 'past year shows no untouched slots');
});
ok('no year param => no filtering (back-compat)', () => {
  const out = foldFleet({ results: YEAR_RESULTS });
  assert.ok(findM(out, '55A-1') && findM(out, '55A-2'), 'both machines present when year is null');
});

// --- re-image collision: two generations of the same physical slot (bug: one vanished) ---
ok('re-image: same room+num, two generations -> newest survives, count is 1', () => {
  const out = foldFleet({ results: [
    { machine: '10101LAB34-20', app_id: 'appX', verdict: 'installed', ts: '2026-01-01T10:00:00', imaged_gen: '2026-01-01', stick_id: 's1', obs_id: 'o-old' },
    { machine: '10101LAB35-20', app_id: 'appX', verdict: 'installed', ts: '2026-09-01T10:00:00', imaged_gen: '2026-09-01', stick_id: 's1', obs_id: 'o-new' },
  ] });
  const found = [];
  for (const room of out.rooms) for (const s of room.slots) if (s.machine) found.push(s.machine);
  assert.equal(found.length, 1, 'exactly one machine in the slot');
  assert.equal(found[0], '10101LAB35-20', 'the newer generation wins');
});

// --- per-slot red/orange from prog_nums (machines 1-2 need programs, 3-4 don't) ---
ok('untouched slots: red where number needs programs, orange where not', () => {
  const out = foldFleet({ results: [], roomRows: [
    { room_key: '10101', building_abbr: 'ENG', expected_count: 4, requires_programs: 1, prog_nums: '[1,2]' },
  ] });
  const room = out.rooms.find(r => r.room === '10101');
  const byNum = {}; for (const s of room.slots) byNum[s.num] = s.state;
  assert.equal(byNum[1], 'red');    assert.equal(byNum[2], 'red');
  assert.equal(byNum[3], 'orange'); assert.equal(byNum[4], 'orange');
  assert.equal(out.summary.red, 2); assert.equal(out.summary.orange, 2);
});
ok('no prog_nums -> falls back to the room-wide requires_programs flag', () => {
  const out = foldFleet({ results: [], roomRows: [
    { room_key: '60201', building_abbr: 'LIB', expected_count: 3, requires_programs: 0 },
  ] });
  assert.equal(out.summary.orange, 3);
  assert.equal(out.summary.red, 0);
});

// --- a never-seen slot can carry a mark, keyed "<room>#<num>" (item: mark red slots) ---
ok('slot-mark colours a never-seen untouched slot', () => {
  const out = foldFleet({
    results: [],
    roomRows: [{ room_key: '10101', building_abbr: 'ENG', expected_count: 3, requires_programs: 1 }],
    reqRows: [{ machine: '10101#2', state: 'broken', by: 'tech-a', ts: '2026-08-19T12:00:00', applied: 1 }],
  });
  const room = out.rooms.find(r => r.room === '10101');
  const byNum = {}; for (const s of room.slots) byNum[s.num] = s;
  assert.equal(byNum[2].state, 'broken', 'slot 2 is broken from its slot-mark');
  assert.equal(byNum[2].mark, 'broken');
  assert.equal(byNum[1].state, 'red', 'unmarked slots keep their computed colour');
  assert.equal(byNum[2].machine, '', 'slot-mark does not invent a hostname');
});
ok('slot-mark does not create a phantom machine tile', () => {
  const out = foldFleet({ results: [], reqRows: [{ machine: '10101#9', state: 'missing', by: 'x', ts: '2026-08-19T12:00:00', applied: 1 }] });
  // with no roster the room isn't sized to 9, so nothing renders - but crucially no
  // bogus "10101#9" machine tile is injected.
  let found = false; for (const r of out.rooms) for (const s of r.slots) if (s.machine === '10101#9') found = true;
  assert.equal(found, false);
});

// --- per-PC notes (free-form, orthogonal to marks) ---
ok('note attaches to an observed machine, never recolours it', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    noteRows: [{ machine: '55A-1', note: 'cracked screen', by: 'tech-a', ts: '2026-08-11T09:00:00' }],
  });
  const m = findM(out, '55A-1');
  assert.equal(m.state, 'green', 'note does not change colour');
  assert.equal(m.pcNote, 'cracked screen');
  assert.equal(m.pcNoteBy, 'tech-a');
});
ok('newest note wins; empty note clears', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    noteRows: [
      { machine: '55A-1', note: 'first', by: 'tech-a', ts: '2026-08-11T09:00:00' },
      { machine: '55A-1', note: '', by: 'tech-b', ts: '2026-08-12T09:00:00' },   // cleared, newer
    ],
  });
  const m = findM(out, '55A-1');
  assert.equal(m.pcNote, undefined, 'cleared note leaves nothing attached');
  assert.equal(m.pcNotes, undefined, 'no log either');
});
ok('multiple notes ALL survive as pcNotes, newest first (the log, not one slot)', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    noteRows: [
      { machine: '55A-1', note: 'cracked screen', by: 'tech-a', ts: '2026-08-11T09:00:00' },
      { machine: '55A-1', note: 'RMA pending', by: 'tech-a', ts: '2026-08-12T09:00:00' },
      { machine: '55A-1', note: 'back from RMA', by: 'tech-a', ts: '2026-08-13T09:00:00' },
    ],
  });
  const m = findM(out, '55A-1');
  assert.deepEqual(m.pcNotes.map(n => n.note), ['back from RMA', 'RMA pending', 'cracked screen']);
  assert.equal(m.pcNote, 'back from RMA', 'headline field is the newest note');
  assert.equal(m.pcNoteBy, 'tech-a');
});
ok('a clear only hides notes at-or-before it; later notes start a fresh log', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    noteRows: [
      { machine: '55A-1', note: 'old life', by: 'tech-a', ts: '2026-08-11T09:00:00' },
      { machine: '55A-1', note: '', by: 'tech-b', ts: '2026-08-12T09:00:00' },      // clear-all
      { machine: '55A-1', note: 'new life', by: 'tech-a', ts: '2026-08-13T09:00:00' },
    ],
  });
  const m = findM(out, '55A-1');
  assert.deepEqual(m.pcNotes.map(n => n.note), ['new life'], 'pre-clear note stays hidden');
  assert.equal(m.pcNote, 'new life');
});
ok('note log sorts by ts even when rows arrive out of order', () => {
  const out = foldFleet({
    results: green('55A-1', '2026-08-10T10:00:00'),
    noteRows: [
      { machine: '55A-1', note: 'second', by: 'b', ts: '2026-08-12T09:00:00' },
      { machine: '55A-1', note: 'first', by: 'a', ts: '2026-08-11T09:00:00' },
    ],
  });
  assert.deepEqual(findM(out, '55A-1').pcNotes.map(n => n.note), ['second', 'first']);
});
ok('note attaches to a never-seen untouched slot by "<room>#<num>"', () => {
  const out = foldFleet({
    results: [],
    roomRows: [{ room_key: '10101', building_abbr: 'ENG', expected_count: 3, requires_programs: 1 }],
    noteRows: [{ machine: '10101#2', note: 'missing from cart 3', by: 'tech-c', ts: '2026-08-19T12:00:00' }],
  });
  const room = out.rooms.find(r => r.room === '10101');
  const byNum = {}; for (const s of room.slots) byNum[s.num] = s;
  assert.equal(byNum[2].pcNote, 'missing from cart 3');
  assert.equal(byNum[2].state, 'red', 'a note alone does not recolour the slot');
});

// --- scope filter: a program is "missing" only if the room's config calls for it ---
ok('scope filter: out-of-scope missing dropped, in-scope missing kept', () => {
  const results = [
    { machine: '10101LAB34-1', app_id: 'Vivado', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'v' },
    { machine: '10101LAB34-1', app_id: '__gp__', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'gp' },
    { machine: '10101LAB34-1', app_id: '__cm__', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'cm' },
    { machine: '10101LAB34-1', app_id: 'LabChart', verdict: 'missing', ts: '2026-08-13T09:59:00', stick_id: 's1', obs_id: 'lc' },  // out-of-scope junk
    { machine: '10101LAB34-1', app_id: 'ImageJ', verdict: 'missing', ts: '2026-08-13T09:59:00', stick_id: 's1', obs_id: 'ij' },    // out-of-scope junk
    { machine: '10101LAB34-1', app_id: 'PuTTY', verdict: 'missing', ts: '2026-08-13T09:59:00', stick_id: 's1', obs_id: 'pt' },     // in-scope, a REAL miss
  ];
  const roomAppRows = [{ room_key: '10101', app_id: 'Vivado' }, { room_key: '10101', app_id: 'PuTTY' }];
  const out = foldFleet({ results, roomAppRows, roomRows: [{ room_key: '10101', building_abbr: 'ENG', expected_count: 1, requires_programs: 1 }] });
  const m = findM(out, '10101LAB34-1');
  const apps = m.apps.map((a) => a.app);
  assert.ok(!apps.includes('LabChart') && !apps.includes('ImageJ'), 'out-of-scope missing dropped');
  assert.ok(apps.includes('Vivado') && apps.includes('PuTTY'), 'in-scope apps kept');
  assert.equal(m.missing, 1, 'only the in-scope PuTTY counts as missing');
});
ok('scope filter: out-of-scope INSTALLED app is kept (informational, not hidden)', () => {
  const results = [
    { machine: '10101LAB34-2', app_id: 'Vivado', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'v' },
    { machine: '10101LAB34-2', app_id: 'LabChart', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'l' },
  ];
  const out = foldFleet({ results, roomAppRows: [{ room_key: '10101', app_id: 'Vivado' }] });
  assert.ok(findM(out, '10101LAB34-2').apps.map((a) => a.app).includes('LabChart'), 'installed out-of-scope kept');
});
ok('scope filter SAFETY: an unconfigured room keeps all observations', () => {
  const out = foldFleet({ results: [{ machine: '99999LATS1-1', app_id: 'Foo', verdict: 'missing', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'f' }], roomAppRows: [] });
  assert.equal(findM(out, '99999LATS1-1').missing, 1, 'no scope config => keep the missing, never hide a real problem');
});

// --- health-excluded apps (excludeFromFleetHealth) never colour a tile yellow ---
ok('health-excluded missing app does not turn a machine yellow', () => {
  const results = [
    { machine: '10101LAB34-9', app_id: 'Vivado', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'v' },
    { machine: '10101LAB34-9', app_id: '__gp__', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'gp' },
    { machine: '10101LAB34-9', app_id: '__cm__', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'cm' },
    { machine: '10101LAB34-9', app_id: 'MatlabLabDefaults', verdict: 'missing', ts: '2026-08-13T09:59:00', stick_id: 's1', obs_id: 'mld' },
  ];
  const roomAppRows = [{ room_key: '10101', app_id: 'Vivado' }, { room_key: '10101', app_id: 'MatlabLabDefaults' }];
  const out = foldFleet({ results, roomAppRows, healthExcluded: ['MatlabLabDefaults'], roomRows: [{ room_key: '10101', building_abbr: 'ENG', expected_count: 1, requires_programs: 1 }] });
  const m = findM(out, '10101LAB34-9');
  assert.equal(m.missing, 0, 'excluded missing app not counted');
  assert.equal(m.state, 'green', 'all real programs + GP + CM done => green, not yellow');
  const mld = m.apps.find((a) => a.app === 'MatlabLabDefaults');
  assert.ok(mld && mld.notCounted, 'still listed in the panel, tagged not-counted');
});
ok('without the exclusion list, the same missing app DOES turn it yellow', () => {
  const results = [
    { machine: '10101LAB34-9', app_id: 'Vivado', verdict: 'installed', ts: '2026-08-13T10:00:00', stick_id: 's1', obs_id: 'v' },
    { machine: '10101LAB34-9', app_id: 'MatlabLabDefaults', verdict: 'missing', ts: '2026-08-13T09:59:00', stick_id: 's1', obs_id: 'mld' },
  ];
  const roomAppRows = [{ room_key: '10101', app_id: 'Vivado' }, { room_key: '10101', app_id: 'MatlabLabDefaults' }];
  const out = foldFleet({ results, roomAppRows });   // no healthExcluded
  assert.equal(findM(out, '10101LAB34-9').state, 'yellow', 'un-excluded => yellow (proves the exclusion is what changes it)');
});

// ---- generation partition (2026-08-20): identity is (hostname, image date) ----
// The real case: 10101LAB34-63 re-imaged 08-19 as a bare 61+ station. Its 08-03
// life's "MATLAB missing" was still the newest row for that app and painted the
// NEW life yellow. Old-life rows must not colour the current life.
ok('re-imaged machine: old-life missing rows do not colour the new life', () => {
  const results = [
    { machine: '10101LAB34-63', app_id: 'MATLAB', verdict: 'missing', ts: '2026-08-04T10:20:00', stick_id: 's1', obs_id: 'a', imaged_gen: '2026-08-03' },
    { machine: '10101LAB34-63', app_id: 'Vivado', verdict: 'missing', ts: '2026-08-04T10:20:00', stick_id: 's1', obs_id: 'b', imaged_gen: '2026-08-03' },
    { machine: '10101LAB34-63', app_id: '__gp__', verdict: 'installed', ts: '2026-08-20T14:48:00', stick_id: 's2', obs_id: 'c', imaged_gen: '2026-08-19' },
    { machine: '10101LAB34-63', app_id: '__cm__', verdict: 'installed', ts: '2026-08-20T14:42:00', stick_id: 's2', obs_id: 'd', imaged_gen: '2026-08-19' },
  ];
  const roomAppRows = [{ room_key: '10101', app_id: 'MATLAB' }, { room_key: '10101', app_id: 'Vivado' }];
  const out = foldFleet({ results, roomAppRows });
  const m = findM(out, '10101LAB34-63');
  assert.equal(m.state, 'green', 'new bare life with GP+CM done is green, not yellow');
  assert.equal(m.missing, 0, 'old-life missing rows dropped');
});
ok('old-life GP does not satisfy the new life (fresh image owes its own GP)', () => {
  const results = [
    { machine: '10101LAB34-63', app_id: '__gp__', verdict: 'installed', ts: '2026-08-04T10:21:00', stick_id: 's1', obs_id: 'a', imaged_gen: '2026-08-03' },
    { machine: '10101LAB34-63', app_id: '__cm__', verdict: 'installed', ts: '2026-08-20T14:42:00', stick_id: 's2', obs_id: 'b', imaged_gen: '2026-08-19' },
  ];
  const out = foldFleet({ results });
  const m = findM(out, '10101LAB34-63');
  assert.equal(m.state, 'purple');
  assert.deepEqual(m.owed, ['GP'], 'owes GP even though the OLD image ran it');
});
ok('rows without imaged_gen keep the old behaviour (no partition)', () => {
  const out = foldFleet({ results: green('55A-7', '2026-08-10T10:00:00') });
  assert.equal(findM(out, '55A-7').state, 'green');
});

// ---- per-number scope: a bare-number machine never yellows over a program ----
ok('number outside prog_nums: observed missing program does not count', () => {
  const results = [
    { machine: '10101LAB34-63', app_id: 'Vivado', verdict: 'missing', ts: '2026-08-19T13:38:00', stick_id: 's1', obs_id: 'a', imaged_gen: '2026-08-19' },
    { machine: '10101LAB34-63', app_id: '__gp__', verdict: 'installed', ts: '2026-08-19T13:38:40', stick_id: 's1', obs_id: 'b', imaged_gen: '2026-08-19' },
    { machine: '10101LAB34-63', app_id: '__cm__', verdict: 'installed', ts: '2026-08-19T13:38:15', stick_id: 's1', obs_id: 'c', imaged_gen: '2026-08-19' },
  ];
  const roomRows = [{ room_key: '10101', building_abbr: 'ENG', expected_count: 90, requires_programs: 1, prog_nums: JSON.stringify(Array.from({length:60},(_,i)=>i+1)) }];
  const roomAppRows = [{ room_key: '10101', app_id: 'Vivado' }];
  const out = foldFleet({ results, roomRows, roomAppRows });
  const m = findM(out, '10101LAB34-63');
  assert.equal(m.state, 'green', '#63 is bare (61+): the stale-recheck Vivado-missing is out of scope');
});
ok('number INSIDE prog_nums: the same missing still yellows', () => {
  const results = [
    { machine: '10101LAB34-02', app_id: 'Vivado', verdict: 'missing', ts: '2026-08-19T13:38:00', stick_id: 's1', obs_id: 'a', imaged_gen: '2026-08-19' },
    { machine: '10101LAB34-02', app_id: '__gp__', verdict: 'installed', ts: '2026-08-19T13:38:40', stick_id: 's1', obs_id: 'b', imaged_gen: '2026-08-19' },
    { machine: '10101LAB34-02', app_id: '__cm__', verdict: 'installed', ts: '2026-08-19T13:38:15', stick_id: 's1', obs_id: 'c', imaged_gen: '2026-08-19' },
  ];
  const roomRows = [{ room_key: '10101', building_abbr: 'ENG', expected_count: 90, requires_programs: 1, prog_nums: JSON.stringify(Array.from({length:60},(_,i)=>i+1)) }];
  const roomAppRows = [{ room_key: '10101', app_id: 'Vivado' }];
  const out = foldFleet({ results, roomRows, roomAppRows });
  assert.equal(findM(out, '10101LAB34-02').state, 'yellow', '#2 needs programs, so missing Vivado still counts');
});

ok('summary.machines counts EVERY listed slot, untouched included', () => {
  const roomRows = [{ room_key: '10101', building_abbr: 'ENG', expected_count: 5, requires_programs: 1, prog_nums: null }];
  const out = foldFleet({ results: green('10101LAB34-1', '2026-08-10T10:00:00'), roomRows });
  // 1 observed machine + 4 untouched slots = 5 total
  assert.equal(out.summary.machines, 5);
  assert.equal(out.summary.green, 1);
  assert.equal(out.summary.red, 4);
});

// ============================================================
//  Assignment ledger (config_kv 'assignments')
// ============================================================
// Fleets whose hostnames carry no decodable scheme are placed by a HUMAN on the
// master and mirrored here as display data. A ledger entry beats the decoder.
// helper: every hostname the fold actually drew, room by room
function drawn(out) {
  const by = {};
  for (const room of out.rooms) for (const s of room.slots) if (s.machine) (by[room.room] ||= []).push(s.machine);
  return by;
}
const LEDGER = {
  rooms: { 'LAB-A': { abbr: 'ANNEX' } },
  machines: {
    'FRONTDESK-PC':  { room: 'LAB-A', num: 2,    assignedAt: '2026-08-20 09:00:00', retired: false },
    'Lab-Laptop-Red':{ room: 'LAB-A', num: null, assignedAt: '2026-08-20 09:01:00', retired: false },
    'Lab-Laptop-Blue':{ room: 'LAB-A', num: null, assignedAt: '2026-08-20 09:02:00', retired: false },
  },
};

ok('BASELINE: an undecodable hostname is invisible WITHOUT a ledger', () => {
  const out = foldFleet({ results: green('FRONTDESK-PC', '2026-08-20T10:00:00') });
  assert.equal(findM(out, 'FRONTDESK-PC'), null, 'no scheme, no ledger => nothing to draw');
});

ok('ledger places an undecodable machine into its room at its number', () => {
  const out = foldFleet({ results: green('FRONTDESK-PC', '2026-08-20T10:00:00'), assignments: LEDGER });
  const m = findM(out, 'FRONTDESK-PC');
  assert.ok(m, 'the assigned machine is drawn');
  assert.equal(m.num, 2, 'tile carries its ASSIGNED number');
  assert.equal(m.assigned, true);
  assert.equal(m.state, 'green', 'colour still comes from the observations');
  const room = out.rooms.find((r) => r.room === 'LAB-A');
  assert.ok(room, 'the ledger room appears on the board');
  assert.equal(room.abbr, 'ANNEX', 'ledger room label used when no roster row exists');
});

ok('slot 1 of a ledger room is still an untouched slot, not a shifted machine', () => {
  const out = foldFleet({
    results: green('FRONTDESK-PC', '2026-08-20T10:00:00'),
    roomRows: [{ room_key: 'LAB-A', building_abbr: 'ANNEX', expected_count: 2, requires_programs: 1 }],
    assignments: LEDGER,
  });
  const room = out.rooms.find((r) => r.room === 'LAB-A');
  const byNum = {}; for (const s of room.slots) byNum[s.num] = s;
  assert.equal(byNum[1].untouched, true, '#1 was never assigned to anyone');
  assert.equal(byNum[2].machine, 'FRONTDESK-PC');
});

ok('unnumbered ledger machines land after the numbered range, alphabetically', () => {
  const out = foldFleet({
    results: [...green('FRONTDESK-PC', '2026-08-20T10:00:00'),
              ...green('Lab-Laptop-Red', '2026-08-20T10:00:00'),
              ...green('Lab-Laptop-Blue', '2026-08-20T10:00:00')],
    assignments: LEDGER,
  });
  assert.deepEqual(drawn(out), { 'LAB-A': ['FRONTDESK-PC', 'Lab-Laptop-Blue', 'Lab-Laptop-Red'] },
    'numbered first, then the unnumbered pair in alphabetical order (Blue before Red)');
  const room = out.rooms.find((r) => r.room === 'LAB-A');
  const blue = room.slots.find((s) => s.machine === 'Lab-Laptop-Blue');
  const red = room.slots.find((s) => s.machine === 'Lab-Laptop-Red');
  assert.equal(blue.unnumbered, true, 'flagged so the client shows "?" not a fake number');
  assert.equal(red.unnumbered, true);
  assert.ok(blue.num > 2 && red.num > blue.num, 'render positions sit past the numbered range');
  assert.equal(room.size, red.num, 'room size grows to cover the appended machines');
});

ok('every assigned machine is counted exactly once in the summary', () => {
  const out = foldFleet({
    results: [...green('FRONTDESK-PC', '2026-08-20T10:00:00'),
              ...green('Lab-Laptop-Red', '2026-08-20T10:00:00'),
              ...green('Lab-Laptop-Blue', '2026-08-20T10:00:00')],
    assignments: LEDGER,
  });
  assert.equal(out.summary.green, 3, 'three green machines');
  assert.equal(out.summary.machines, 4, 'plus the untouched #1 hole = 4 slots listed');
});

ok('a human assignment BEATS a decodable hostname', () => {
  const out = foldFleet({
    results: green('10101LAB34-20', '2026-08-20T10:00:00'),
    assignments: { machines: { '10101LAB34-20': { room: 'LAB-A', num: 7 } } },
  });
  assert.equal(findM(out, '10101LAB34-20').num, 7, 'ledger number wins over the hostname suffix');
  assert.deepEqual(drawn(out), { 'LAB-A': ['10101LAB34-20'] }, 'ledger room wins over the hostname prefix');
});

ok('a retired entry is no assignment (machine drops off the board)', () => {
  const out = foldFleet({
    results: green('FRONTDESK-PC', '2026-08-20T10:00:00'),
    assignments: { machines: { 'FRONTDESK-PC': { room: 'LAB-A', num: 2, retired: true } } },
  });
  assert.equal(findM(out, 'FRONTDESK-PC'), null, 'retired => back to hostname decoding => invisible');
});

ok('a mark on an assigned but never-seen machine surfaces in its room', () => {
  const out = foldFleet({
    results: [],
    reqRows: [{ machine: 'FRONTDESK-PC', state: 'broken', ts: '2026-08-20T12:00:00', by: 'master', applied: 1 }],
    assignments: LEDGER,
  });
  const m = findM(out, 'FRONTDESK-PC');
  assert.ok(m, 'override-only tiles go through the same placement');
  assert.equal(m.state, 'broken');
  assert.equal(m.num, 2);
});

ok('assignments never disturb machines that are NOT in the ledger', () => {
  const out = foldFleet({ results: green('10101LAB34-20', '2026-08-20T10:00:00'), assignments: LEDGER });
  assert.deepEqual(drawn(out), { '10101': ['10101LAB34-20'] }, 'decoded machines are placed exactly as before');
});

ok('no ledger => byte-for-byte the old behaviour', () => {
  const args = {
    results: [...green('10101LAB34-1', '2026-08-10T10:00:00'), ...green('10101LAB34-2', '2026-08-10T10:00:00')],
    roomRows: [{ room_key: '10101', building_abbr: 'ENG', expected_count: 4, requires_programs: 1 }],
  };
  assert.deepEqual(foldFleet({ ...args, assignments: null }), foldFleet(args));
  assert.deepEqual(foldFleet({ ...args, assignments: {} }), foldFleet(args));
});

// --- normalizeAssignments: shape tolerance + hostile input ---
ok('normalizeAssignments accepts the ledger, a bare map, an array, and a JSON string', () => {
  const want = { room: 'LAB-A', num: 2 };
  assert.deepEqual(normalizeAssignments(LEDGER).machines['FRONTDESK-PC'], want);
  assert.deepEqual(normalizeAssignments({ 'FRONTDESK-PC': { room: 'LAB-A', num: 2 } }).machines['FRONTDESK-PC'], want);
  assert.deepEqual(normalizeAssignments([{ machine: 'FRONTDESK-PC', room: 'LAB-A', num: 2 }]).machines['FRONTDESK-PC'], want);
  assert.deepEqual(normalizeAssignments(JSON.stringify(LEDGER)).machines['FRONTDESK-PC'], want);
});
ok('normalizeAssignments drops junk instead of throwing', () => {
  for (const bad of [null, undefined, 0, '', 'not json', '{"machines":', [1, 2, 3], { machines: 5 }]) {
    const r = normalizeAssignments(bad);
    assert.deepEqual(Object.keys(r.machines), [], 'nothing placed from ' + JSON.stringify(bad));
  }
  const r = normalizeAssignments({ machines: { A: { num: 3 }, B: { room: '  ' }, C: { room: 'LAB-A', num: 'abc' }, D: { room: 'LAB-A', num: -1 } } });
  assert.equal(r.machines['A'], undefined, 'no room => places nothing');
  assert.equal(r.machines['B'], undefined, 'blank room => places nothing');
  assert.equal(r.machines['C'].num, null, 'unparseable number => unnumbered, not NaN');
  assert.equal(r.machines['D'].num, null, 'a non-positive number => unnumbered');
});
ok('a machine named after an Object prototype key cannot poison the fold', () => {
  const out = foldFleet({
    results: green('constructor', '2026-08-20T10:00:00'),
    assignments: { machines: { toString: { room: 'LAB-A', num: 1 } } },
  });
  assert.equal(normalizeAssignments({}).machines['constructor'], undefined, 'unassigned prototype key reads as unassigned');
  assert.ok(out && out.summary, 'the fold survives a hostile hostname');
});

console.log(`\nfleetfold: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
