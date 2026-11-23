-- src/db/avatars.sql — PLATFORM schema, migration step 6 (see MIGRATIONS in index.ts): the adventurer each player
-- made in the guild's character creator (src/range/avatar.ts). Frozen once released.
-- One row per user once they made (or skipped) their adventurer: no row means the creator has not been offered yet.
-- `spec` is a JSON object of part ids (class, body, skin, eyes, hair, outfit colour, accessory, heraldry), every value
-- one of avatar.ts's fixed lists: validated on write, and a value no longer listed reads as the default.
-- skipped = 1 marks the default adventurer of someone who chose "skip".

CREATE TABLE avatars (
  user_id    INTEGER PRIMARY KEY,
  spec       TEXT    NOT NULL,
  skipped    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL           -- ms epoch
);
