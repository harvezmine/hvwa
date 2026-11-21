# Courier (r02) — Broken access control (Easy)

Courier is a parcel-tracking customer portal with a small JSON API. Getting a session is trivial (demo mode); the flaw
is that parcel resources do not consistently check *ownership*. The flag is parcel 1001's private delivery `note`
(owned by the `vault` customer): at start the app reads the one-shot flag file (`HVWA_FLAG_FILE`, default
`/tmp/.hvwa-flag`), unlinks it, then plants it. The flag is never in the environment. Placement is `custom` (an
in-memory record).

## The portal

The customer-facing site is seeded, read-only and offline: an orange/navy logistics identity (inline SVG mark and
favicon, no external assets), a landing page with a "Continue as demo" explanation, a dashboard of parcel cards
(status chips, service/weight/ETA, a depot → in transit → out for delivery → delivered progress track), a tracking
page with scan history, and `/account`, `/support`, `/pricing`, `/faq` and `/signin` pages. A small client-side
refresh on the dashboard mints a demo token from `POST /api/session` and re-reads `GET /api/parcels` — the natural
place to watch the API in action with developer tools. The dashboard intentionally renders no private notes; notes
appear only on a label.

The label route content-negotiates. `GET /api/parcels/:id/label` with `Accept: text/html` returns a printable label
page (address, service details, barcode block, print styles, private note); any other `Accept` value returns the
existing JSON. The authorization decision is made before the representation is chosen, so the levels and reference
solves are unchanged (the solves use `fetch` with `*/*` and receive JSON).

## Vulnerable feature
The parcel API: `GET /api/parcels/:id`, `GET /api/parcels/:id/label`, `GET /api/parcels/:id/events`. The browser
dashboard shows only the demo customer's own parcels.

## Levels
- **Acolyte.** No route checks ownership. Open a demo session, enumerate the 1xxx id block, read the foreign note.
- **Templar.** `:id` (detail) now checks ownership and returns 403 for foreign parcels, so the Acolyte path fails. The
  `:id/label` sibling was not updated and still returns any parcel's label (with the note). The label route is
  discoverable from your own dashboard's "Print label" links. This is why Acolyte does not carry up.
- **Divine.** One `requireOwner` guard runs on every parcel route, comparing owner to the authenticated session. Every
  foreign id is 403. No flag; parcel 1001's note is a decoy.

## Seed data
`seed/parcels.json` holds seven demo parcels (2001–2007) and six vault parcels (1001–1006), each with a sender,
service level, weight, ETA, ordinary scan events and a mundane decoy note. Parcel 1001 remains the flag carrier; its
seed note is replaced at start. No other record contains the flag.

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are complete HTTP clients; the reference solve contains the intended input
(an id you do not own via an unguarded route). `npm run labs:test -- --lab r02` proves each works at its level, that
Acolyte fails at Templar and Divine, and that Templar fails at Divine.
