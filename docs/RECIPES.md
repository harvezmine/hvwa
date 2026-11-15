# HVWA challenge recipes

How to add a challenge. The worked example is **GK-01 SQLi Login Bypass**
(`src/districts/gatekeeper/gk-01-sqli-login/`): copy its shape, not just its idea.

A challenge is one flag-bearing task, playable at up to four levels. The engine
(`src/core/*`) mounts it, serves its source and diff, issues and checks flags,
and draws the lab bar. The challenge supplies metadata, level code, views and tests.

## 1. Folder pattern

```
src/districts/<district>/<nn-slug>/
  challenge.ts        metadata + mount(): routes that dispatch to the level module
  model.ts            schema, seed, row types, the level-module interface,
                      per-level state (perLevel) and test seams
  levels/acolyte.ts   one file per implemented level; ONLY these are served
  levels/templar.ts   (View Source shows them verbatim, Diff compares the
  levels/inquisitor.ts lowest exploitable level with divine.ts)
  levels/divine.ts    the secure reference
  views/*.ejs         rendered only through sendPage()
  fixtures/           optional: deliberately binary/malformed lab files
  <id>.spec.ts        the exploit matrix + challenge-specific tests
src/districts/<district>/index.ts   imports each challenge.ts (registration side effect)
src/districts/index.ts              imports each district index
```

- Level files import types from `../model.js`, never from `../challenge.js`.
- Everything the vulnerability needs lives in the level file, so View Source
  and the Diff tell the whole story. `challenge.ts` and `model.ts` are plumbing.
- `fixtures/`: any path segment named `fixtures` is exempt from the repo
  hygiene scan (UTF-8, no control characters). Non-`.ts` files there are copied
  into `dist/` by `copy-assets`.

## 2. The four levels

| Level | Means | Example (GK-01) |
|---|---|---|
| **Acolyte** | No defense | both fields concatenated into SQL |
| **Templar** | Naive filter / blacklist | quotes stripped from the username only |
| **Inquisitor** | Real defense, subtly flawed | parameterized, but the password is compared with `LIKE` |
| **Divine** | Correct, ASVS-aligned reference | parameterized, exact comparison; never issues a flag |

Each exploitable level needs its own working exploit, and that exploit should
be a step up from the previous level. Divine must resist every one of them.

## 3. Engine helpers

| Helper | From | Use |
|---|---|---|
| `defineChallenge(input)` | `core/registry` | validate metadata, default `points` (100) and `check` (level-bound flag) |
| `register(c)` | `core/registry` | add to the registry (rejects duplicate id or route), deep-freeze |
| `challengeDir(import.meta.url)` | `core/source` | the `dir` field: the folder holding `levels/` |
| `byLevel<M>({ acolyte, templar, inquisitor, divine })` | `core/lab` | gather the level modules against one interface `M`; `.levels` (rank order) goes to `defineChallenge`, `.for(req.level)` picks the module. Omit levels you do not implement |
| `perLevel(factory)` | `core/lab` | one lazily created instance per level: `.for(level)` |
| `challengeDb(schema, seed?)` | `core/challenge-db` | private in-memory SQLite, `prepare()`-only facade |
| `tryDb(req, () => dbCall())` | `core/lab` | `{ ok: true, value }` or `{ ok: false, message }`: `Database error: <msg>` below Divine, `Invalid request.` at Divine |
| `field(req, name)` | `core/lab` | a body field as a string, `''` for missing or non-string values |
| `flagFor(req, challenge)` | `core/mount` | this session's flag at the served level; throws at Divine |
| `sendPage(res, viewFile, data)` | `core/render` | the only way to render (absolute `.ejs` path) |

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

## 4. Platform rules

**(a) Render only with `page()` / `sendPage()`** from `core/render.ts`, never
`res.render()` or a two-argument `ejs.renderFile` with request data (EJS option
injection would reach the host process). View data may not use the reserved
keys: `escapeFn include rethrow __append __output locals body t lang challenge level labBar`.

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

**(f) Labs whose exploit mutates shared state** (balances, roles, coupons,
stored XSS, memory poisoning...) keep that state per session (a
`Map<sessionId, ...>` or a per-session `challengeDb`), so one player's exploit
never changes another player's lab. Add a core `perSession()` helper the first
time a stateful lab needs it (Relic Market at the latest).

**(g) Never rely on genuinely slow SQL.** `node:sqlite` is synchronous with no
query timeout: a heavy injected query blocks the whole server. Time-based labs
evaluate the injected condition, then `await` a simulated delay. Labs that run
fully attacker-chosen SQL must also cap result size.

**Per-level isolation.** Whenever a secret could be extracted at one level and
replayed at another (a password, a token, a signing key, a coupon code), build
it with `perLevel()`. In GK-01 an admin password dumped by Acolyte SQLi earns
the Acolyte flag (a legitimate attack path) but logs in nowhere else.

**Every lab answers `GET /` at every implemented level** with 200; the
`labs.spec.ts` smoke test and `verify:dist` request it.

**Errors.** Wrap only DB (or parser) calls in `tryDb`. Below Divine the real
message is shown on purpose (error-based learning, CWE-209); Divine shows a
generic message. Read body fields with `field()`, so a JSON object or
extended-urlencoded nesting is an empty string, not a 500.

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
  input goes, which field is filtered, what a wildcard means).

## 6. Testing: the exploit matrix

Every challenge spec declares its matrix with `describeExploitMatrix` from
`tests/helpers.ts`; it generates named cases, one level each:

```ts
describeExploitMatrix<Creds>({
  challenge: GK01,
  path: '/d/gatekeeper/sqli-login',
  send: (agent, _level, creds, url) => agent.post(url).type('form').send(creds),
  exploits: { acolyte: {...}, templar: {...}, inquisitor: {...} }, // one per non-Divine level
  resisted: 'Invalid credentials.',                                 // Divine's answer to every exploit
  legit: [{ name: 'own account', input: {...}, expect: 'Welcome, pilgrim' }],
  malformed: [{ name: 'lone quote', input: {...}, levels: ['acolyte', 'templar'] }], // or []
  privileged: { name: 'real admin', input: {...adminPassword('divine')}, expect: /.../ }, // or null
});
```

Required cases (generated):

- **(a)** `exploits` keys equal the challenge's non-Divine levels.
- **(b)** each exploit at its level shows a flag that `/api/submit` credits at exactly that level.
- **(c)** Divine answers every exploit with 200, the `resisted` text, no flag and no DB-error text.
- **(d)** each `malformed` input shows DB-error text at its listed levels and none at Divine.
- **(e)** each `legit` input works at every level: 200, expected text, no flag.
- **(f)** the `privileged` input (real credentials) works at Divine with no flag.

`malformed: []` and `privileged: null` are explicit opt-outs for labs with no
DB/parser errors or no privileged identity. Add challenge-specific tests next
to the matrix (GK-01: per-level isolation, view escaping, kept values,
non-string fields). `FLAG_RE` and `DB_ERROR_RE` are exported for them.

**Mutation self-check** before committing (revert by rewriting the file, not
`git checkout` over uncommitted work):

1. Make one exploitable level secure: its exploit case goes red.
2. Make Divine fall for an exploit: its resist case goes red.
3. Make Divine leak a DB error: the Divine malformed case goes red.
4. Make Divine show a flag to the privileged user: the privileged case goes red.

If a mutation stays green, the matrix is missing a case.

## 7. New-challenge checklist

1. Read the catalog row (levels, standard mapping) and this file.
2. Write `<id>.spec.ts` first (matrix + specifics); run `npm test -- <id>` and watch it fail.
3. `model.ts`: schema, seed, row types, the level-module interface, `perLevel` state, test seams.
4. `levels/*.ts`: Acolyte no defense, Templar naive filter, Inquisitor flawed defense, Divine correct.
5. `challenge.ts`: `byLevel<M>`, `register(defineChallenge({ ..., dir: challengeDir(import.meta.url), levels: impl.levels }))`,
   bilingual title/summary/3 hints, routes using `field`, `tryDb`, `flagFor`, `sendPage`.
6. `views/*.ejs`: `.lab` markup, escaped output, English lab content.
7. Import `challenge.js` from the district `index.ts` (and the district from `src/districts/index.ts`).
8. Mutation self-check (section 6).
9. `npm test`, `npm run typecheck`, `npm run verify:dist` all green; commit `feat(<district>): <ID> <title>`.
