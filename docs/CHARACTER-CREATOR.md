# Choose your avatar

Players pick their adventurer from a fixed roster of illustrated heroes. This replaces the earlier plan for a
layered character builder.

## How it works

- **Roster:** `HEROES` in `src/range/avatar.ts`. Each hero has an `id`, a class (`hero.cls.<cls>` in i18n) and a
  banner colour (`[data-color]` in `app.css`). The name and the "good at" line live in i18n as `hero.<id>.name` and
  `hero.<id>.desc`.
- **Art:** `src/public/art/heroes/` holds two files per hero:
  - `<id>.webp`: the full portrait, 760 px tall, transparent background.
  - `<id>-face.webp`: a 256 × 256 head crop, used for the medallions.
- **Storage:** the `avatars` table (migration 6) stores `{"hero":"<id>"}` as JSON.
  - No row means the chooser was never offered, so Mira's preboarding popup invites the player.
  - "Skip" stores the default hero (`faelan`) with `skipped = 1`.
  - A hero that has left the roster reads as the default.
- **Pages:**
  - `/adventurer` is the chooser: Mira, a lit stage showing the selected hero, the roster grid and "Surprise me".
  - `core/views/avatar.ejs` draws the portrait on the licence, the account button and the Hall of Fame.

## Adding a hero

1. Make the two files from a transparent portrait. The scratch tool that built the first 12 trims the image, scales it
   to 760 px tall and crops a square head; adjust the crop per hero if the face sits off-centre.
2. Add the hero to `HEROES` with a class and a colour.
3. Add `hero.<id>.name` and `hero.<id>.desc` to `src/core/i18n.ts`, plus `hero.cls.<cls>` for a new class. Write the
   `desc` line in Mira's voice and tie it to a CTF skill.
4. Run `tests/range-avatar.spec.ts`. It checks that every hero has both files.

## Source of the first 12

The project owner supplied four free character packs: "Character Pack 2", "Free Characters Pack 3", "Free Elfs" and
"Free Medieval Pack". The picks were kept to fantasy outfits, with modern jackets left out. **Check each pack's
licence for public or commercial use before release.**
