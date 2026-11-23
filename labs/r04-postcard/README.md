# Postcard (r04) — Server-side template injection (Hard)

Postcard is a greeting-card maker on real Flask/Jinja2. The card preview renders the operator's message. At the lower
levels the message becomes Jinja2 template source (SSTI). Each tier files the flag differently: Acolyte keeps the whole
flag at `/tmp/postcard/flag.txt`; Templar tears it into a random pair under `/tmp/postcard/outbox`; Inquisitor tears it
into a random pair under `/tmp/postcard/archive/<random>`. Each split directory also holds decoy pairs, so only the
real pair joins into a valid flag. At start the app reads the one-shot flag file (`HVWA_FLAG_FILE`, default
`/tmp/.hvwa-flag`), unlinks it, then plants the tier's files. The flag is never in the environment. No page renders the
flag in full; only template code reading the files does. Real template execution is intentional (spec §2); the
container is the boundary.

## The studio

The visible app is a small handmade-card studio, not a bare demo form:

- **Home (`/`)** — a hero, a working card maker that replaces the old style `<select>` with ten visual style swatches
  (each with its own palette, type and ornament), a "fresh off the press" strip, and a studio promise panel.
- **Gallery (`/gallery`)** — all ten seeded cards with occasion filters (`?occasion=wedding`, GET, escaped), sample text,
  font, price and delivery time.
- **Preview (`POST /preview`)** — the rendered card front on a 3D flip, a static front/back toggle (CSS checkbox),
  print-only CSS, style metadata, an "Edit message" link back to the swatches, and a "Send this card" button that shows
  a simulated confirmation. At Inquisitor the preview does not render at all: it saves a bounded, in-memory draft and
  returns "Draft saved for printing" with a link to the print stage.
- **Print stage (`GET /orders/<id>/print`)** — renders a saved draft inside the card. Drafts live in process memory, at
  most 32 at a time (oldest evicted), with random ids.
- **Studio pages** — `/orders` (a seeded print queue), `/pricing`, `/about`, `/faq`, `/shipping`, `/contact`. A shared
  header carries a static status widget ("Studio open / press queue: 3 cards ahead / order by 2 pm for same-day").
- **Identity** — rose and plum palette, card-stock textures, per-occasion ornaments and borders, an inline studio mark
  and `/favicon.svg`, a styled Templar rejection card, styled 404/405/500 pages, subtle transitions that stop under
  `prefers-reduced-motion`, and a 375 px-friendly layout. Everything is inline SVG and CSS; no external assets.

The seed at `seed/cards.json` holds ten cards with `style`, `occasion`, `sample`, `palette`, `font`, `price` and
`delivery`. The occasion slug is the card's CSS class (`birthday`, `thanks`, `congrats`, `wedding`, `newbaby`,
`anniversary`, `getwell`, `sympathy`, `justbecause`, `seasonal`).

## Vulnerable feature

The card renderer (`templating.render_card`). At Acolyte and Templar, `POST /preview` renders the message directly; at
Inquisitor the preview only saves the message as a draft and `GET /orders/<id>/print` renders it — a second-order SSTI
through the print step. The page chrome is a constant template, and the studio chrome, gallery, pages and contact form
escape every reflected value; the card message is the one value that goes through the designed renderer at its sink.

## Levels

- **Acolyte.** The message is concatenated into the card template and rendered. A template expression that walks
  Python's object graph to `open()` prints `/tmp/postcard/flag.txt` into the card.
- **Templar.** The press refuses a raw `__` or any of `os/popen/import/subprocess/eval/exec`, then still renders. The
  literal Acolyte payload is caught and shown as a styled rejection card. The flag is also no longer at the Acolyte
  path: it is torn into a random pair under `/tmp/postcard/outbox`, beside decoy pairs. The same object-graph read
  works if every blocked token is composed from Jinja string escapes / `attr`-style access, and the outbox path is
  split too; list the outbox, then join a candidate pair. This is why Acolyte does not carry up.
- **Inquisitor.** The preview no longer renders the message. It saves it as a bounded draft (≤32, random id) and hands
  back a "Draft saved for printing" page carrying `data-draft="<id>"` and a `/orders/<id>/print` link. The print stage
  renders the saved message with the normal Jinja renderer (second-order SSTI). The flag has moved again: it is a
  random pair under `/tmp/postcard/archive/<random>`, so the print-stage payload lists the archive and joins the real
  pair. The Acolyte and Templar solves (which expect the flag in the `/preview` response, or the known path) fail here.
- **Divine.** Both the `/preview` card and the `/orders/<id>/print` proof are constant `{{ message }}` templates; the
  message is passed as a bound, autoescaped value, never as template source. `/tmp/postcard/flag.txt` is a decoy and no
  split pair exists. No flag.

## Reference solves

`solve/acolyte.mjs`, `solve/templar.mjs` and `solve/inquisitor.mjs` are Node HTTP clients; each contains the intended
template input for its level. The Templar solve lists the outbox and joins candidate pairs; the Inquisitor solve reads
the draft id from `data-draft`, requests `/orders/<id>/print`, lists the random archive directory and joins the real
pair. `npm run labs:test -- --lab r04` proves each works at its level, that lower-level solves fail at Inquisitor, and
that Divine resists every solve.
