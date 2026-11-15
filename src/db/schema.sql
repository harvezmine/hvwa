-- src/db/schema.sql — PLATFORM schema, migration step 1 (see MIGRATIONS in index.ts).
-- Platform state only: solves, hint unlocks, events. Challenge data (users,
-- products, ...) lives in each challenge's own DB via core/challenge-db.ts.
-- Frozen once released: schema changes go in a new migration step.

CREATE TABLE solves (
  session_id   TEXT    NOT NULL,
  challenge_id TEXT    NOT NULL,
  level        TEXT    NOT NULL,
  points       INTEGER NOT NULL DEFAULT 0,
  solved_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, challenge_id)
);

-- cost is captured at unlock time so scoring never depends on the registry.
CREATE TABLE hint_unlocks (
  session_id   TEXT    NOT NULL,
  challenge_id TEXT    NOT NULL,
  tier         INTEGER NOT NULL,
  cost         INTEGER NOT NULL,
  unlocked_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (session_id, challenge_id, tier)
);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  ts         INTEGER NOT NULL,
  session_id TEXT,
  kind       TEXT    NOT NULL,
  detail     TEXT
);
