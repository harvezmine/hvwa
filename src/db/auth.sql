-- src/db/auth.sql — PLATFORM schema, migration step 2 (see MIGRATIONS in index.ts): the platform login
-- (src/auth). Frozen once released: schema changes go in a new migration step.
-- Nothing here is a secret in plaintext: an account keeps only its scrypt hash, a token only its SHA-256.

-- One row: admin. Created on first start with auth on (HVWA_ADMIN_PASSWORD, else the default 'password').
CREATE TABLE auth_accounts (
  username      TEXT    PRIMARY KEY,
  password_hash TEXT    NOT NULL,           -- scrypt$N$r$p$<salt>$<key>, base64url
  is_default    INTEGER NOT NULL,           -- 1 while the default password is in use (the banner)
  failures      INTEGER NOT NULL DEFAULT 0, -- consecutive failed checks (brute-force backoff)
  locked_until  INTEGER NOT NULL DEFAULT 0, -- ms epoch; checks before it are refused
  changed_at    INTEGER NOT NULL            -- ms epoch of creation or the last password change
);

-- Signed-in browsers: the hvwa_auth cookie carries the token; only its SHA-256 (hex) is stored.
CREATE TABLE auth_tokens (
  token_hash   TEXT    PRIMARY KEY,
  username     TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,            -- absolute expiry counts from here
  last_seen_at INTEGER NOT NULL             -- idle expiry counts from here
);
CREATE INDEX auth_tokens_by_user ON auth_tokens (username);
