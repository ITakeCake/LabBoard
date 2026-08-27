-- One-time migration for the existing REMOTE D1 (fresh/local DBs get this from
-- schema.sql's updated CREATE). Run ONCE:
--   wrangler d1 execute labboard --file api/migrations/2026-08-19-progroom.sql --remote
-- "duplicate column name" on a re-run is expected + harmless.
ALTER TABLE rooms ADD COLUMN prog_nums TEXT;
