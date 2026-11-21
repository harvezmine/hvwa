# Postcard (r04) — Server-side template injection (Hard)

Postcard is a greeting-card maker on real Flask/Jinja2. The card preview renders the operator's message. At the lower
levels the message becomes Jinja2 template source (SSTI). The flag is a file (`/tmp/postcard/flag.txt`, in the tmpfs):
at start the app reads the one-shot flag file (`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it, then writes it
there. The flag is never in the environment. No page renders the file; only template code reading it does. Real template
execution is intentional (spec §2); the container is the boundary.

## Vulnerable feature
`POST /preview` — the card renderer (`templating.render_card`). The page chrome is a constant template; only the
message reaches Jinja as source at acolyte/templar.

## Levels
- **Acolyte.** The message is concatenated into the card template and rendered. A template expression that walks
  Python's object graph to `open()` prints the flag file into the card.
- **Templar.** The press refuses a raw `__` or any of `os/popen/import/subprocess/eval/exec`, then still renders. The
  literal Acolyte payload is caught. The same file read works if every blocked token is composed from Jinja string
  escapes / `attr`-style access so the raw message never contains one. This is why Acolyte does not carry up.
- **Divine.** The card is a constant `{{ message }}` template and the message is passed as a bound, autoescaped value,
  never as template source. No flag.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are Node HTTP clients; the reference solve contains the intended template
input for each level. `npm run labs:test -- --lab r04` proves each works at its level and that the Acolyte input fails
at Templar and Divine.
