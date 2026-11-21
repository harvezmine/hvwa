-- src/db/range.sql — PLATFORM schema, migration step 4 (see MIGRATIONS in index.ts): the range (portal mode, src/range,
-- spec 2026-11-20 range §4-§6). Frozen once released. Progress is keyed by users.id, never by hvwa_sid; an instance
-- record keeps the SHA-256 of its flag, never the flag.

CREATE TABLE range_solves (
  user_id   INTEGER NOT NULL,
  lab_id    TEXT    NOT NULL,
  level     TEXT    NOT NULL,          -- the best level proved so far
  points    INTEGER NOT NULL,
  solved_at INTEGER NOT NULL,          -- ms: when this best was reached (the leaderboard's tie-break)
  PRIMARY KEY (user_id, lab_id)
);

-- cost is captured at unlock time so scoring never depends on the registry.
CREATE TABLE range_hint_unlocks (
  user_id     INTEGER NOT NULL,
  lab_id      TEXT    NOT NULL,
  tier        INTEGER NOT NULL,
  cost        INTEGER NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, lab_id, tier)
);

-- The compact POC (spec §16) has no FIFO queue and no Extend: nothing writes 'queued', and expires_at is fixed at
-- start + the maximum lifetime. The state is kept in the CHECK so a queue can return without rebuilding the table.
CREATE TABLE range_instances (
  id           TEXT    PRIMARY KEY,    -- 128-bit random, base32 lower case (26 chars); also the host i-<id>.<domain>
  user_id      INTEGER NOT NULL,
  lab_id       TEXT    NOT NULL,
  level        TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'stopping', 'stopped', 'failed')),
  reason       TEXT,                   -- why it stopped or failed: a closed set of codes (src/range/lifecycle.ts)
  flag_hash    TEXT,                   -- hex SHA-256 of the instance's flag; NULL at Divine (no flag)
  created_at   INTEGER NOT NULL,       -- ms: launched
  started_at   INTEGER,                -- ms: handed to the warden
  ready_at     INTEGER,                -- ms: its health check passed
  expires_at   INTEGER,                -- ms: hard stop (start + the maximum lifetime)
  last_seen_at INTEGER,                -- ms: last request through forward-auth (flushed every 30 s)
  ended_at     INTEGER                 -- ms: stopped or failed
);
-- One active instance per user, enforced by the database too.
CREATE UNIQUE INDEX range_instances_one_active ON range_instances (user_id) WHERE state IN ('queued', 'starting', 'running');
CREATE INDEX range_instances_state ON range_instances (state, created_at);
CREATE INDEX range_instances_flag ON range_instances (user_id, lab_id, flag_hash);
