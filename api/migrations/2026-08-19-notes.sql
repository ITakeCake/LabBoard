-- One-time migration for the existing REMOTE D1 (fresh/local DBs get this from
-- schema.sql's updated CREATE). Adds the per-PC notes store. Run ONCE:
--   wrangler d1 execute labboard --file api/migrations/2026-08-19-notes.sql --remote
-- "table already exists" on a re-run is expected + harmless.
CREATE TABLE IF NOT EXISTS machine_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id     TEXT NOT NULL UNIQUE,
  machine     TEXT NOT NULL,
  note        TEXT,
  by          TEXT NOT NULL,
  ts          TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_note_machine ON machine_notes(machine, ts);
