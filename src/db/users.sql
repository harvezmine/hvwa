-- src/db/users.sql — PLATFORM schema, migration step 3 (see MIGRATIONS in index.ts): the login generalised to many
-- users (src/auth, spec 2026-11-20 range §4) and the range's admin switches. Frozen once released.
-- The admin row of step 2 moves over with its hash, backoff and default-password state, and auth_tokens is not
-- touched (it joins users by username, which is unique and never renamed): an upgraded lite database keeps its
-- password, its signed-in browsers and its progress (solves and hint_unlocks are keyed by hvwa_sid).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,           -- scrypt$N$r$p$<salt>$<key>, base64url
  role          TEXT    NOT NULL CHECK (role IN ('player', 'admin')),
  created_at    INTEGER NOT NULL,           -- ms epoch
  disabled      INTEGER NOT NULL DEFAULT 0, -- 1: no sign-in, no session, no instance
  is_default    INTEGER NOT NULL DEFAULT 0, -- 1 while a password someone else chose is in use (the banner)
  failures      INTEGER NOT NULL DEFAULT 0, -- consecutive failed checks (brute-force backoff)
  locked_until  INTEGER NOT NULL DEFAULT 0, -- ms epoch; checks before it are refused
  changed_at    INTEGER NOT NULL            -- ms epoch of creation or the last password change
);
-- Unique whatever the case ('Alice' cannot sit next to 'alice'); the plain index serves exact sign-in lookups.
CREATE UNIQUE INDEX users_username_nocase ON users (username COLLATE NOCASE);
CREATE INDEX users_username ON users (username);

INSERT INTO users (username, password_hash, role, created_at, disabled, is_default, failures, locked_until, changed_at)
  SELECT username, password_hash, 'admin', changed_at, 0, is_default, failures, locked_until, changed_at FROM auth_accounts;
DROP TABLE auth_accounts;

-- The admin's switches in portal mode (key/value: registration_open, event_code). The compact POC (spec §16) has no
-- admin pages and no event code: registration follows HVWA_REGISTRATION_OPEN, so nothing writes this table yet. It
-- is kept so those switches can return without another migration.
CREATE TABLE range_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
