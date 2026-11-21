# Courier (r02) — Broken access control (Easy)

Courier is a parcel-tracking customer portal with a small JSON API. Getting a session is trivial (demo mode); the flaw
is that parcel resources do not consistently check *ownership*. The flag is parcel 1001's private delivery `note`
(owned by the `vault` customer), planted at start from `HVWA_FLAG` and scrubbed from the environment. Placement is
`custom` (an in-memory record).

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

## Reference solves
`solve/acolyte.mjs` and `solve/templar.mjs` are complete HTTP clients; the reference solve contains the intended input
(an id you do not own via an unguarded route). `npm run labs:test -- --lab r02` proves each works at its level, that
Acolyte fails at Templar and Divine, and that Templar fails at Divine.
