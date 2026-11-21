# Mercy Clinic (r01) — SQL injection (Easy)

Mercy Clinic is a community-clinic patient portal. Patients read notices and search them; staff-only notices are kept
out of every public list. The flag is the body of a staff-only notice: at start the app reads the one-shot flag file
(`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it, then plants it. The flag is never in the environment. The
database lives in the `/tmp` tmpfs (the rootfs is read-only).

## The portal
The app is a small, fully offline clinic site with its own teal/cream CSS and inline SVG only:

- `/` — hero, live open/closed status, next flu clinic, latest notices, team preview and notice search.
- `/notices` and `/notices/:id` — every public notice as a dated, authored card; detail pages carry related notices.
- `/search?q=` — **the vulnerable feature**.
- `/patients` — staff directory (department, room, extension, bio).
- `/departments`, `/appointments`, `/opening-hours`, `/about`, `/contact` — clinic information, a seven-day session
  table and a booking request form that shows a simulated confirmation and stores nothing.
- `/healthz` — the container health check.

The seed carries 15 public notices, one innocuous staff-only rota notice, ten staff and a week of appointment rows. Only
the public notices, the staff directory and de-identified session availability are rendered. Patient labels in the
appointments seed are never displayed.

## Vulnerable feature
`GET /search?q=` — the notice search. All other queries in `db.mjs` are parameterised; only the search changes per level.
The search still returns exactly the three columns the reference solves expect (`id`, `title`, `body`); date, author and
category are joined from the public-notice map in the server, not by changing the vulnerable SELECT.

## Levels
- **Acolyte.** `q` is concatenated into a `LIKE '%…%'` string literal over `visibility='public'` notices. Intended
  path: close the literal and `UNION SELECT` the staff notice's `body` (three result columns: id, title, body).
- **Templar.** The search removes the keywords `union` and `select` once (`replace(/union|select/gi,'')`) and then
  concatenates. The Acolyte payload loses its keywords and fails. Intended path: nest each keyword inside itself so a
  single removal pass rebuilds it, then run the same UNION. This is why Acolyte does not carry up: its keywords are
  deleted before the SQL is built.
- **Divine.** The search is a prepared statement with the `%q%` value bound and `visibility='public'` fixed in SQL.
  `q` can never become SQL syntax and the staff notice is unreachable. No flag exists; a decoy staff notice explains it.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are HTTP clients that read the flag out of the search results; the
reference solve contains the intended injection input for each level. `npm run labs:test -- --lab r01` is the proof:
each solve gets its own flag, the Acolyte input fails at Templar and Divine, and the Templar input fails at Divine.
