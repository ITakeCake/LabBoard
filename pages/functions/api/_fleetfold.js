// Pure fold: observations + room roster + master marks + applied request-edits -> { summary, rooms }.
// Extracted from api/fleet.js so the load-bearing newest-sighting-wins rule is unit-testable
// with plain node (no live D1). Filenames starting with "_" are NOT routed by Pages, so this
// is a shared library, not an endpoint. Tests: labboard/tests/test-fleetfold.mjs.
//
// newest-sighting-wins: a master mark or an applied request-edit overrides a machine's OBSERVED
// colour ONLY if its assertion ts is >= the machine's newest observation ts. If a stick has
// seen the machine since the assertion, the live observation wins. An assertion on a machine
// no stick has ever reported surfaces as a tile (it is trivially the newest evidence).

// Map an assertion state to a tile colour. 'clear'/unknown => null (no override; keep observed).
export function overrideTile(st) {
  return st === 'broken' ? 'broken'
    : st === 'missing' ? 'blue'
    : (st === 'verified' || st === 'override') ? 'green'
    : null;
}

// Which year page does a machine-generation belong to? JS port of the master's
// Get-FleetPageFor: the page with the greatest cutoff at or before the image date;
// the first page catches everything older; NO image stamp => the current page.
// pages: [{label, cutoff}] (cutoff = ISO string or '' ). Returns a label.
export function pageForGen(imagedGen, pages, currentLabel) {
  if (!pages || !pages.length) return currentLabel;
  const sorted = [...pages].sort((a, b) => (+a.label) - (+b.label));
  const s = String(imagedGen == null ? '' : imagedGen).trim();
  const fallback = currentLabel != null ? currentLabel : sorted[sorted.length - 1].label;
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return fallback;
  // Both sides are LOCAL wall-clock (imaged_gen is date-only "yyyy-MM-dd"; cutoff is the
  // master's 'o' roundtrip, whose date prefix is local). Compare the yyyy-MM-dd prefixes as
  // STRINGS so a machine imaged ON the cutoff day lands on the new page, matching the
  // master's Get-FleetPageFor. (Date.parse would read a bare date as UTC and a cutoff with
  // an offset as local, splitting them by the timezone offset.)
  const s10 = s.slice(0, 10);
  let best = sorted[0].label;
  for (const p of sorted) {
    const c = String(p.cutoff || '').slice(0, 10);
    if (c && s10 >= c) best = p.label;
  }
  return best;
}

// ---- assignment ledger (fleets whose hostnames carry NO decodable scheme) ----
//
// Room and machine-number normally come from the hostname itself (see roomKeyOf /
// numOf below). A fleet named "FRONTDESK-PC" or "Lab-Laptop-Blue" decodes to
// nothing: room 'other', number 0 — and a 0 never lands in a slot, so those
// machines silently fall off the board entirely.
//
// The fix is a human LEDGER, authored on the master (Rooms & Rules -> Machines) and
// mirrored here as the config_kv key 'assignments'. It is DISPLAY data like every
// other config key: it says where a machine is drawn, never what a client should do.
// A ledger entry beats the decoder, exactly as it does on the master — assignment is
// a person's decision and evidence never overrules it.
//
// Shape (the master's machine-assignments.json, pushed verbatim):
//   { rooms:    { "<roomKey>": { abbr: "MAIN" } },            // optional, display only
//     machines: { "<hostname>": { room: "<roomKey>",
//                                 num: 12 | null,             // null/absent = unnumbered
//                                 retired: false } } }
// Also tolerated: a bare hostname->entry map, or an array of
// { machine|hostname, room, num, retired }. A retired entry is treated as NO
// assignment (the machine drops back to hostname decoding, i.e. off the board).
export function normalizeAssignments(assignments) {
  // null-prototype: hostnames are attacker-adjacent strings, and a plain {} would
  // report a machine called "constructor" or "toString" as assigned.
  const machines = Object.create(null), rooms = Object.create(null);
  if (!assignments) return { machines, rooms };
  let a = assignments;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return { machines, rooms }; } }
  if (!a || typeof a !== 'object') return { machines, rooms };

  const take = (host, v) => {
    if (!host || !v || typeof v !== 'object') return;
    if (v.retired) return;                                   // retired => unassigned
    const room = v.room == null ? '' : String(v.room).trim();
    if (!room) return;                                       // an entry with no room places nothing
    const rawNum = v.num == null || v.num === '' ? null : parseInt(v.num, 10);
    machines[String(host)] = { room, num: Number.isFinite(rawNum) && rawNum > 0 ? rawNum : null };
  };

  const src = Array.isArray(a) ? a : (Array.isArray(a.machines) ? a.machines : null);
  if (src) { for (const e of src) take(e && (e.machine || e.hostname), e); }
  else {
    const m = (a.machines && typeof a.machines === 'object') ? a.machines : a;
    for (const host of Object.keys(m)) {
      if (host === 'rooms' || host.charAt(0) === '_') continue;   // doc keys / the rooms block
      take(host, m[host]);
    }
  }
  if (a.rooms && typeof a.rooms === 'object' && !Array.isArray(a.rooms)) {
    for (const rk of Object.keys(a.rooms)) {
      const v = a.rooms[rk];
      if (v && typeof v === 'object' && v.abbr) rooms[rk] = { abbr: String(v.abbr) };
    }
  }
  return { machines, rooms };
}

// Hostname decoding — the DEFAULT placement, used whenever the ledger is silent.
function numOf(machine) { return parseInt((/-(\d+)$/.exec(machine) || [])[1], 10) || 0; }
function roomKeyOf(machine) { return (/^(\d+)[A-Za-z]/.exec(machine) || [])[1] || 'other'; }

export function foldFleet({ results = [], roomRows = [], markRows = [], reqRows = [], noteRows = [], roomAppRows = [], healthExcluded = [], assignments = null, year = null, pages = null, currentYear = null } = {}) {
  // Every map below is keyed by a string that ARRIVED OVER THE WIRE (hostname, app id,
  // room key). A plain {} would report a machine named "constructor" or "toString" as
  // already present and then throw on it, so each one is null-prototype.
  const roster = Object.create(null);
  for (const r of roomRows) roster[r.room_key] = r;
  const ledger = normalizeAssignments(assignments);

  // Place one machine: the ledger first, the hostname second. `unnumbered` machines
  // hold no slot number yet — they are appended to their room, alphabetically, below.
  const place = (m) => {
    const as = ledger.machines[m.machine];
    if (as) {
      m.roomKey = as.room;
      m.assigned = true;
      if (as.num != null) m.num = as.num;
      else { m.num = 0; m.unnumbered = true; }
      return;
    }
    m.num = numOf(m.machine);
    m.roomKey = roomKeyOf(m.machine);
  };

  // Apps the master marks excludeFromFleetHealth (e.g. MatlabLabDefaults, a per-user MATLAB
  // preference refresh). A machine missing one of these is NOT broken, so it must never
  // colour the tile yellow — mirrors the master's own rollup. Still listed in the panel,
  // just tagged "not counted" and dropped from the missing count that drives colour.
  const healthEx = new Set(healthExcluded);

  // Expected app set per room (master-pushed room_apps) — the SAME scope the master reconciles
  // against. Used to drop out-of-scope observations so a machine is only "missing" a
  // program that its room actually calls for (see the scope filter in the fold loop).
  const expectedByRoom = Object.create(null);
  for (const a of roomAppRows) {
    if (!a || !a.room_key) continue;
    (expectedByRoom[a.room_key] || (expectedByRoom[a.room_key] = new Set())).add(a.app_id);
  }

  // Free-form per-PC notes, as a LOG (2026-08-21: "you can only have one
  // note for some reason?"). machine_notes was append-only all along - only this
  // fold collapsed it to newest-wins, so every note past the first LOOKED
  // overwritten. Now: pcNotes = every note since the last clear, newest first;
  // pcNote/pcNoteBy/pcNoteTs stay the newest one for the consumers that only
  // want a headline (the tile dot, image.js). An empty note is still a CLEAR -
  // it hides everything at-or-before its ts (history stays in D1, just not
  // shown). Notes remain orthogonal to colour: decorate, never recolour.
  const noteLog = Object.create(null);
  for (const nr of noteRows) {
    const k = nr && nr.machine; if (!k) continue;
    (noteLog[k] || (noteLog[k] = [])).push({ note: nr.note || '', by: nr.by || '', ts: nr.ts || '' });
  }
  const applyNote = (obj, key) => {
    const log = noteLog[key];
    if (!log || !log.length) return;
    log.sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : String(a.ts) > String(b.ts) ? 1 : 0));
    let cut = -1;
    for (let i = 0; i < log.length; i++) if (!log[i].note) cut = i;   // last clear wins
    const live = log.slice(cut + 1).filter((n) => n.note);
    if (!live.length) return;
    live.reverse();                                                    // newest first
    obj.pcNotes = live;
    obj.pcNote = live[0].note; obj.pcNoteBy = live[0].by; obj.pcNoteTs = live[0].ts;
  };

  // One "override" per machine = the NEWEST assertion (master mark OR applied request), by ts.
  const override = Object.create(null);
  const consider = (machine, state, ts, by, note) => {
    if (!machine) return;
    const cur = override[machine];
    if (!cur || String(ts || '') >= String(cur.ts || '')) override[machine] = { state, ts: ts || '', by: by || '', note: note || '' };
  };
  for (const mk of markRows) consider(mk.machine, mk.state, mk.ts, mk.by, mk.note);   // marks: broken|missing
  for (const rq of reqRows) consider(rq.machine, rq.state, rq.ts, rq.by, rq.note);    // requests: verified|override|missing|broken|clear

  // fold observation rows into machines; __gp__/__cm__ are pseudo-apps, not real programs
  const machines = Object.create(null);
  for (const r of results) {
    const m = machines[r.machine] || (machines[r.machine] =
      { machine: r.machine, apps: [], gp: null, cm: null, lastTs: null, sticks: {}, imagedGen: null });
    if (r.app_id === '__gp__') { m.gp = r.verdict; m.gpGen = r.imaged_gen; }
    else if (r.app_id === '__cm__') { m.cm = r.verdict; m.cmGen = r.imaged_gen; }
    else m.apps.push({ app: r.app_id, verdict: r.verdict, code: r.code, ts: r.ts, obs_id: r.obs_id, has_log: !!r.has_log, gen: r.imaged_gen });
    if (r.stick_id) m.sticks[r.stick_id] = 1;
    // track the imaged_gen of the NEWEST observation, not whichever row SQL returned
    // first, so a re-imaged machine's year page is deterministic.
    if (r.ts && (!m.lastTs || r.ts > m.lastTs)) { m.lastTs = r.ts; if (r.imaged_gen) m.imagedGen = r.imaged_gen; }
    else if (r.imaged_gen && !m.imagedGen) m.imagedGen = r.imaged_gen;
  }
  // per-room prog_nums (parsed once): which machine NUMBERS need programs. Used both
  // for untouched-slot colour (below) and for the per-number scope filter (a bare
  // station like ENG #61+ must never be yellow over a program it was never owed).
  const progSetByRoom = Object.create(null);
  for (const rk of Object.keys(roster)) {
    const rs = roster[rk];
    if (rs && rs.prog_nums) { try { const a = JSON.parse(rs.prog_nums); if (Array.isArray(a)) progSetByRoom[rk] = new Set(a); } catch {} }
  }

  const rank = { error: 0, missing: 1, installed: 2, opened: 3, removed: 4, snapshot: 5 };
  for (const key of Object.keys(machines)) {
    const m = machines[key];
    m.sticks = Object.keys(m.sticks);
    place(m);
    // GENERATION PARTITION (2026-08-20: "the old information dont matter no
    // more"). Machine identity is (hostname, image date). A re-imaged machine starts
    // a new life: evidence from a PREVIOUS imaged_gen must not colour the current one
    // (10101LAB34-63: re-imaged 08-19 as a bare 61+ station, but its 08-03 life's
    // "MATLAB missing" rows still folded in and painted it yellow). Keep only rows
    // whose imaged_gen matches the gen of the machine's NEWEST observation; the master's
    // Get-FleetRollup applies the same rule. gp/cm are per-life too — a fresh image
    // owes its own GP/CM run, whatever the old life logged.
    if (m.imagedGen != null) {
      const gen = String(m.imagedGen);
      m.apps = m.apps.filter((a) => String(a.gen == null ? '' : a.gen) === gen);
      if (String(m.gpGen == null ? '' : m.gpGen) !== gen) m.gp = null;
      if (String(m.cmGen == null ? '' : m.cmGen) !== gen) m.cm = null;
    }
    // SCOPE FILTER (2026-08-19: "it's only missing if it's missing from that room's
    // config"). A stick that scanned a machine against a WIDER app catalogue than its room
    // needs (e.g. ENG 10101LAB34-18 scanned with the Science set) reported ~48 out-of-scope
    // programs as 'missing' — false alarms for software the machine should never have. Drop
    // any observation whose app is NOT in the room's expected set unless it is actually
    // installed: keep every installed app (real + informational) and every in-scope verdict,
    // discard out-of-scope missing/error/etc. SAFETY: only filter when the room HAS a
    // configured expected set, so an unconfigured room keeps ALL observations and we never
    // silently hide a real problem. Mirrors the master's room-scoped reconciliation.
    const exp = expectedByRoom[m.roomKey];
    if (exp && exp.size) m.apps = m.apps.filter((a) => a.verdict === 'installed' || exp.has(a.app));
    // PER-NUMBER SCOPE: rules split a room by number (ENG: 1-60 get software, 61+
    // bare). A bare-number machine owes NO programs, so a program observed 'missing'
    // on it (e.g. a stale recheck order executed after a re-image) is out of scope —
    // keep only what is actually installed. Mirrors the master's number-aware
    // Get-FleetExpected; only applies when the roster pushed a prog_nums split.
    const pset = progSetByRoom[m.roomKey];
    if (pset && m.num && !pset.has(m.num)) m.apps = m.apps.filter((a) => a.verdict === 'installed');
    // tag health-excluded apps so the panel can show "(not counted)" and the colour skips them
    if (healthEx.size) for (const a of m.apps) if (healthEx.has(a.app)) a.notCounted = true;
    m.missing = m.apps.filter((a) => a.verdict === 'missing' && !a.notCounted).length;
    m.installed = m.apps.filter((a) => a.verdict === 'installed').length;
    m.error = m.apps.filter((a) => a.verdict === 'error' && !a.notCounted).length;
    const gpOk = m.gp === 'installed', cmOk = m.cm === 'installed';
    m.state = m.missing > 0 ? 'yellow' : (gpOk && cmOk ? 'green' : 'purple');
    m.owed = []; if (!gpOk) m.owed.push('GP'); if (!cmOk) m.owed.push('CM');
    m.apps.sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || a.app.localeCompare(b.app));
    const ov = override[m.machine];
    if (ov && String(ov.ts || '') >= String(m.lastTs || '')) {
      const tile = overrideTile(ov.state);
      if (tile) { m.state = tile; m.mark = ov.state; m.markBy = ov.by; m.markNote = ov.note; m.markTs = ov.ts; }
      // 'clear' (tile null) that is newest => drop the mark, keep the observed colour.
    }
    applyNote(m, m.machine);
  }

  // Overrides targeting a never-observed machine: surface them as tiles.
  for (const machine of Object.keys(override)) {
    if (machine.indexOf('#') !== -1) continue;   // "<room>#<num>" slot-marks are applied in the untouched loop
    if (machines[machine]) continue;
    const ov = override[machine];
    const tile = overrideTile(ov.state);
    if (!tile) continue;
    machines[machine] = {
      machine, apps: [], gp: null, cm: null, lastTs: ov.ts, sticks: [],
      missing: 0, installed: 0, error: 0, owed: [], state: tile,
      mark: ov.state, markBy: ov.by, markNote: ov.note, markTs: ov.ts,
    };
    place(machines[machine]);   // ledger first, hostname second — same rule as a seen machine
    applyNote(machines[machine], machine);
  }

  // Year partition (theFuture item 5): keep only machines whose generation belongs to
  // the selected page. Untouched roster slots reflect the present, so they show only on
  // the current year. No year selected => no filtering (unchanged behaviour).
  const yearActive = year != null && pages && pages.length;
  if (yearActive) {
    for (const key of Object.keys(machines)) {
      if (String(pageForGen(machines[key].imagedGen, pages, currentYear)) !== String(year)) delete machines[key];
    }
  }
  const showUntouched = !yearActive || String(year) === String(currentYear);

  // group into rooms, size by max(observed, roster), fill untouched slots
  const rooms = Object.create(null);
  for (const key of Object.keys(machines)) {
    const m = machines[key];
    const R = rooms[m.roomKey] || (rooms[m.roomKey] = { room: m.roomKey, byNum: {}, extras: [], observedMax: 0 });
    // A ledger machine with no number yet holds no slot — it is appended after the
    // numbered range, alphabetically, when the room is emitted.
    if (m.unnumbered) { R.extras.push(m); continue; }
    // Two generations of the same physical slot (re-image: 10101LAB34-20 vs
    // 10101LAB35-20 both map to room 10101 / num 20). Keep the NEWEST by lastTs so a
    // machine never silently vanishes and the survivor is deterministic across polls.
    const prev = R.byNum[m.num];
    if (!prev || String(m.lastTs || '') >= String(prev.lastTs || '')) R.byNum[m.num] = m;
    if (m.num > R.observedMax) R.observedMax = m.num;
  }
  if (showUntouched) { for (const rk of Object.keys(roster)) { if (!rooms[rk]) rooms[rk] = { room: rk, byNum: {}, extras: [], observedMax: 0 }; } }

  const summary = { machines: 0, obsRows: results.length, green: 0, yellow: 0, purple: 0, red: 0, orange: 0, blue: 0, broken: 0 };
  const roomList = [];
  for (const rk of Object.keys(rooms)) {
    const R = rooms[rk];
    const rs = roster[rk] || {};
    const reqPrograms = rs.requires_programs == null ? true : !!rs.requires_programs;
    // per-machine-number program requirement: rules split a room by number (e.g. 1-60
    // get software, 61+ only GP/CM), so an untouched slot is RED only if ITS number
    // needs programs, else ORANGE. Falls back to the room-wide flag if no set was pushed.
    const progSet = progSetByRoom[rk] || null;
    // a configured room (present in the roster) shows at least one box, even with an
    // unknown machine count — "if we don't know how many, just Box1".
    const size = showUntouched ? Math.max(R.observedMax, rs.expected_count || 0, (roster[rk] ? 1 : 0)) : R.observedMax;
    const slots = [];
    for (let n = 1; n <= size; n++) {
      const m = R.byNum[n];
      // "machines" = every slot on the board, touched or not (2026-08-20:
      // the headline number should be the TOTAL fleet listed, not just what a
      // stick has seen). Per-colour tallies still split touched vs untouched.
      if (m) { slots.push(m); summary[m.state]++; summary.machines++; }
      else if (showUntouched) {
        summary.machines++;
        let st = (progSet ? progSet.has(n) : reqPrograms) ? 'red' : 'orange';
        const slot = { machine: '', num: n, untouched: true, apps: [] };
        // a never-seen slot can still carry a tech mark, keyed by "<room>#<num>".
        // A real sighting later wins by newest-ts (it becomes a real tile, not this).
        const sm = override[rk + '#' + n];
        if (sm) { const t = overrideTile(sm.state); if (t) { st = t; slot.mark = sm.state; slot.markBy = sm.by; slot.markNote = sm.note; slot.markTs = sm.ts; } }
        slot.state = st;
        applyNote(slot, rk + '#' + n);
        slots.push(slot);
        summary[st]++;
      }
    }
    // Ledger machines with no number yet: appended AFTER the numbered range,
    // alphabetically by hostname, so the order is stable for a given room membership.
    // Their `num` is a render position, not an identity — `unnumbered` tells the
    // client to show them without pretending that position is their machine number.
    const extras = (R.extras || []).slice().sort((a, b) => String(a.machine).localeCompare(String(b.machine)));
    let pos = size;
    for (const m of extras) {
      m.num = ++pos;
      slots.push(m);
      summary[m.state]++; summary.machines++;
    }
    // progNums rides along so the client can tell program machines from bare
    // stations (multi-config rooms: ENG #1-60 get software, #61+ only GP/CM).
    // abbr: the room roster first (the master's own building table), then the
    // ledger's optional label for rooms that exist only in the ledger.
    const abbr = rs.building_abbr || (ledger.rooms[rk] && ledger.rooms[rk].abbr) || '';
    if (slots.length || showUntouched) roomList.push({ room: rk, abbr, size: pos, slots, progNums: progSet ? [...progSet] : null });
  }
  roomList.sort((a, b) => a.room.localeCompare(b.room));
  return { summary, rooms: roomList };
}
