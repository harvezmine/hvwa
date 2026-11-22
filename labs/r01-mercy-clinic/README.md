# Mercy Clinic (r01) — SQL injection (Easy)

Mercy Clinic is a community-clinic patient portal. Patients read notices and search them; staff-only notices are kept
out of every public list. The flag is the body of a staff-only notice: at start the app reads the one-shot flag file
(`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it, then plants it. The flag is never in the environment. The
databases live in the `/tmp` tmpfs (the rootfs is read-only).

Two SQLite files keep the chain honest:

- `/tmp/clinic.db` — the main clinic DB: `patients`, `notices` (public notices plus the planted staff flag) and
  `appointments`. The flag placement stays `db:notices.body` here.
- `/tmp/public.db` — the public search DB used by Inquisitor: a `notices` table seeded with only the public notices and
  `staff_tokens` holding the random 32-hex service token. It never contains a staff notice or the flag.

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
`public.db.staff_tokens(id, token, label)`.

## Vulnerable feature
`GET /search?q=` — the notice search. All other queries in `db.mjs` are parameterised; only the search changes per level.
Acolyte, Templar and Divine still return exactly the three columns the classic solves expect (`id`, `title`, `body`) from
the main clinic DB; date, author and category are joined from the public-notice map in the server, not by changing the
vulnerable SELECT. Inquisitor adds a fourth `visibility` column, runs against `public.db`, and the server renders only
rows whose `visibility` is `'public'`. Because `public.db` has no staff notices, a direct
`UNION SELECT id,title,body,'public' FROM notices WHERE visibility='staff'` reads nothing from the main DB; the token is
the only useful leak. A trailing `ATTACH DATABASE '/tmp/clinic.db'` in the injection cannot bridge them either:
`node:sqlite`'s `prepare` compiles and runs only the first statement, so the search connection never gains the main
schema.

## The staff notice route
`GET /staff/notices?token=` exists at every level. The presented token is checked against `public.db.staff_tokens`; a
match renders the staff notices — including the planted flag at the exploitable levels — read from the main
`clinic.db`. A missing or wrong token returns 401. Only Inquisitor's injectable search can leak the token. Divine's
parameterised search cannot, so the route stays 401 to anyone without it.

## Levels
- **Acolyte.** `q` is concatenated into a `LIKE '%…%'` string literal over `visibility='public'` notices. Intended
  path: close the literal and `UNION SELECT` the staff notice's `body` (three result columns: id, title, body).
- **Templar.** The search removes the keywords `union` and `select` once (`replace(/union|select/gi,'')`) and then
  concatenates. The Acolyte payload loses its keywords and fails. Intended path: nest each keyword inside itself so a
  single removal pass rebuilds it, then run the same UNION. This is why Acolyte does not carry up: its keywords are
  deleted before the SQL is built.
- **Inquisitor.** The search is still concatenated, but it now runs against `public.db` and its SELECT carries four
  columns (`id, title, body, visibility`); the server renders only rows that claim `visibility === 'public'`. A classic
  three-column UNION is a SQL error, and the flag is in a different database altogether, so there is no staff notice to
  select directly. Intended path: leak the only secret in `public.db` —
  `') UNION SELECT 0,'Service token',token,'public' FROM staff_tokens -- ` — read the 32-hex token out of the rendered
  "Service token" row, then call `/staff/notices?token=<token>` to read the staff notices, flag included, from
  `clinic.db`. Acolyte and Templar do not carry up: their three-column payloads error against this query.
- **Divine.** The search is a prepared statement with the `%q%` value bound and `visibility='public'` fixed in SQL.
  `q` can never become SQL syntax, the staff notice is unreachable and the service token never leaks, so
  `/staff/notices` stays 401. No flag exists; a decoy staff notice explains it.

## Reference solves
`solve/acolyte.mjs`, `solve/templar.mjs` and `solve/inquisitor.mjs` are HTTP clients; each contains the intended input
for its level. The Inquisitor solve performs the two-step chain (leak the token by UNION, then use it on
`/staff/notices`) and prints only the flag. `npm run labs:test -- --lab r01` is the proof: each solve gets its own flag,
the lower-level inputs fail at every higher level, only the Inquisitor input reaches the staff notices, and Divine
resists all three.
