-- Basketweaver Leaderboard — Vercel Postgres Schema
-- Run once after creating your Vercel Postgres database:
--   paste into the Vercel Postgres query console, or run via psql

CREATE TABLE IF NOT EXISTS records (
  id               TEXT     PRIMARY KEY,
  character_name   TEXT     NOT NULL,
  server_name      TEXT     NOT NULL DEFAULT '',
  mob_name         TEXT     NOT NULL,
  grade            TEXT     NOT NULL DEFAULT 'F',
  total_dps        REAL     NOT NULL DEFAULT 0,
  fist_dps         REAL     NOT NULL DEFAULT 0,
  fight_duration   INTEGER  NOT NULL DEFAULT 0,  -- ms
  engaged_ms       INTEGER  NOT NULL DEFAULT 0,
  out_of_range_ms  INTEGER  NOT NULL DEFAULT 0,
  mainhand         TEXT     NOT NULL DEFAULT '',
  offhand          TEXT     NOT NULL DEFAULT '',
  atk_rating       INTEGER  NOT NULL DEFAULT 0,
  haste_pct        REAL     NOT NULL DEFAULT 0,
  disciplines_used TEXT     NOT NULL DEFAULT '[]',  -- JSON array
  buffs_at_start   TEXT     NOT NULL DEFAULT '{}',  -- JSON object
  pct_in_green     REAL     NOT NULL DEFAULT 0,
  total_rounds     INTEGER  NOT NULL DEFAULT 0,
  weave_attempts   INTEGER  NOT NULL DEFAULT 0,
  weave_landed     INTEGER  NOT NULL DEFAULT 0,
  avg_reaction_ms  REAL,
  timestamp        BIGINT   NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mob_dps ON records(mob_name, total_dps DESC);
CREATE INDEX IF NOT EXISTS idx_char    ON records(character_name);
CREATE INDEX IF NOT EXISTS idx_server  ON records(server_name);
CREATE INDEX IF NOT EXISTS idx_ts      ON records(timestamp DESC);
