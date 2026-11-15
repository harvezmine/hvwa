-- src/db/schema.sql — migration step 1 (see MIGRATIONS in index.ts).
-- Frozen once shipped: schema changes go in a new step, not here.
-- IF NOT EXISTS only lets step 1 adopt a pre-versioning (user_version 0) DB.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT,
  role TEXT DEFAULT 'user', email TEXT, secret_note TEXT);
CREATE TABLE IF NOT EXISTS solves (
  session_id TEXT, challenge_id TEXT, level TEXT, solved_at INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, challenge_id));
CREATE TABLE IF NOT EXISTS hint_unlocks (
  session_id TEXT, challenge_id TEXT, tier INTEGER,
  PRIMARY KEY (session_id, challenge_id, tier));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts INTEGER, session_id TEXT, kind TEXT, detail TEXT);
