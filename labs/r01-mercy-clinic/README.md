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
- `/staff/notices?token=` — token-gated staff notices (401 without the service token).
- `/patients` — staff directory (department, room, extension, bio).
- `/departments`, `/appointments`, `/opening-hours`, `/about`, `/contact` — clinic information, a seven-day session
  table and a booking request form that shows a simulated confirmation and stores nothing.
- `/healthz` — the container health check.

The seed carries 15 public notices, one innocuous staff-only rota notice, ten staff and a week of appointment rows. Only
the public notices, the staff directory and de-identified session availability are rendered. Patient labels in the
appointments seed are never displayed. At start the app also inserts a random 32-hex service token into
`staff_tokens(id, token, label)`.

## Vulnerable feature
`GET /search?q=` — the notice search. All other queries in `db.mjs` are parameterised; only the search changes per level.
Acolyte, Templar and Divine still return exactly the three columns the classic solves expect (`id`, `title`, `body`);
date, author and category are joined from the public-notice map in the server, not by changing the vulnerable SELECT.
Inquisitor adds a fourth `visibility` column and the server renders only rows whose `visibility` is `'public'`.

## The staff notice route
`GET /staff/notices?token=` exists at every level. A matching service token renders the staff notices — including the
planted flag at the exploitable levels — and a missing or wrong token returns 401. The token lives in `staff_tokens` in
the same SQLite database; only Inquisitor's injectable search can leak it. Divine's parameterised search cannot, so the
route stays 401 to anyone without the token.

## Levels
- **Acolyte.** `q` is concatenated into a `LIKE '%…%'` string literal over `visibility='public'` notices. Intended
  path: close the literal and `UNION SELECT` the staff notice's `body` (three result columns: id, title, body).
- **Templar.** The search removes the keywords `union` and `select` once (`replace(/union|select/gi,'')`) and then
  concatenates. The Acolyte payload loses its keywords and fails. Intended path: nest each keyword inside itself so a
  single removal pass rebuilds it, then run the same UNION. This is why Acolyte does not carry up: its keywords are
  deleted before the SQL is built.
- **Inquisitor.** The search is still concatenated, but its SELECT now carries four columns
  (`id, title, body, visibility`) and the server renders only rows that claim `visibility === 'public'`. A classic
  three-column UNION is now a SQL error, and the base query's `visibility='public'` still hides staff notices. Intended
  path: leak a different secret from the same database —
  `') UNION SELECT 0,'Service token',token,'public' FROM staff_tokens -- ` — read the 32-hex token out of the rendered
  "Service token" row, then call `/staff/notices?token=<token>` to read the staff notices, flag included. Acolyte and
  Templar do not carry up: their three-column payloads error against this query.
- **Divine.** The search is a prepared statement with the `%q%` value bound and `visibility='public'` fixed in SQL.
  `q` can never become SQL syntax, the staff notice is unreachable and the service token never leaks, so
  `/staff/notices` stays 401. No flag exists; a decoy staff notice explains it.

## Reference solves
`solve/acolyte.mjs`, `solve/templar.mjs` and `solve/inquisitor.mjs` are HTTP clients; each contains the intended input
for its level. The Inquisitor solve performs the two-step chain (leak the token by UNION, then use it on
`/staff/notices`) and prints only the flag. `npm run labs:test -- --lab r01` is the proof: each solve gets its own flag,
the lower-level inputs fail at every higher level, only the Inquisitor input reaches the staff notices, and Divine
resists all three.
