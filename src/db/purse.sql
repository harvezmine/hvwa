-- src/db/purse.sql — PLATFORM schema, migration step 8 (see MIGRATIONS in index.ts): which players have been shown the
-- starter purse popup (src/range/shop.ts takeStarterNotice). Frozen once released. The starter purse itself is not
-- stored: every account holds it (progress.ts STARTER_PURSE), so it is the same for everyone, old accounts included.

CREATE TABLE range_gift_seen (
  user_id INTEGER PRIMARY KEY,
  seen_at INTEGER NOT NULL  -- ms epoch: when the popup was rendered
);
