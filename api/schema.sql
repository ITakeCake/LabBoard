-- labboard-api — D1 schema (Phase 0 / Phase 1)
-- Observations are append-only FACTS. The newest-wins reconciliation ("one brain")
-- runs CLIENT-SIDE in Get-FleetRollup, never here. The server only appends + serves.

CREATE TABLE IF NOT EXISTS observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- monotonic server cursor for GET /obs?since= (Phase 2)
  obs_id      TEXT NOT NULL UNIQUE,               -- deterministic client id; UNIQUE => re-push is idempotent
  stick_id    TEXT NOT NULL,                      -- attribution (server stamps from the token) -> revocation
  machine     TEXT NOT NULL,                      -- routing, NOT permission
  imaged_gen  TEXT,                               -- (hostname, image date) identity the fold depends on
  app_id      TEXT NOT NULL,
  verdict     TEXT NOT NULL,                      -- installed | missing | error | opened | removed | snapshot
  code        TEXT,                               -- e.g. E24 (nullable)
  ts          TEXT,                               -- client LOCAL wall-clock 'yyyy-MM-ddTHH:mm:ss.fff' (NOT UTC)
  seq         INTEGER,                            -- order within a session
  session     TEXT,                               -- session id (log filename date_time)
  token_id    INTEGER,                            -- which token appended it (server-filled)
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))  -- server UTC; orders cross-machine
);
CREATE INDEX IF NOT EXISTS idx_obs_machine_ts ON observations(machine, ts);
CREATE INDEX IF NOT EXISTS idx_obs_received   ON observations(received_at);
CREATE INDEX IF NOT EXISTS idx_obs_stick      ON observations(stick_id);

-- Per-stick tokens. The raw token is NEVER stored; only its SHA-256 hash.
-- Revocation = set enabled=0 (server) plus a client-side revocation list in config.
CREATE TABLE IF NOT EXISTS tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,               -- SHA-256(raw token), hex
  stick_id    TEXT NOT NULL,                      -- driveShort (first 6 hex of drive-id GUID)
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  disabled_at TEXT
);

-- Failed-install log blobs live in R2 (Phase 1), referenced by obs_id.
CREATE TABLE IF NOT EXISTS logs (
  obs_id      TEXT PRIMARY KEY,
  r2_key      TEXT NOT NULL,                      -- machine/session/appid.log
  bytes       INTEGER,
  truncated   INTEGER NOT NULL DEFAULT 0,         -- 1 if only head+tail were kept
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Coarse per-token, per-minute request-rate backstop. The real defence against
-- injection is revocation + client sanity bounds + newest-wins self-heal, so this
-- is deliberately generous (a legit first-run backfill sends many chunked requests).
CREATE TABLE IF NOT EXISTS rate (
  token_id INTEGER NOT NULL,
  bucket   INTEGER NOT NULL,                      -- unix-minute bucket
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, bucket)
);

-- Automated critical-error / anomaly log. Every suspicious thing the Worker sees
-- (NaN/Infinity/out-of-bounds numbers, mostly-invalid batches, rate trips, oversized
-- logs) lands here, is console-logged, and (if ALERT_WEBHOOK is set) pushed to Blake.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  level        TEXT NOT NULL,                     -- info | warn | critical
  kind         TEXT NOT NULL,                     -- bad-number | high-invalid-ratio | rate-trip | oversized-log | ...
  detail       TEXT,
  stick_id     TEXT,
  machine      TEXT,
  token_id     INTEGER,
  ts           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);
CREATE INDEX IF NOT EXISTS idx_alerts_ack ON alerts(acknowledged, ts);

-- Room roster, synced from the master (the ONLY thing that knows room profiles). Lets
-- the dashboard size each room to its declared count and colour untouched slots
-- red (needs programs) vs orange (GP/CM-only). Display config only, no authority.
CREATE TABLE IF NOT EXISTS rooms (
  room_key          TEXT PRIMARY KEY,             -- "<building>-<room>", e.g. "55-103"
  building          TEXT,
  room              TEXT,
  building_abbr     TEXT,
  expected_count    INTEGER NOT NULL DEFAULT 0,
  requires_programs INTEGER NOT NULL DEFAULT 1,
  prog_nums         TEXT,                             -- JSON int array: which machine NUMBERS need programs (rules split a room by number)
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Tech marks (broken / reported-missing) synced from the master as a FULL REPLACE,
-- so un-marking clears cleanly. Machine-keyed (touched machines only).
-- `ts` is the mark's OWN assertion time (master local wall-clock), not server-now, so
-- the dashboard's newest-sighting-wins fold can compare it against observation ts.
-- `by`/`note` carry provenance for the hover note ("Blake reported missing on <date>").
CREATE TABLE IF NOT EXISTS marks (
  machine TEXT PRIMARY KEY,
  state   TEXT NOT NULL,                          -- broken | missing
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  by      TEXT,                                   -- who asserted it (e.g. 'master', 'Blake')
  note    TEXT                                    -- rendered hover note
);

-- Master-authored config, mirrored to the dashboard so it can key off year rules, the
-- whitelist, and building abbreviations. The master is the ONLY writer; the site reads
-- (Pages GET /api/config) and NEVER writes. The Worker stores opaque JSON blobs — it
-- does not interpret them, keeping the plane verb-free. key ∈ {years, whitelist, buildings}.
CREATE TABLE IF NOT EXISTS config_kv (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,                       -- opaque to the server
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- USB request-edits: a whitelisted user asks to set a box green/missing/etc from a
-- stick. Recorded as APPEND-ONLY FACTS (kept SEPARATE from the full-replace `marks`
-- table so the master's next roster/mark push never erases them). The dashboard folds
-- applied requests under the same newest-sighting-wins rule as observations + marks.
CREATE TABLE IF NOT EXISTS mark_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id      TEXT NOT NULL UNIQUE,               -- SHA1(by|machine|state|ts) => idempotent re-push
  machine     TEXT NOT NULL,
  state       TEXT NOT NULL,                      -- verified | override | missing | broken | clear
  by          TEXT NOT NULL,                      -- requester ($env:USERNAME)
  note        TEXT,
  ts          TEXT NOT NULL,                      -- requester's assertion time (local wall clock)
  stick_id    TEXT,                               -- server-stamped from token (attribution)
  applied     INTEGER NOT NULL DEFAULT 0,         -- 1 if requester passed the whitelist
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_markreq_recv ON mark_requests(received_at);
CREATE INDEX IF NOT EXISTS idx_markreq_machine ON mark_requests(machine, ts);

-- Free-form per-PC notes (added 2026-08-19) — a lab tech's scratchpad on a single
-- machine ("cracked screen, RMA pending", "missing from cart 3"), ORTHOGONAL to the
-- broken/missing MARK (a note never changes a tile's colour). Append-only like
-- mark_requests; the dashboard folds the NEWEST note per key under newest-ts-wins, so
-- editing = writing a fresh row, and clearing = writing an empty note. `machine` holds
-- a real hostname OR a never-seen slot key "<room>#<num>" (same convention as marks),
-- so every box on the grid can carry a note, even red never-touched ones.
CREATE TABLE IF NOT EXISTS machine_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT NOT NULL UNIQUE,               -- SHA1(by|machine|ts) => idempotent re-push
  machine     TEXT NOT NULL,                      -- hostname OR "<room>#<num>"
  note        TEXT,                               -- empty string = the note was cleared
  by          TEXT NOT NULL,                      -- authenticated dashboard user
  ts          TEXT NOT NULL,                      -- author's assertion time (local wall clock)
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_note_machine ON machine_notes(machine, ts);

-- Software Auditor submissions (theFuture item 18, EXPERIMENTAL). A department contact
-- fills in the audit form on the dashboard; it POSTs here (unauthenticated + rate-limited,
-- like /health, because the auditor is not a stick). Deliberately a dumb append store:
-- who/department/room + an opaque JSON payload of the program rows. Nothing acts on it.
CREATE TABLE IF NOT EXISTS audit_submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  by          TEXT,
  department  TEXT,
  room        TEXT,
  payload     TEXT NOT NULL,                      -- JSON: [{program,current,requested,latest,notes}, ...]
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_recv ON audit_submissions(received_at);

-- Expected apps per room, synced from the master with the roster (theFuture items 6+13).
-- Lets the dashboard print the per-room program checklist and (later) distinguish
-- "never attempted" from "failed". Display config only, no authority. Full-replace
-- per room on each roster push.
CREATE TABLE IF NOT EXISTS room_apps (
  room_key TEXT NOT NULL,
  app_id   TEXT NOT NULL,
  PRIMARY KEY (room_key, app_id)
);

-- Data-isolation area (theFuture item 15). Rows moved OUT of observations land here,
-- invisible to every reader (fleet, stats, feed, time machine all read observations
-- only). restore = move back; delete = permanently remove FROM HERE ONLY (a hard
-- delete never touches the live table directly). Same columns as observations, plus
-- who/when/why the chunk was isolated. Every isolate/restore/delete raises an alert.
CREATE TABLE IF NOT EXISTS observations_isolated (
  id          INTEGER,                            -- original observations.id (kept for restore ordering)
  obs_id      TEXT NOT NULL UNIQUE,
  stick_id    TEXT NOT NULL,
  machine     TEXT NOT NULL,
  imaged_gen  TEXT,
  app_id      TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  code        TEXT,
  ts          TEXT,
  seq         INTEGER,
  session     TEXT,
  token_id    INTEGER,
  received_at TEXT,
  iso_batch   TEXT NOT NULL,                      -- groups one isolate action for restore/delete
  iso_by      TEXT,
  iso_why     TEXT,
  iso_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_iso_batch ON observations_isolated(iso_batch);
