-- src/db/quest.sql — PLATFORM schema, migration step 9 (see MIGRATIONS in index.ts): the story quests (src/quest).
-- One row per chapter a player has finished: the prologue when they accept the quest, a case chapter when the server
-- has checked their answer. Nothing else is stored: the story and the answers live in the code, so a chapter's state is
-- "done" or "not yet". Frozen once released.

CREATE TABLE quest_progress (
  user_id INTEGER NOT NULL,
  quest_id TEXT NOT NULL,
  chapter INTEGER NOT NULL,
  done_at INTEGER NOT NULL,  -- ms epoch
  PRIMARY KEY (user_id, quest_id, chapter)
);
