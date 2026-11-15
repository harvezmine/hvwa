-- src/db/schema.sql
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT,
  role TEXT DEFAULT 'user', email TEXT, secret_note TEXT);
CREATE TABLE IF NOT EXISTS solves (
  session_id TEXT, challenge_id TEXT, level TEXT, solved_at INTEGER,
  PRIMARY KEY (session_id, challenge_id));
CREATE TABLE IF NOT EXISTS hint_unlocks (
  session_id TEXT, challenge_id TEXT, tier INTEGER,
  PRIMARY KEY (session_id, challenge_id, tier));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, ts INTEGER, session_id TEXT, kind TEXT, detail TEXT);
