-- src/db/teams.sql — PLATFORM schema, migration step 5 (see MIGRATIONS in index.ts): teams and team mode
-- (src/range/teams.ts, src/range/modes.ts, src/range/activity.ts). Frozen once released.
-- A team keeps only its name and join code (no secret beyond the code); membership is one team per user.

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  join_code  TEXT    NOT NULL UNIQUE,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Unique whatever the case ('Blue' cannot sit next to 'blue').
CREATE UNIQUE INDEX teams_name_nocase ON teams (name COLLATE NOCASE);

-- One team per user: user_id is UNIQUE. PRIMARY KEY (team_id, user_id) plus the index on team_id for membership lists.
CREATE TABLE team_members (
  team_id   INTEGER NOT NULL,
  user_id   INTEGER NOT NULL UNIQUE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_team ON team_members (team_id);

-- Per-lab scoring mode. The default (individual) is implicit: no row means individual.
CREATE TABLE lab_modes (
  lab_id     TEXT    PRIMARY KEY,
  mode       TEXT    NOT NULL CHECK (mode IN ('individual', 'team')),
  updated_at INTEGER NOT NULL,
  updated_by INTEGER
);

-- The activity feed for the later admin dashboard (src/range/activity.ts). `detail` carries machine-readable
-- context only (points, reason codes); it never carries a flag, token or secret.
CREATE TABLE activity_log (
  id        INTEGER PRIMARY KEY,
  at        INTEGER NOT NULL,
  user_id   INTEGER,
  username  TEXT,
  team_id   INTEGER,
  team_name TEXT,
  event     TEXT    NOT NULL,
  lab_id    TEXT,
  level     TEXT,
  detail    TEXT,
  ip        TEXT
);
CREATE INDEX activity_at ON activity_log (at);
CREATE INDEX activity_event_at ON activity_log (event, at);
CREATE INDEX activity_user_at ON activity_log (user_id, at);
