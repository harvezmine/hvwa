-- src/db/quest-counsel.sql — PLATFORM schema, migration step 10 (see MIGRATIONS in index.ts): the Guildmaster's
-- counsel on a story quest's case (src/quest/counsel.ts). One row per counsel a player has heard. It is paid with a
-- magic scroll from the merchant (range_scrolls: that row is marked used, used_lab = 'quest:<quest>:<chapter>'), so
-- nothing is spent here. The words live in the story; this only says who has heard which. Frozen once released.

CREATE TABLE quest_counsel (
  user_id  INTEGER NOT NULL,
  quest_id TEXT NOT NULL,
  chapter  INTEGER NOT NULL,
  tier     INTEGER NOT NULL,
  heard_at INTEGER NOT NULL,  -- ms epoch
  PRIMARY KEY (user_id, quest_id, chapter, tier)
);
