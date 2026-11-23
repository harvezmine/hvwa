-- src/db/shop.sql — PLATFORM schema, migration step 7 (see MIGRATIONS in index.ts): the merchant's magic scrolls
-- (src/range/shop.ts). Frozen once released.
-- One row per scroll bought. Its price is spent at purchase (rangeScore subtracts it, like a paid hint unlock used to);
-- a scroll stays in the player's bag (used_at = 0) until they hand it to the Guildmaster on a quest, which marks it
-- used and unlocks that quest's counsel of the scroll's tier (range_hint_unlocks, with cost 0: the gold is already
-- spent). kind is one of shop.ts's SCROLLS.

CREATE TABLE range_scrolls (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  cost       INTEGER NOT NULL,
  bought_at  INTEGER NOT NULL,           -- ms epoch
  used_lab   TEXT    NOT NULL DEFAULT '',
  used_tier  INTEGER NOT NULL DEFAULT 0,
  used_at    INTEGER NOT NULL DEFAULT 0  -- ms epoch; 0 while still in the bag
);
CREATE INDEX range_scrolls_user ON range_scrolls (user_id, used_at);
