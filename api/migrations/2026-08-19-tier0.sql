-- One-time migration for the existing REMOTE D1 (fresh/local DBs get these columns
-- from schema.sql's updated CREATE statements). Run ONCE:
--   wrangler d1 execute labboard --file api/migrations/2026-08-19-tier0.sql --remote
-- SQLite has no "ADD COLUMN IF NOT EXISTS" — on a re-run each ALTER errors with
-- "duplicate column name"; that error is expected and harmless (the column is already there).
-- The new tables (config_kv, mark_requests) are created idempotently by schema.sql itself,
-- so this file only carries the additive column changes to the pre-existing `marks` table.

ALTER TABLE marks ADD COLUMN by   TEXT;
ALTER TABLE marks ADD COLUMN note TEXT;
