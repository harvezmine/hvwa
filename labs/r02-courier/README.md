# Courier (r02) — Broken access control (Easy)

Courier is a parcel-tracking customer portal with a small JSON API. Getting a session is trivial (demo mode); the flaw
is that parcel resources do not consistently check *ownership*. From Inquisitor up each customer also has an API key and
parcel routes demand the owner's key — but support hands any customer's key to any session, so a demo session plus the
vault key still reads the vault parcel. Each tier hides the flag on a different parcel surface: the delivery `note` of
parcel 1001 (Acolyte), the label copy of a random vault parcel (Templar), or the manifest of a random vault parcel
(Inquisitor). At start the app reads the one-shot flag file (`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), unlinks it,
then plants it on that surface. The flag is never in the environment. Placement is `custom` (an in-memory record).

## The portal

The customer-facing site is seeded, read-only and offline: an orange/navy logistics identity (inline SVG mark and
favicon, no external assets), a landing page with a "Continue as demo" explanation, a dashboard of parcel cards
(status chips, service/weight/ETA, a depot → in transit → out for delivery → delivered progress track), a tracking
page with scan history, and `/account`, `/support`, `/pricing`, `/faq` and `/signin` pages. A small client-side
refresh on the dashboard mints a demo token from `POST /api/session` and re-reads `GET /api/parcels` — the natural
place to watch the API in action with developer tools. The dashboard intentionally renders no private notes; notes
appear only on a label.

The label route content-negotiates. `GET /api/parcels/:id/label` with `Accept: text/html` returns a printable label
page (address, service details, barcode block, print styles, label copy); any other `Accept` value returns the existing
JSON, which now carries both `note` and `labelNote`. The authorization decision is made before the representation is
chosen (the solves use `fetch` with `*/*` and receive JSON).

## Vulnerable feature
The parcel API: `GET /api/parcels/:id`, `GET /api/parcels/:id/label`, `GET /api/parcels/:id/events`. The detail
response carries `note` and `manifest`; the label response carries `note` and `labelNote`. The browser dashboard shows
only the demo customer's own parcels. From Inquisitor up there is also `GET /api/support/customers/:id` (bearer session
required), which returns `{ customer, apiKey, parcels }` for any customer id — including `vault` — instead of only the
session's own account.

## Levels
- **Acolyte.** No route checks ownership. Open a demo session, enumerate the 1xxx id block, read the foreign note.
  Parcel 1001 is the flag carrier at this tier.
- **Templar.** `:id` (detail) now checks ownership and returns 403 for foreign parcels, so the Acolyte path fails. The
  `:id/label` sibling was not updated and still returns any parcel's label. The flag has also moved: it is the
  `labelNote` of a random vault parcel (never 1001), while every note is a decoy. Read the label copies across the
  1xxx block. The label route is discoverable from your own dashboard's "Print label" links. This is why Acolyte does
  not carry up.
- **Inquisitor.** A response to the partial fixes: every parcel route now also requires `X-Api-Key` matching the
  *parcel owner's* key, minted randomly at start (`demo` and `vault`). The bearer session still exists but the key is
  not bound to it. The remaining flaw is the support lookup: with a demo bearer, ask
  `GET /api/support/customers/vault` for the vault key and parcel list, then send `Authorization: Bearer <demo>` **and**
  `X-Api-Key: <vault key>` to `GET /api/parcels/<id>` for those ids. The flag is the `manifest` of a random vault parcel
  (never 1001); notes and label copies are decoys. The portal never displays a key; support is the only way one leaves
  the server. The Acolyte and Templar solves send no key and fail here.
- **Divine.** Every parcel route requires both the session owner and the key owner to equal the parcel owner, and
  support returns only the session's own key (403 for any other id). Every foreign id is 403. No flag; all three
  surfaces are decoys.

## Seed data
`seed/parcels.json` holds seven demo parcels (2001–2007) and six vault parcels (1001–1006), each with a sender,
service level, weight, ETA, ordinary scan events and a mundane decoy note. The store adds a `labelNote` and a
`manifest` to every parcel. Acolyte replaces parcel 1001's note with the flag; Templar picks a random vault parcel
(never 1001) and replaces its label copy; Inquisitor picks a random vault parcel (never 1001) and replaces its
manifest. Every other surface is a decoy, so no record exposes the flag on a page the portal renders.

## Reference solves
`solve/acolyte.mjs`, `solve/templar.mjs` and `solve/inquisitor.mjs` are complete HTTP clients; each contains the
intended input for its level (the unguarded detail note, the unguarded label copy, then the support IDOR → demo bearer
+ vault API key → manifest). `npm run labs:test -- --lab r02` proves each works at its level, that Acolyte fails at
Templar, Inquisitor and Divine, that Templar fails at Inquisitor and Divine, that Inquisitor fails at Divine (support is
403), and that Divine resists every solve.
