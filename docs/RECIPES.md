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
  - `curl.ts`: `curlFor(req, res, { path, method?, headers?, cookies?, data?, form?, signIn? })` → `CurlView`, `shellQuote(text)`,
    with the partial `views/curl-note.ejs`: a curl line that can work. It carries the full quoted URL, `-X <method>`
    (PUT, PATCH ...), the headers it needs, `-d '<json>'` and/or `--data-urlencode 'name=value'` (values are
    shell-quoted), and `-b "hvwa_sid=<copy from devtools>"`. Never print the sid: a lab belongs to the browser session,
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
| `sendSimRedirect(res, location, status?)` | `core/sim` | a real route answering a level's redirect: a citadel URL goes to the same place in the lab, anything else gets a "your browser would go to ..." page, never a real redirect off the lab (section 8) |
| `Reply`, `toSim(reply)`, `sendReply(res, reply, render)`, `cookiePath(base)`, `TwinCookie` | `core/sim` (`core/twin.ts`) | one page answer for both browsers: a `SimResponse` for the citadel handler, the real route's answer (cookies with their attributes, redirects through `sendSimRedirect`, a forward as a note) (section 8) |
| `visitOf(req, res, cookieNames)`, `simVisitOf(level, r, cookieNames?)`, `Visit` | `core/sim` (`core/twin.ts`) | what a page function needs from either browser's request: level, raw query, the lab's own cookies, `base` (section 8) |
| `REDIRECT_STATUSES` | `core/sim` | the statuses a browser follows a `Location` on (301, 302, 303, 307, 308) |
| `parseMultipart(req, limits?)`, `settle(p)`, `UPLOAD_LIMITS`, `UploadError` | `core/upload` | upload labs: the raw multipart body `express.raw` read on the upload route, parsed and capped; `tryDb(req, await settle(parseMultipart(req)), 'Upload error')` (section 9) |
| `looksLikeImage(bytes)`, `sniffImage(bytes)`, `placeholderImage(sniff)` | `core/upload` | PNG/JPEG/GIF/WebP magic bytes and size, from the header ONLY (SC-09's polyglot lesson; never a safety check); the constant-size GIF a safe level serves instead (section 9) |
| `readZip(bytes, limits?)`, `ZIP_LIMITS` | `core/upload-zip` | an archive's entries (names exactly as written, bytes), with a zip-bomb guard; synchronous, inside `tryDb` (section 9) |
| `simFs(opts?)`, `resolveSimPath(path, separators?)`, `SIMFS_LIMITS` | `core/simfs` | one player's simulated file system per level, made in the `perSession` factory; paths resolved by the simulated OS's rules (section 9) |
| `simInterpret(bytes, canary)` | `core/simfs` | the "webshell": nothing executes; prints the canary if the file holds `<?hvwa CANARY ?>` (section 9) |

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
keys: `escapeFn include rethrow __append __output locals body t lang challenge level labBar labPath simPanel`.

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
worst cross join of its own tables and put the number next to its caps.

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
string, not a 500.

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
  and defaults `<title>` to `<id> — <title>`. Do not repeat these in the view.
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
example is the fixture lab SV-01 in `tests/sim-lab.spec.ts`.

Import everything from `core/sim.ts`, a barrel over the pure simulation in `core/sim/` (`limits.ts`: `SIM_LIMITS` and
the copying clip; `url.ts`: the hosts and `classifySimUrl`; `cookies.ts`: the jar; `browser.ts`: `SimBrowser`;
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
  visits (`world.visits`) and a clock (`world.now`, a test seam like `state.now`).
- **`world.inbox`**: fixed mailboxes, `PLAYER_MAILBOX` (`pilgrim@citadel.test`) always plus the ones named (usually
  `ADMIN_MAILBOX`); mail to any other address bounces (`deliver()` returns `undefined`), so no map is keyed by attacker
  input. `deliver({ from, to, subject, body, links })`, `newest(address)`, `list(address)` (newest first). Links are an
  explicit list: "the admin clicks the first link" is `links[0]`.
- **`world.attackerLog`**: append-only, capped (oldest dropped, sequence numbers keep counting): method, URL, `Referer`,
  form body, time.
- **`world.browser(handler)`**: a victim's browser. `follow(url, { referrer? })` opens a link, `submit(url, form)` posts a
  form; both return a `SimVisit` trace (`outcome`: `page` | `attacker` | `unreachable` | `too-many-redirects` | `loop`,
  the `hops`, and the final citadel `page`). Its cookie jar (`browser.cookies`) holds citadel.test cookies only, never
  real ones and never sent to attacker.test; `cookies.set()` signs the victim in up front. Every citadel request calls
  `handler(req: SimRequest): SimResponse` synchronously: `req` has `method`, `url`, `path`, `query`
  (URLSearchParams), lower-case `headers`, `cookies` and form `body` (null prototypes; `field()` and `header()` work on
  it); the response is `{ status, headers?, body? }`, where `Location` (followed on 301, 302, 303, 307 and 308 only:
  any other status, a 300 or 304 with a Location included, is a page), `Set-Cookie`, `Refresh` and `Referrer-Policy`
  are honoured. At most 10 redirects; the same request again with the jar unchanged is a loop.
- **Referer, as real browsers send it**: a link opened from mail has none; `follow(url, { referrer })` is a click on a
  citadel page. **A redirect keeps the referrer of the page that started the navigation** (an open redirect does not leak
  its own URL). **A citadel page that moves the browser on by itself sends its own URL**: answer
  `200` with `Refresh: 0; url=<next>` (the stand-in for a meta refresh or a script; the sim does not parse HTML).
  `Referrer-Policy` on that page (or on a redirect) applies; the default is the legacy full URL
  (`no-referrer-when-downgrade`). The Referer never carries userinfo or a fragment, and nothing ever comes FROM attacker.test.
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
  browser 1.47 MiB; a simulated file system (section 9) weighs 352 KiB. An instance weighs everything its factory built
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
  it with `cappedBudgetUsage()` (`{ bytes, instances, budget }`).

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
  browsers get the same attributes. `httpOnly: false` is for a cookie the lab means to be read or edited client-side.
  `sameSite: 'Strict' | 'Lax' | 'None'`: a lab whose lesson is SameSite (CSRF) sets it per level IN THE LEVEL FILE, so
  View Source and the Diff show it (Acolyte's `sameSite: 'None'` with `secure: true` is the realistic
  misconfiguration). Any other value throws, and so does `'None'` without `secure: true`, set or cleared: browsers
  drop a `SameSite=None` cookie that is not Secure, so the lab would test nothing. `secure: true` adds Secure. The
  open edge: today the simulated browser on `http://citadel.test` refuses a Secure cookie (as a browser does on plain
  http) and its jar ignores SameSite; engine task E1 will make the sim jar accept Secure cookies from
  `http://citadel.test` and apply SameSite. The player's own browser treats `http://127.0.0.1` as a secure context and
  keeps a Secure cookie from it in Chromium and Firefox, but maybe not in Safari. `maxAgeSec` is in seconds (Express's
  `maxAge` is milliseconds: `sendReply` converts).
- **Requests** (`Visit`: `level`, `query` (the raw query string as `URLSearchParams`, never Express's parsed
  `req.query`; everything after the first `?`), `cookies` (only the lab's own, as strings), `base`):
  `visitOf(req, res, cookieNames)` on a real route (`base` is `labPath(res)`), `simVisitOf(level, r, cookieNames)` in
  the citadel handler (`base` is `''`). Give both the same names, one `labCookies(level)` list in `model.ts`, so a
  page function sees the same cookies in both browsers. (`simVisitOf` without names keeps every cookie the simulated
  browser sent: the behaviour before the filter, kept so older callers still compile; GK-10, 11 and 16 pass names.)
  The page function takes the `Visit` and never sees Express or the sim.

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
  (section 8). A lab state with both a world and a file system (SC-05, SC-09) weighs both, about 1.6 MiB. Eviction
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
goes only through E0's sandboxed preview frame.

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
`orders`, `nextOrderNo`, `clock`, `gate` and `locks` (section 11). A lab extends it, typed (never `as`), and keeps it
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
- `placeOrder(state, { lines: orderLines(state), subtotal, total, charged })` debits `charged` (a negative charge
  credits), stamps the order with `state.clock.now()`, empties the cart and the discounts and keeps the newest 30
  orders (`pushOrder`). A charge or wallet outside the safe integers is refused (`OUT_OF_RANGE`) and changes nothing.
  Whether the order may be placed is the level's decision, made before (`checkoutAllowed`, ...).
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
}));
```

- `shopView` is `baseView` (header data, message, `kept`, curl, endpoint list, API box) plus `catalogView`,
  `cartView` and `ordersView`. A page without a cart (store credit, an exchange, an API landing page) uses
  `baseView(req, res, { result, curl, endpoints?, api?, wallet?, intent?, extra? })` and the parts it has.
- `kept` is what was posted (`intent`, `sku`, `qty`): a product's quantity field keeps it only after an `add` of
  that product, and a lab's own form keeps its value only after its own intent.
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
- Readers: `walletOf`, `ordersOf`, `cartOf`, `productForm(html, sku)` (a product form's fields, as a browser posts
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
