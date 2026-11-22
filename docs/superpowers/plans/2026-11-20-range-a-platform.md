# HVWA Range — Plan A: platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing HVWA app into the Range platform of `docs/superpowers/specs/2026-11-20-hvwa-range-design.md` (spec §13 steps 1–4 and the image half of §12): a portal mode with many accounts, a warden that is the only component allowed to create lab containers, the per-user instance lifecycle behind Traefik forward-auth, and a compose stack verified end to end with a minimal fixture lab.

**Architecture:** One codebase, two processes. `HVWA_MODE=portal` runs `src/server.ts` as the range portal (accounts, catalog, scoring, instances, gate and forward-auth endpoints; no labs mounted); `HVWA_MODE=standalone` (the default) is today's app, unchanged. `src/warden/main.ts` is a small Express service that turns `{ labId, level, instanceId, flag, userId, expiresAt }` into one hardened container on its own internal network, through a write-limited `tecnativa/docker-socket-proxy`; the container configuration is a fixed template in the warden. Exposure is a Cloudflare Tunnel (TLS at Cloudflare's edge): the owner's `cloudflared` sends `hvwa.my.id` and `*.hvwa.my.id` to `http://traefik:80` over the external Docker network `hvwa-edge`. Traefik v3 (one plain-HTTP entrypoint, no published ports) routes the portal host to the portal, `i-<instanceId>.<domain>` to the instance after forward-auth against the portal, and `/__hvwa/*` on those hosts to the portal for the gate-ticket exchange.

**Tech Stack:** Node ≥ 22.18 (TypeScript ESM, `node:sqlite`, global `fetch`), Express 5, EJS through `sendPage`/`sendFragment`, zod 3.25, htmx 2.0.4 (vendored), Vitest 3.2.4 + Supertest 7.1.1 (aliased wrapper), Docker Engine ≥ 28 (API `v1.44`; gVisor `runsc` on the POC host), `traefik:v3.7.19`, `tecnativa/docker-socket-proxy:v0.5.0`, `node:22.23.5-alpine3.24`, Cloudflare Tunnel (`cloudflared`, run by the owner, not part of this stack).

---

## COMPACT POC AMENDMENT (owner, 2026-11-21) — binding, overrides the tasks below

The owner cut the POC down so it finishes sooner: 4 labs with 3 levels each, no victim bot. Apply these changes to the
tasks as written. Everything not listed is built exactly as written.

| Task | Change |
|---|---|
| 3 | Keep roles and the `disabled` column as written in the schema and service. **Do not build** the admin operations (disable, reset password, make admin) or their tests. |
| 5 | **Drop** the event code and the admin open/closed switch. Registration is open unless `HVWA_REGISTRATION_OPEN=0`, an env switch read once at start. The per-IP limits on the client IP stay as written. |
| 10 | **Drop** the whole task: no admin pages. |
| 18 | **Drop** the FIFO queue and Extend. When capacity is full, launch returns `full` and the Lab panel says "The range is full. Try again in a minute." Limits: idle 20 min, maximum lifetime 60 min (`HVWA_RANGE_IDLE_MIN=20`, `HVWA_RANGE_MAX_MIN=60`). There is no separate ceiling; the gate cookie expires at start + max lifetime. Reset and Stop stay. |
| 23 | Keep the Lab panel and "My Lab". **Drop** the admin instances page. |
| 26 | Instances default to gVisor in the range compose: `HVWA_RANGE_RUNTIME=runsc`. The POC host has it; Docker Desktop does not, so local runs set `runc`. |
| 27 | Keep the security checks; drop any check that exercises a dropped feature (queue, extend, admin). |
| all | Range-only UI strings may use the English text for both `id` and `en`. |

Labs, levels and the victim bot are out of this plan: there are 4 labs (Plan B), and Plan C is removed.

## INQUISITOR AMENDMENT (owner, 2026-11-22) — binding, overrides the compact amendment where they differ

The POC now shows four levels per lab. Acolyte, Templar and Inquisitor are exploitable and scored; Divine remains the
secure reference (scored 0). Inquisitor is a chained, multi-step exploit. Everything else in the compact amendment
stands.

## BINANSE / RIDDLE AMENDMENT (owner, 2026-11-22) — binding

A fifth hard-only lab **r05 Binanse** (stored XSS) joins the POC with a single **Inquisitor** level: no difficulty
choice and no Divine reference. Challenge titles are now riddle-style — r01 The Quiet Ward, r02 Return to Nowhere,
r03 Static Bloom, r04 The Paper Cut, r05 The Cold Ledger — with three riddle hints each; the in-world product names
(Mercy Clinic, Courier, Beacon, Postcard, Binanse) stay as secondary context, and the challenge title is the primary
UI heading. Maximum bounty becomes **3750** (rank S at 3750). No other POC changes.

## Ground rules for every task

- **Run tests from the UPPERCASE drive path.** `cd C:\Users\Sahuagin\Documents\hvwa` (capital `C:`). A lowercase `c:` cwd makes the same module load twice and breaks `vi.mock` and identity checks (see `tests/tooling.spec.ts`).
- **Every task ends green** on `npx vitest run` and `npm run typecheck`. The per-task step 4 runs only the new spec for speed; step 5 runs both full gates before the commit.
- **Never touch** the untracked `context.md` at the repo root. Never `git add -A`; add the files the task lists.
- **Standalone stays as it is.** `HVWA_MODE` unset means standalone; `tests/support/setup.ts` pins `HVWA_MODE=standalone` (Task 1) the same way it pins `HVWA_EDITION` and `HVWA_AUTH`. No standalone page, cookie or route changes, except the ones listed under "Existing specs that change" below.
- **Platform code is not a lab.** `src/auth`, `src/range` and `src/warden` must not be vulnerable: every value in a view uses the escaped output tag; every state-changing form checks Origin, Sec-Fetch-Site and the account CSRF token (`PlatformAuth.formOk`, Task 4); nothing secret is logged or echoed.
- **Third-party image pins** (verify each at implementation time with `docker pull <image>`; if a tag is gone, take the newest patch of the same minor and update every place this plan names it): `traefik:v3.7.19` (latest v3 on 2026-11-13), `tecnativa/docker-socket-proxy:v0.5.0` (latest version tag, 2026-07-27), `node:22.23.5-alpine3.24` (already pinned by `Dockerfile`).
- **Pushing images is manual.** `npm run range:push` is run only by the controller, after Task 29 passes, with `docker login` done by the owner.
- **Host-agnostic, tunnel-agnostic.** Nothing in this plan names the POC host or touches its tunnel: `cloudflared` and the `hvwa-edge` network belong to the owner's bootstrap compose. Local runs and `range-verify` create their own throwaway edge network and tunnel stand-in.

## Decisions this plan takes where the spec leaves room

| # | Question | Decision |
|---|---|---|
| D1 | Spec §3 says the warden is called with `{ labId, level, instanceId, flag }`, but §7 also wants user id and expiry as container labels. | The launch body is `{ labId, level, instanceId, flag?, userId, expiresAt }`. `userId` and `expiresAt` only become labels; the schema is `.strict()`, so no image, mount, port or HostConfig key can ever be passed. |
| D2 | The lab's health check (§5.3) must be observed by the warden, which has no network path to the instance. | Each lab image declares a Docker `HEALTHCHECK` that requests its manifest `health` path. The warden creates the container with `Healthcheck.Test: []` (inherit the image's test) and fixed timings, and reads `State.Health.Status`. An image without a health check is reported `failed` / `no_healthcheck`. |
| D3 | How an instance is kept from reaching the portal or other instances *through Traefik*, which shares its network (and from forging `CF-Connecting-IP`). | Traefik's only entrypoint `web` listens on its **`hvwa-edge`** address only, port 80. The compose service is named `router` and carries the network alias `traefik` on `hvwa-edge` alone, so at start a two-line shell wrapper resolves `traefik` (its own `hvwa-edge` address, the only address with that alias) and exports `TRAEFIK_ENTRYPOINTS_WEB_ADDRESS=<addr>:80` before `exec traefik`. On an instance network nothing listens: the instance gets `ECONNREFUSED` from Traefik and no route anywhere else. `range-verify` asserts it. |
| D4 | Where the forward-auth shared secret travels (Traefik's forwardAuth cannot add static headers). | A `headers` middleware sets `X-Hvwa-Auth-Secret` on the request, `forwardAuth` copies it (`authRequestHeaders: [Cookie, X-Hvwa-Auth-Secret]`), and a second `headers` middleware removes it before the instance sees the request. The three are chained as `hvwa-instance@file`. |
| D5 | Host of the forward-auth call. | Traefik calls `http://portal:1337/__hvwa/auth`, so `Host: portal`. The portal answers `/__hvwa/auth` only on that internal host name (`HVWA_FORWARD_AUTH_HOST`, default `portal`) and only with the secret header; a player can never send `Host: portal` through Traefik (no router matches it). |
| D6 | Range catalog data (hints, briefing) is not in spec §8.4's field list. | `lab.json` also carries `briefing` and `hints` (portal-only, bilingual `{ en, id }` like every platform text); `title` and `scenario` are bilingual too. `labs/registry.json` = each manifest + `version` + `image` (pinned by digest). One zod schema (`src/lab-registry.ts`) validates both. |
| D7 | Lab id format. | `r00`–`r99`, lower case (Docker repository names must be lower case: `hvwa-lab/r01:1.0.0`). `r00` is the fixture (`labs/_fixture/`, underscore = not a catalog lab). |
| D8 | Accounts table name and the published lite image. | Migration 3 creates `users` (spec §4 columns plus the existing backoff columns), copies the admin row from `auth_accounts`, drops `auth_accounts`, and keeps `auth_tokens` unchanged (joined by `username`, which is unique and never renamed). Existing lite databases keep their password, signed-in browsers and progress. The README recipes move to `users`, with a sentence for images published before this change. |
| D9 | Username case. | Registration lower-cases the input, then requires `^[a-z0-9_]{3,24}$`; uniqueness is case-insensitive (`UNIQUE INDEX ... COLLATE NOCASE`). Sign-in stays an exact match (an existing spec requires `Admin` to fail). |
| D10 | Registration rate limit unit. | 5 **accounts created** per client IP per hour: cheap validation errors never spend the budget; the limit is checked right before the scrypt hash. The IP is `clientIp(req)` (D18). |
| D11 | After registering. | Redirect to `/login?registered=1` (spec §2: "registration page, then login"). |
| D12 | `HVWA_RANGE_RUNTIME` is listed under portal env, but only the warden creates containers. | It is a warden setting (`runc` default, `runsc` allowed) that the warden always writes as `HostConfig.Runtime`; the compose file passes it to the warden. On the POC host gVisor is installed and the owner's `.env` sets `HVWA_RANGE_RUNTIME=runsc` (required there); local runs and `range-verify` use `runc` unless `HVWA_VERIFY_RUNTIME=runsc`. |
| D13 | Gate cookie lifetime vs Extend. | The cookie expires at `started_at + HVWA_RANGE_CEILING_MIN` (the latest an instance can live); forward-auth additionally requires the instance to be `running`, so a stopped instance is closed at once whatever the cookie says. |
| D14 | "Records without a container are closed" vs queued records. | Startup reconcile closes `starting`/`running` records with no container (`stopped`, reason `lost`) and every leftover `stopping` record; `queued` records have no container by design and stay queued. |
| D15 | Where range progress lives. | New tables `range_solves` and `range_hint_unlocks` keyed by `user_id` (INTEGER). The standalone `solves`/`hint_unlocks` (keyed by `hvwa_sid`) are untouched. |
| D16 | TLS and exposure (spec §12, owner decision 2026-11-21). | TLS ends at Cloudflare (Universal SSL; hostnames one level deep). Inside the host everything is plain HTTP: Traefik has one entrypoint (`web`, :80), no published ports, no ACME, no certificate resolver. The range compose declares the owner's network `hvwa-edge` as `external: true` (name overridable by `HVWA_EDGE_NETWORK`) and does not contain `cloudflared` (a commented example only). Locally, and in `range-verify`, a one-line TCP forwarder container on a throwaway `hvwa-edge` network stands in for the tunnel on `127.0.0.1:18080`. |
| D17 | Hostnames (spec §5 config). | One level deep: portal `<domain>` (`HVWA_PORTAL_HOST`, default the domain), instances `i-<instanceId>.<domain>`, request catchers `c-<userId>.<domain>` (Plan C). Locally `hvwa.localhost` and `i-<id>.localhost`. The portal host's first label may not start with `i-` or `c-` (config error). |
| D18 | Client IP (spec §12). | `src/auth/client-ip.ts clientIp(req)`: the `CF-Connecting-IP` header when it is a valid IP (trusted because only `cloudflared` reaches Traefik and only Traefik reaches the portal), else the socket address (local runs). Portal mode uses it for the registration limit and for a per-IP budget of failed sign-ins (`signInPerIp`, 30 per 15 min) that sits in front of the unchanged per-account backoff. Express `trust proxy` stays off everywhere. |
| D19 | The public scheme behind the tunnel. | `HVWA_RANGE_PUBLIC_SCHEME` (`https` default, `http` for local runs) and `HVWA_RANGE_PUBLIC_PORT` (only when not the scheme's default) build every public URL (Open lab, the 401 page's link home). The forms' Origin check compares against this scheme in portal mode (`AuthOptions.publicScheme`), since the portal itself only ever sees plain HTTP. Cookies get `Secure` exactly when the scheme is `https`; every cookie stays host-only (no `Domain=`), so no instance subdomain ever receives a portal cookie. |

## Existing specs that change, and why

| Spec | Change | Why |
|---|---|---|
| `tests/config.spec.ts` | The "defaults" `toEqual` gains `HVWA_MODE: 'standalone'`; new cases for `HVWA_MODE`. | The config has one new key (Task 1). |
| `tests/db.spec.ts` | The table list and the account columns follow migrations 3 and 4; a new "lite database upgrade" case. | `users` replaces `auth_accounts`; range tables are added (Tasks 2, 7). |
| `tests/smoke.spec.ts` | The table list and `user_version` follow the migrations (`SCHEMA_VERSION`). | Same (Tasks 2, 7). |
| `tests/auth.spec.ts` | Every SQL string naming `auth_accounts` names `users`; the README-recipe case expects the new recipe text. | Same table rename (Task 2). Behaviour is identical. |
| `tests/render.spec.ts` | The exact reserved-key list gains `portalNav` and `myLab`. | The layout reads two new `res.locals` keys in portal mode (Task 8). |

Every other existing spec runs unchanged in standalone mode and must stay green.

## File structure

### Portal side (`src/range/`, `HVWA_MODE=portal` only)

| File | Responsibility |
|---|---|
| `src/range/config.ts` | Parse and validate the portal-mode environment (`HVWA_RANGE_*`, secrets) into `RangeConfig`; secret names to scrub. |
| `src/range/types.ts` | `RangeLimits`, `DEFAULT_LIMITS`, `RangePortalOptions`, `RangeContext` (the shared dependencies of the range routers). |
| `src/range/ids.ts` | RFC 4648 base32 (lower case), `INSTANCE_ID_RE`, `newInstanceId()` (128-bit). |
| `src/range/hosts.ts` | One-level host names and public origins: `instanceHost` (`i-<id>.<domain>`), `instanceIdOfHost`, `instanceOrigin`, `portalOrigin`. |
| `src/range/progress.ts` | Range solves, hint unlocks, score and leaderboard, keyed by user id. |
| `src/range/catalog.ts` | Routes: catalog `/`, lab page `/labs/:id`, hint unlock, `/leaderboard`. |
| `src/range/flags.ts` | Flag derivation `HVWA{base32(HMAC(rangeKey, "flag|id|lab|level"))[:26]}` and its SHA-256. |
| `src/range/store.ts` | The `range_instances` table: insert, read, patch, active/queued/live queries, flag lookup. |
| `src/range/warden-client.ts` | The portal's HTTP client for the warden API (`WardenApi`), shared-secret bearer auth. |
| `src/range/lifecycle.ts` | Launch (one active per user, capacity, FIFO queue), stop, extend, reset, readiness refresh, last-seen. |
| `src/range/reaper.ts` | One reaper pass (expiry, idle, crashed, orphans, queue), startup reconcile, the 30 s timer. |
| `src/range/tickets.ts` | Gate tickets: single use, 60 s, bound to (user, instance), in memory, stored by SHA-256. |
| `src/range/gate.ts` | Gate cookie (mint/verify), `/__hvwa/gate`, `/__hvwa/auth` (forward-auth), the 401 page, the edge dispatcher. |
| `src/range/submit.ts` | Flag submission against the submitter's own instances (24 h window) and the result fragment. |
| `src/range/panel.ts` | The Lab panel view model (state, time left, queue position, actions) and the My Lab chip model. |
| `src/range/lab-routes.ts` | Routes: submit, panel fragment, launch / open / extend / reset / stop, My Lab. |
| `src/range/admin.ts` | Routes: `/admin/range` (active instances, capacity, queue, stop). |
| `src/range/options.ts` | `portalAppOptions()`: `AppOptions` for portal mode from `Config` + `RangeConfig` (registry file, warden client, range key). |
| `src/range/index.ts` | `createRangePortal()`: composes the context and the routers; exposes `edge`, `locals`, `router`, `lifecycle`, `start()`. |
| `src/range/views/catalog.ejs`, `lab.ejs`, `panel.ejs`, `leaderboard.ejs`, `admin-range.ejs` | The range pages (Sanctum classes). |

### Warden (`src/warden/`)

| File | Responsibility |
|---|---|
| `src/warden/protocol.ts` | The warden API contract shared with the portal: launch schema, health/list types, `WardenApi`, `WardenError`. |
| `src/warden/docker.ts` | Docker Engine API client over HTTP (to the socket proxy), versioned `/v1.44`, only containers and networks. |
| `src/warden/template.ts` | THE fixed container create body (spec §7) and the per-instance network create body. |
| `src/warden/warden.ts` | Operations: launch (image allowlist by registry digest), stop, list, health. |
| `src/warden/server.ts` | The API server: bearer shared secret, strict bodies, error mapping. |
| `src/warden/config.ts` | Warden environment parsing. |
| `src/warden/main.ts` | Entry point: config, registry, Docker client, server, signals. |

### Accounts (`src/auth/`, generalised)

| File | Responsibility |
|---|---|
| `src/auth/service.ts` (modify) | Many users: roles, disabled, register, admin operations; same scrypt, backoff, check cap, tokens, CSRF. |
| `src/auth/forms.ts` (new) | The form guards moved out of `index.ts`: `noStore`, `originOk`, `fetchSiteOk`, `authTokenOf`, `isHtmx`, `isApi`, `ownHost`. |
| `src/auth/index.ts` (modify) | `platformAuth()`: secure-cookie option, `formOk`/`csrfFor`/`refuse` for other routers, `requireAdmin`, registration and admin routers. |
| `src/auth/rate-limit.ts` (new) | Sliding-window limiter per key (registrations and failed sign-ins per client IP). |
| `src/auth/client-ip.ts` (new) | The client IP: `CF-Connecting-IP` when valid, else the socket address (D18). |
| `src/auth/settings.ts` (new) | Admin switches in `range_settings`: registration open, event code. |
| `src/auth/register.ts` (new) | `GET/POST /register`. |
| `src/auth/admin.ts` (new) | `/admin/users` (disable, enable, reset password, role) and `/admin/settings` (registration toggle, event code). |
| `src/auth/views/register.ejs`, `admin-users.ejs`, `admin-settings.ejs`, `admin-nav.ejs` (new); `login.ejs`, `password.ejs` (modify) | Views. |

### Shared and engine files

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | `HVWA_MODE` (`MODES`, `Mode`, `modeFrom`). |
| `src/app.ts` (modify) | `createApp({ mode, range })`: the portal-mode app (no labs, no `/api`), static serving shared. |
| `src/server.ts` (modify) | Portal mode: range config, scrub secrets, `portalAppOptions`, start reconcile + reaper, banner, shutdown. |
| `src/lab-registry.ts` (new) | Lab manifest and registry schema (zod), loader, `labPoints`. |
| `src/db/users.sql`, `src/db/range.sql` (new); `src/db/index.ts` (modify) | Migrations 3 and 4. |
| `src/core/host-guard.ts` (modify) | Optional host predicate (instance hosts). |
| `src/core/render.ts` (modify) | `fragment`/`sendFragment` (htmx partials), `MY_LAB_VIEW`, reserved `portalNav`, `myLab`. |
| `src/core/secrets.ts` (modify) | `resolveRangeKey()` (env or persisted `<data>/range-key`). |
| `src/core/views/layout.ejs` (modify), `src/core/views/my-lab.ejs` (new) | Portal nav, My Lab chip, temporary-password banner text. |
| `src/core/i18n.ts` (modify) | New platform strings (EN + ID). |
| `src/public/app.css` (modify), `docs/UI.md` (modify) | Range components in Sanctum tokens. |
| `src/types/express.d.ts` (modify) | `platformAuth.userId/role`, `portalNav`, `myLab`. |
| `labs/registry.json` (new) | The lab registry (empty until Plan B). |
| `labs/_fixture/` (new): `lab.json`, `Dockerfile`, `app/server.mjs`, `app/health.mjs` | The fixture lab (NOT a catalog lab). |
| `Dockerfile.range` (new) | Targets `range-portal` and `range-warden`. |
| `scripts/range-images.mjs` (new) | `npm run range:build` / `range:push`. |
| `docker-compose.range.yml` (new), `docker/range/traefik/range.yml` (new) | The range stack behind the owner's Cloudflare Tunnel (external network `hvwa-edge`, no published ports) and Traefik's dynamic config. |
| `scripts/range-verify.mjs` (new) | Spec §11 security checks against a running local range (its own `hvwa-edge` and a TCP forwarder standing in for the tunnel). |
| `package.json`, `.dockerignore`, `README.md` (modify) | Scripts; build context; recipe text. |

### Tests

| File | Covers |
|---|---|
| `tests/support/setup.ts` (modify) | Pins `HVWA_MODE=standalone`. |
| `tests/helpers.ts` (modify) | `csrfOf` (shared form-token reader). |
| `tests/support/range.ts` (new) | Portal-mode kit: test registry, fake clock, fast hasher, accounts, signed-in agents. |
| `tests/support/docker-stub.ts` (new) | In-memory stub of the Docker Engine API over HTTP. |
| `tests/support/fake-warden.ts` (new) | In-process `WardenApi` with controllable health, failures, orphans. |
| `tests/range-config.spec.ts`, `tests/auth-users.spec.ts`, `tests/auth-forms.spec.ts`, `tests/auth-register.spec.ts`, `tests/lab-registry.spec.ts`, `tests/range-progress.spec.ts`, `tests/portal-mode.spec.ts`, `tests/auth-admin.spec.ts`, `tests/warden-docker.spec.ts`, `tests/warden-template.spec.ts`, `tests/warden-ops.spec.ts`, `tests/warden-server.spec.ts`, `tests/range-flags.spec.ts`, `tests/range-store.spec.ts`, `tests/range-warden-client.spec.ts`, `tests/range-lifecycle.spec.ts`, `tests/range-reaper.spec.ts`, `tests/range-gate.spec.ts`, `tests/range-forward-auth.spec.ts`, `tests/range-submit.spec.ts`, `tests/range-panel.spec.ts`, `tests/range-server.spec.ts`, `tests/range-fixture.spec.ts`, `tests/range-images.spec.ts`, `tests/range-compose.spec.ts`, `tests/range-verify.spec.ts` (new) | One per task, named in the task. |

---

## Part 1 — Portal mode and accounts (spec §13 step 1)

### Task 1: `HVWA_MODE` and the portal-mode settings

**Files:**
- Modify: `src/config.ts` (new `MODES`, `Mode`, `HVWA_MODE`, `modeFrom`)
- Create: `src/range/config.ts`
- Modify: `tests/support/setup.ts`, `tests/config.spec.ts`
- Test: `tests/range-config.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/config.spec.ts`, change the import line to also import `modeFrom`:

```ts
import { parseConfig, loadConfig, isLoopbackHost, bindRefusal, editionFrom, authModeFrom, modeFrom } from '../src/config.js';
```

In the first case (`'defaults to a localhost bind, ...'`) the expected object gains one key:

```ts
    expect(c).toEqual({
      HOST: '127.0.0.1', PORT: 1337, AI_BACKEND: 'sim',
      FLAG_SECRET: undefined, HVWA_ALLOW_REMOTE: false, HVWA_DATA_DIR: undefined, HVWA_ALLOWED_HOSTS: [],
      HVWA_EDITION: 'full', HVWA_AUTH: 'off', HVWA_ADMIN_PASSWORD: undefined, HVWA_MODE: 'standalone',
    });
```

Append this case inside `describe('parseConfig', ...)`:

```ts
  it('HVWA_MODE is standalone (default, blank) or portal; anything else is a readable error', () => {
    expect(parseConfig({}).HVWA_MODE).toBe('standalone');
    expect(parseConfig({ HVWA_MODE: '  ' }).HVWA_MODE).toBe('standalone');
    expect(parseConfig({ HVWA_MODE: 'portal' }).HVWA_MODE).toBe('portal');
    const r = loadConfig({ HVWA_MODE: 'range' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toEqual([expect.stringMatching(/^HVWA_MODE: /)]);
    expect(modeFrom({})).toBe('standalone');
    expect(modeFrom({ HVWA_MODE: 'portal' })).toBe('portal');
    expect(() => modeFrom({ HVWA_MODE: 'cluster' })).toThrow(/^HVWA_MODE: /);
  });
```

Create `tests/range-config.spec.ts`:

```ts
// The portal-mode settings (src/range/config.ts): parsed only when HVWA_MODE=portal. Required values are named in
// one readable line each; a secret's value never appears in a message.
import { describe, it, expect } from 'vitest';
import { loadRangeConfig, RANGE_SECRET_NAMES, type RangeConfig } from '../src/range/config.js';

const S = (c: string) => c.repeat(40);
const BASE = {
  HVWA_RANGE_DOMAIN: 'hvwa.my.id', HVWA_ADMIN_PASSWORD: 'Admin-Pass-1234',
  HVWA_WARDEN_SECRET: S('w'), HVWA_FORWARD_AUTH_SECRET: S('f'),
};
function ok(env: Record<string, string | undefined>): RangeConfig {
  const r = loadRangeConfig(env);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r.config;
}
function errors(env: Record<string, string | undefined>): string[] {
  const r = loadRangeConfig(env);
  if (r.ok) throw new Error('expected a configuration error');
  return r.errors;
}

describe('loadRangeConfig', () => {
  it('defaults: the portal host is the domain, https behind the tunnel, capacity 140, 30/120/30/240 minutes, the warden at http://warden:8080', () => {
    expect(ok(BASE)).toEqual({
      domain: 'hvwa.my.id', portalHost: 'hvwa.my.id', publicScheme: 'https', publicPort: undefined, capacity: 140,
      idleMs: 30 * 60_000, maxMs: 120 * 60_000, extendMs: 30 * 60_000, ceilingMs: 240 * 60_000,
      registrationCode: undefined, wardenUrl: 'http://warden:8080', wardenSecret: S('w'), forwardAuthSecret: S('f'),
      rangeKey: undefined, internalHost: 'portal', registryPath: undefined,
    });
  });

  it('reads every setting (local mode: i-<id>.localhost labs, the portal at hvwa.localhost, plain http on a port)', () => {
    expect(ok({
      ...BASE, HVWA_RANGE_DOMAIN: 'LocalHost', HVWA_PORTAL_HOST: 'hvwa.localhost', HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: '18080',
      HVWA_RANGE_CAPACITY: '2', HVWA_RANGE_IDLE_MIN: '1', HVWA_RANGE_MAX_MIN: '5', HVWA_RANGE_EXTEND_MIN: '2',
      HVWA_RANGE_CEILING_MIN: '9', HVWA_REGISTRATION_CODE: ' EVENT-2026 ', HVWA_WARDEN_URL: 'http://127.0.0.1:18080',
      HVWA_RANGE_KEY: S('k'), HVWA_FORWARD_AUTH_HOST: 'Portal', HVWA_LAB_REGISTRY: '/etc/hvwa/registry.json',
    })).toEqual({
      domain: 'localhost', portalHost: 'hvwa.localhost', publicScheme: 'http', publicPort: 18080, capacity: 2,
      idleMs: 60_000, maxMs: 300_000, extendMs: 120_000, ceilingMs: 540_000,
      registrationCode: 'EVENT-2026', wardenUrl: 'http://127.0.0.1:18080', wardenSecret: S('w'), forwardAuthSecret: S('f'),
      rangeKey: S('k'), internalHost: 'portal', registryPath: '/etc/hvwa/registry.json',
    });
  });

  it('names every missing requirement: the domain, the admin password (>= 10), both secrets', () => {
    expect(errors({})).toEqual([
      'HVWA_RANGE_DOMAIN: is required in portal mode',
      'HVWA_ADMIN_PASSWORD: is required in portal mode (at least 10 characters)',
      'HVWA_WARDEN_SECRET: is required in portal mode',
      'HVWA_FORWARD_AUTH_SECRET: is required in portal mode',
    ]);
    expect(errors({ ...BASE, HVWA_ADMIN_PASSWORD: 'nine-char' }))
      .toEqual(['HVWA_ADMIN_PASSWORD: is required in portal mode (at least 10 characters)']);
    expect(errors({ ...BASE, HVWA_RANGE_CEILING_MIN: '60' })).toEqual(['HVWA_RANGE_CEILING_MIN: must be at least HVWA_RANGE_MAX_MIN']);
  });

  it.each(['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY'])('%s needs 32+ characters and is never echoed', (name) => {
    const value = 'Tiny-Secret-Value';
    const out = errors({ ...BASE, [name]: value });
    expect(out).toEqual([`${name}: must be at least 32 characters`]);
    expect(out.join('\n')).not.toContain(value);
  });

  it('refuses a domain with a scheme, a bad port or scheme, a warden URL with a path, a portal host shaped like an instance', () => {
    expect(errors({ ...BASE, HVWA_RANGE_DOMAIN: 'https://hvwa.my.id' }))
      .toEqual(['HVWA_RANGE_DOMAIN: must be a bare domain such as hvwa.my.id or localhost']);
    expect(errors({ ...BASE, HVWA_RANGE_PUBLIC_PORT: '70000' })).toEqual([expect.stringMatching(/^HVWA_RANGE_PUBLIC_PORT: /)]);
    expect(errors({ ...BASE, HVWA_RANGE_PUBLIC_SCHEME: 'ftp' })).toEqual([expect.stringMatching(/^HVWA_RANGE_PUBLIC_SCHEME: /)]);
    expect(errors({ ...BASE, HVWA_WARDEN_URL: 'http://warden:8080/v1' })).toEqual(['HVWA_WARDEN_URL: must be http(s)://host[:port]']);
    for (const host of ['i-portal.hvwa.my.id', 'c-1.hvwa.my.id']) {
      expect(errors({ ...BASE, HVWA_PORTAL_HOST: host }))
        .toEqual(['HVWA_PORTAL_HOST: its first label must not start with i- or c- (instance and request-catcher hosts)']);
    }
  });

  it('names the variables server.ts removes from process.env', () => {
    expect(RANGE_SECRET_NAMES).toEqual(['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY', 'HVWA_REGISTRATION_CODE']);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/config.spec.ts tests/range-config.spec.ts`
Expected: FAIL — `modeFrom` is not exported, `HVWA_MODE` is missing from the parsed config, and `src/range/config.ts` does not exist.

- [ ] **Step 3: Implement**

In `src/config.ts`, after the `AUTH_SETTING` / `AuthMode` lines, add:

```ts
// The process's role (spec 2026-11-20 range §3). standalone: every lab in one process, the lite and full images, exactly
// as before. portal: the range portal (accounts, catalog, instances, gate, forward-auth), which mounts no labs; its
// own settings are parsed by src/range/config.ts, only in that mode.
export const MODES = Object.freeze(['standalone', 'portal'] as const);
export type Mode = (typeof MODES)[number];
const MODE_SETTING = unsetIfBlank(z.enum(MODES).default('standalone'));
```

In the `schema` object, after `HVWA_ADMIN_PASSWORD: ...,` add:

```ts
  HVWA_MODE: MODE_SETTING,
```

After `authModeFrom`, add:

```ts
/** HVWA_MODE alone: createApp()'s mode when it is given none. Throws on an invalid value. */
export function modeFrom(env: Record<string, string | undefined> = process.env): Mode {
  return setting('HVWA_MODE', MODE_SETTING, env);
}
```

In `tests/support/setup.ts`, after `process.env.HVWA_AUTH = 'off';` add:

```ts
// Standalone unless a spec asks for the portal (createApp({ mode: 'portal' }) in tests/support/range.ts).
process.env.HVWA_MODE = 'standalone';
```

Create `src/range/config.ts`:

```ts
// src/range/config.ts — the portal-mode settings (HVWA_MODE=portal, spec 2026-11-20 range §5). Parsed ONLY in portal
// mode (server.ts), so standalone and the lite image never read them. No message ever contains a value.
import { z } from 'zod';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unset = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s);

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** A bare DNS name: hvwa.my.id, localhost, hvwa.localhost. No scheme, port, path or wildcard. */
export const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Shortest accepted secret (warden, forward-auth, range key): `openssl rand -hex 32` gives 64 characters. */
export const MIN_RANGE_SECRET_LENGTH = 32;
/** Shortest password in portal mode (spec §4): the first admin's, every player's, every change. */
export const RANGE_PASSWORD_MIN_LENGTH = 10;
/** What server.ts removes from process.env once the config holds it. */
export const RANGE_SECRET_NAMES = Object.freeze(
  ['HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET', 'HVWA_RANGE_KEY', 'HVWA_REGISTRATION_CODE'] as const);

const host = (message: string) => z.string().trim().toLowerCase().regex(DOMAIN_RE, message);
const secret = unset(z.string()
  .min(MIN_RANGE_SECRET_LENGTH, `must be at least ${MIN_RANGE_SECRET_LENGTH} characters`)
  .refine((v) => !CONTROL.test(v), 'must not contain control characters')
  .optional());
const minutes = (def: number) => unset(z.coerce.number().int().min(1).max(7 * 24 * 60).default(def));

const schema = z.object({
  HVWA_RANGE_DOMAIN: unset(host('must be a bare domain such as hvwa.my.id or localhost').optional()),
  HVWA_PORTAL_HOST: unset(host('must be a bare host name such as hvwa.my.id').optional()),
  // Behind the Cloudflare Tunnel the public scheme is https (TLS ends at Cloudflare); local runs are plain http.
  HVWA_RANGE_PUBLIC_SCHEME: unset(z.enum(['http', 'https']).default('https')),
  HVWA_RANGE_PUBLIC_PORT: unset(z.coerce.number().int().min(1).max(65535).optional()),
  HVWA_RANGE_CAPACITY: unset(z.coerce.number().int().min(1).max(10_000).default(140)),
  HVWA_RANGE_IDLE_MIN: minutes(30),
  HVWA_RANGE_MAX_MIN: minutes(120),
  HVWA_RANGE_EXTEND_MIN: minutes(30),
  HVWA_RANGE_CEILING_MIN: minutes(240),
  HVWA_REGISTRATION_CODE: unset(z.string().trim()
    .min(4, 'must be at least 4 characters').max(128, 'must be at most 128 characters')
    .refine((v) => !CONTROL.test(v), 'must not contain control characters').optional()),
  HVWA_WARDEN_URL: unset(z.string().trim()
    .regex(/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, 'must be http(s)://host[:port]').default('http://warden:8080')),
  HVWA_WARDEN_SECRET: secret,
  HVWA_FORWARD_AUTH_SECRET: secret,
  HVWA_RANGE_KEY: secret,
  HVWA_FORWARD_AUTH_HOST: unset(host('must be a bare host name').default('portal')),
  HVWA_LAB_REGISTRY: unset(z.string().trim().min(1).optional()),
  // Validated (control characters, length) by src/config.ts; here only "present and long enough for portal mode".
  HVWA_ADMIN_PASSWORD: unset(z.string().optional()),
}).superRefine((c, ctx) => {
  const need = (path: string, met: boolean, message: string) => {
    if (!met) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  need('HVWA_RANGE_DOMAIN', c.HVWA_RANGE_DOMAIN !== undefined, 'is required in portal mode');
  need('HVWA_ADMIN_PASSWORD', (c.HVWA_ADMIN_PASSWORD?.length ?? 0) >= RANGE_PASSWORD_MIN_LENGTH,
    `is required in portal mode (at least ${RANGE_PASSWORD_MIN_LENGTH} characters)`);
  need('HVWA_WARDEN_SECRET', c.HVWA_WARDEN_SECRET !== undefined, 'is required in portal mode');
  need('HVWA_FORWARD_AUTH_SECRET', c.HVWA_FORWARD_AUTH_SECRET !== undefined, 'is required in portal mode');
  need('HVWA_RANGE_CEILING_MIN', c.HVWA_RANGE_CEILING_MIN >= c.HVWA_RANGE_MAX_MIN, 'must be at least HVWA_RANGE_MAX_MIN');
  // Spec §5: i-<id>.<domain> are instances and c-<user>.<domain> request catchers; nothing else may look like them.
  need('HVWA_PORTAL_HOST', !/^[ic]-/.test(c.HVWA_PORTAL_HOST ?? ''),
    'its first label must not start with i- or c- (instance and request-catcher hosts)');
}).transform((c) => ({
  domain: c.HVWA_RANGE_DOMAIN as string,
  portalHost: c.HVWA_PORTAL_HOST ?? (c.HVWA_RANGE_DOMAIN as string),
  publicScheme: c.HVWA_RANGE_PUBLIC_SCHEME,
  publicPort: c.HVWA_RANGE_PUBLIC_PORT,
  capacity: c.HVWA_RANGE_CAPACITY,
  idleMs: c.HVWA_RANGE_IDLE_MIN * 60_000,
  maxMs: c.HVWA_RANGE_MAX_MIN * 60_000,
  extendMs: c.HVWA_RANGE_EXTEND_MIN * 60_000,
  ceilingMs: c.HVWA_RANGE_CEILING_MIN * 60_000,
  registrationCode: c.HVWA_REGISTRATION_CODE,
  wardenUrl: c.HVWA_WARDEN_URL,
  wardenSecret: c.HVWA_WARDEN_SECRET as string,
  forwardAuthSecret: c.HVWA_FORWARD_AUTH_SECRET as string,
  rangeKey: c.HVWA_RANGE_KEY,
  internalHost: c.HVWA_FORWARD_AUTH_HOST,
  registryPath: c.HVWA_LAB_REGISTRY,
}));

export type RangeConfig = z.output<typeof schema>;
export type RangeConfigResult = { ok: true; config: RangeConfig } | { ok: false; errors: string[] };

/** Parse without throwing; one `<NAME>: <message>` line per problem (never a value). */
export function loadRangeConfig(env: Record<string, string | undefined> = process.env): RangeConfigResult {
  const r = schema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message.replace(/\s+/g, ' ')}`) };
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/config.spec.ts tests/range-config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck` (from `C:\Users\Sahuagin\Documents\hvwa`). Expected: all green.

```bash
git add src/config.ts src/range/config.ts tests/support/setup.ts tests/config.spec.ts tests/range-config.spec.ts
git commit -m "feat(range): HVWA_MODE and the portal-mode settings"
```

---

### Task 2: Accounts migration (`users`) that keeps lite databases working

**Files:**
- Create: `src/db/users.sql`
- Modify: `src/db/index.ts` (migration step 3), `src/auth/service.ts` (table name only), `README.md` (recipes)
- Modify tests: `tests/db.spec.ts`, `tests/smoke.spec.ts`, `tests/auth.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/db.spec.ts`, replace the first case with:

```ts
  it('the platform schema holds only platform state: solves, hint_unlocks, events, the login (users, auth_tokens), the range settings', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(tables(db)).toEqual(['auth_tokens', 'events', 'hint_unlocks', 'range_settings', 'solves', 'users']);
    // The login keeps hashes only (src/auth): no column could hold a password or a token in plaintext.
    expect(columns(db, 'users')).toEqual(['id', 'username', 'password_hash', 'role', 'created_at', 'disabled', 'is_default',
      'failures', 'locked_until', 'changed_at']);
    expect(columns(db, 'auth_tokens')).toEqual(['token_hash', 'username', 'created_at', 'last_seen_at']);
    expect(columns(db, 'range_settings')).toEqual(['key', 'value']);
    expect(columns(db, 'solves')).toEqual(
      expect.arrayContaining(['session_id', 'challenge_id', 'level', 'points', 'solved_at']));
    expect(columns(db, 'hint_unlocks')).toEqual(
      expect.arrayContaining(['session_id', 'challenge_id', 'tier', 'cost']));
  });

  it('upgrades a version-2 (lite) database: the admin keeps its hash, backoff and banner state; tokens and progress stay', () => {
    const db = openDb(':memory:');
    migrate(db, MIGRATIONS.slice(0, 2));
    db.prepare(`INSERT INTO auth_accounts (username, password_hash, is_default, failures, locked_until, changed_at)
      VALUES ('admin', 'scrypt$kept', 0, 3, 0, 1700)`).run();
    db.prepare("INSERT INTO auth_tokens (token_hash, username, created_at, last_seen_at) VALUES ('t1', 'admin', 1, 2)").run();
    db.prepare("INSERT INTO solves (session_id,challenge_id,level,points,solved_at) VALUES ('s','GK-01','acolyte',100,1)").run();
    migrate(db);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.prepare(`SELECT id, username, password_hash, role, created_at, disabled, is_default, failures, locked_until, changed_at
      FROM users`).all()).toEqual([{
      id: 1, username: 'admin', password_hash: 'scrypt$kept', role: 'admin', created_at: 1700, disabled: 0, is_default: 0,
      failures: 3, locked_until: 0, changed_at: 1700,
    }]);
    expect(db.prepare('SELECT token_hash, username FROM auth_tokens').all()).toEqual([{ token_hash: 't1', username: 'admin' }]);
    expect(db.prepare('SELECT COUNT(*) c FROM solves').get()).toMatchObject({ c: 1 });
    expect(tables(db)).not.toContain('auth_accounts');
  });

  it('usernames are unique whatever their case; a role is player or admin', () => {
    const db = openDb(':memory:');
    migrate(db);
    const add = (name: string, role: string) => db.prepare(
      'INSERT INTO users (username, password_hash, role, created_at, changed_at) VALUES (?, ?, ?, 1, 1)').run(name, 'h', role);
    add('alice', 'player');
    expect(() => add('ALICE', 'player')).toThrow(/UNIQUE/);
    expect(() => add('bob', 'root')).toThrow(/CHECK/);
  });
```

In `tests/smoke.spec.ts`, add `SCHEMA_VERSION` to the existing import from `'../src/db/index.js'` and replace the two assertions:

```ts
    expect(names.map((r) => r.name)).toEqual(['auth_tokens', 'events', 'hint_unlocks', 'range_settings', 'solves', 'users']);
    expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: SCHEMA_VERSION });
```

In `tests/auth.spec.ts`, replace the table name `auth_accounts` with `users` in all seven SQL strings (lines 289, 356, 448, 881, 884, 904 and 937 today; `grep -n auth_accounts tests/auth.spec.ts` must print nothing afterwards), and replace the README-recipe expectation (line 478) with:

```ts
    expect(sql).toEqual(['UPDATE users SET failures=0, locked_until=0', 'DELETE FROM auth_tokens; DELETE FROM users']);
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/db.spec.ts tests/smoke.spec.ts tests/auth.spec.ts`
Expected: FAIL — no `users` table, no `range_settings`, README still names `auth_accounts`.

- [ ] **Step 3: Implement**

Create `src/db/users.sql`:

```sql
-- src/db/users.sql — PLATFORM schema, migration step 3 (see MIGRATIONS in index.ts): the login generalised to many
-- users (src/auth, spec 2026-11-20 range §4) and the range's admin switches. Frozen once released.
-- The admin row of step 2 moves over with its hash, backoff and default-password state, and auth_tokens is not
-- touched (it joins users by username, which is unique and never renamed): an upgraded lite database keeps its
-- password, its signed-in browsers and its progress (solves and hint_unlocks are keyed by hvwa_sid).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,           -- scrypt$N$r$p$<salt>$<key>, base64url
  role          TEXT    NOT NULL CHECK (role IN ('player', 'admin')),
  created_at    INTEGER NOT NULL,           -- ms epoch
  disabled      INTEGER NOT NULL DEFAULT 0, -- 1: no sign-in, no session, no instance
  is_default    INTEGER NOT NULL DEFAULT 0, -- 1 while a password someone else chose is in use (the banner)
  failures      INTEGER NOT NULL DEFAULT 0, -- consecutive failed checks (brute-force backoff)
  locked_until  INTEGER NOT NULL DEFAULT 0, -- ms epoch; checks before it are refused
  changed_at    INTEGER NOT NULL            -- ms epoch of creation or the last password change
);
-- Unique whatever the case ('Alice' cannot sit next to 'alice'); the plain index serves exact sign-in lookups.
CREATE UNIQUE INDEX users_username_nocase ON users (username COLLATE NOCASE);
CREATE INDEX users_username ON users (username);

INSERT INTO users (username, password_hash, role, created_at, disabled, is_default, failures, locked_until, changed_at)
  SELECT username, password_hash, 'admin', changed_at, 0, is_default, failures, locked_until, changed_at FROM auth_accounts;
DROP TABLE auth_accounts;

-- The admin's switches in portal mode (src/auth/settings.ts): registration_open ('1' / '0'), event_code.
CREATE TABLE range_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

In `src/db/index.ts`, append to `MIGRATIONS` (after step 2):

```ts
  // 3: many users (users replaces auth_accounts; auth_tokens unchanged) and the range's admin switches. src/auth.
  (db: DatabaseSync) => db.exec(readFileSync(join(here, 'users.sql'), 'utf8')),
```

In `src/auth/service.ts`, change only the table the statements use (the service still has one admin; Task 3 generalises it):

```ts
  const getAccount = db.prepare(
    'SELECT username, password_hash, is_default, failures, locked_until FROM users WHERE username = ?');
  const setBackoff = db.prepare('UPDATE users SET failures = ?, locked_until = ? WHERE username = ?');
  const clearBackoff = db.prepare('UPDATE users SET failures = 0, locked_until = 0 WHERE username = ?');
```

```ts
  const findToken = db.prepare(`SELECT t.username, t.created_at, t.last_seen_at, a.is_default
    FROM auth_tokens t JOIN users a ON a.username = t.username WHERE t.token_hash = ?`);
```

```ts
  const setPassword = db.prepare(`UPDATE users SET password_hash = ?, is_default = ?, failures = 0, locked_until = 0,
    changed_at = ? WHERE username = ?`);
```

and the first-start insert:

```ts
  if (accountCreated) {
    const first = opts.initialPassword ?? DEFAULT_ADMIN_PASSWORD;
    if (first.length < PASSWORD_MIN_LENGTH || first.length > PASSWORD_MAX_LENGTH || CONTROL.test(first)) {
      // Never the value itself in the message.
      throw new Error(`auth: the initial password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters and no control characters`);
    }
    const t = now();
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at, is_default, failures, locked_until, changed_at)
      VALUES (?, ?, 'admin', ?, ?, 0, 0, ?)`).run(ADMIN_USERNAME, hasher.hashSync(first), t, first === DEFAULT_ADMIN_PASSWORD ? 1 : 0, t);
  }
```

Also update the header comment's storage line to: `// Storage (platform DB, migrations 2 and 3, src/db/auth.sql + users.sql): users holds the scrypt hash only;`.

In `README.md`, the two recipes become (only the SQL changes):

```sh
  docker exec hvwa-app-1 node -e "new (require('node:sqlite').DatabaseSync)('/data/hvwa.db').exec('UPDATE users SET failures=0, locked_until=0')"
```

```sh
  docker exec hvwa-app-1 node -e "new (require('node:sqlite').DatabaseSync)('/data/hvwa.db').exec('DELETE FROM auth_tokens; DELETE FROM users')"
```

and after the paragraph that starts "These work with both compose files" add this paragraph:

```md
  Images published before the range release (for example `sigmajo/hvwa:lite` of 2026-11-18) still call the account
  table `auth_accounts`: with those, write `auth_accounts` where the commands above say `users`.
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/db.spec.ts tests/smoke.spec.ts tests/auth.spec.ts tests/server-startup.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/db/users.sql src/db/index.ts src/auth/service.ts README.md tests/db.spec.ts tests/smoke.spec.ts tests/auth.spec.ts
git commit -m "feat(auth): users table (migration 3); lite databases keep admin, tokens and progress"
```

---

### Task 3: Multi-user `AuthService`: roles, disabled accounts, registration, admin operations

**Files:**
- Modify: `src/auth/service.ts` (full replacement below)
- Modify: `tests/helpers.ts` (`FAST_HASHER`)
- Test: `tests/auth-users.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/helpers.ts` (and add `import { createHash } from 'node:crypto';` and `import type { PasswordHasher } from '../src/auth/password.js';` to its imports):

```ts
/**
 * A password hasher for specs that create many accounts: SHA-256, NOT scrypt. Only tests use it (scrypt itself is
 * covered by tests/auth-password.spec.ts and the auth specs that pass no hasher).
 */
export const FAST_HASHER: PasswordHasher = Object.freeze({
  hash: async (p: string) => `fast$${createHash('sha256').update(p).digest('hex')}`,
  hashSync: (p: string) => `fast$${createHash('sha256').update(p).digest('hex')}`,
  verify: async (p: string, stored: string) => stored === `fast$${createHash('sha256').update(p).digest('hex')}`,
});
```

Create `tests/auth-users.spec.ts`:

```ts
// The login generalised to many users (src/auth/service.ts, spec range §4): registration rules, roles, disabled
// accounts and the admin operations, on the same backoff, check cap, tokens and CSRF as the single-admin login.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService, USERNAME_RE, type AuthServiceOptions } from '../src/auth/service.js';
import type { PasswordHasher } from '../src/auth/password.js';
import { FAST_HASHER } from './helpers.js';

const T0 = Date.UTC(2026, 10, 20, 9);
const PW = 'Player-Pass-1';
const ADMIN_PW = 'Admin-Pass-1234';
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });

function make(opts: AuthServiceOptions = {}) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = T0;
  const service = createAuthService(db, { hasher: FAST_HASHER, now: () => t, initialPassword: ADMIN_PW, passwordMinLength: 10, ...opts });
  return { db, service, advance: (ms: number) => { t += ms; } };
}
async function token(service: ReturnType<typeof make>['service'], username: string, password: string): Promise<string> {
  const r = await service.signIn(username, password);
  if (!r.ok) throw new Error(`sign-in of ${username} failed`);
  return r.token;
}

describe('register', () => {
  it('creates a player from a lower-cased username; it signs in and its session carries id and role', async () => {
    const { service } = make();
    expect(await service.register('  Alice_01 ', PW, PW)).toEqual({ ok: true, userId: 2 });
    expect(service.getUser(2)).toEqual({ id: 2, username: 'alice_01', role: 'player', createdAt: T0, disabled: false });
    expect(service.session(await token(service, 'alice_01', PW)))
      .toEqual({ userId: 2, username: 'alice_01', role: 'player', defaultPassword: false });
    expect(service.session(await token(service, 'admin', ADMIN_PW)))
      .toEqual({ userId: 1, username: 'admin', role: 'admin', defaultPassword: false });
  });

  it.each([
    ['ab', 'username'], ['a'.repeat(25), 'username'], ['al ice', 'username'], ['alice-1', 'username'],
    ['alicé', 'username'], ['', 'username'], ['admin', 'taken'], ['ADMIN', 'taken'],
  ] as const)('refuses the username %j (%s)', async (name, error) => {
    const { service } = make();
    expect(await service.register(name, PW, PW)).toEqual({ ok: false, error });
    expect(service.listUsers()).toHaveLength(1);
  });

  it('USERNAME_RE is exactly 3 to 24 of [a-z0-9_]', () => {
    expect(['abc', 'a_1', 'x'.repeat(24)].every((n) => USERNAME_RE.test(n))).toBe(true);
    expect(['ab', 'x'.repeat(25), 'ABC', 'a.b', 'a-b'].some((n) => USERNAME_RE.test(n))).toBe(false);
  });

  it('password rules: passwordMinLength (10 here), at most 1024, no control characters, both entries equal', async () => {
    const { service } = make();
    expect(await service.register('bob', 'Short-pw1', 'Short-pw1')).toEqual({ ok: false, error: 'too_short' });
    expect(await service.register('bob', 'x'.repeat(1025), 'x'.repeat(1025))).toEqual({ ok: false, error: 'too_long' });
    expect(await service.register('bob', 'Player\u0000Pass1', 'Player\u0000Pass1')).toEqual({ ok: false, error: 'control' });
    expect(await service.register('bob', PW, `${PW}x`)).toEqual({ ok: false, error: 'mismatch' });
    expect(await service.register('bob', PW, PW)).toMatchObject({ ok: true });
  });

  it('admit() is asked after validation and before hashing: false means "limited" and nothing is created', async () => {
    const hashed: string[] = [];
    const hasher: PasswordHasher = { ...FAST_HASHER, hash: async (p) => { hashed.push(p); return FAST_HASHER.hash(p); } };
    const { service } = make({ hasher });
    const before = hashed.length; // the dummy hash made at start-up
    let asked = 0;
    expect(await service.register('ab', PW, PW, () => { asked += 1; return true; })).toEqual({ ok: false, error: 'username' });
    expect(asked).toBe(0);
    expect(await service.register('carol', PW, PW, () => false)).toEqual({ ok: false, error: 'limited' });
    expect(hashed.length).toBe(before);
    expect(service.listUsers().map((u) => u.username)).toEqual(['admin']);
  });

  it('two registrations of one name at once: one account, the other is "taken"', async () => {
    const { service } = make();
    const results = await Promise.all([service.register('dave', PW, PW), service.register('DAVE', PW, PW)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'taken' }]);
  });
});

describe('disabled accounts and roles', () => {
  it('disabling revokes every token and refuses sign-in with the uniform failure (still one password check)', async () => {
    let verifies = 0;
    const hasher: PasswordHasher = { ...FAST_HASHER, verify: async (p, s) => { verifies += 1; return FAST_HASHER.verify(p, s); } };
    const { service } = make({ hasher });
    const { userId } = await service.register('erin', PW, PW) as { ok: true; userId: number };
    const erinToken = await token(service, 'erin', PW);
    expect(service.setDisabled(1, userId, true)).toEqual({ ok: true });
    expect(service.session(erinToken)).toBeUndefined();
    expect(service.isActive(userId)).toBe(false);
    const n = verifies;
    expect(await service.signIn('erin', PW)).toEqual({ ok: false });
    expect(verifies).toBe(n + 1);
    expect(service.setDisabled(1, userId, false)).toEqual({ ok: true });
    expect(service.isActive(userId)).toBe(true);
    expect(service.session(await token(service, 'erin', PW))).toMatchObject({ username: 'erin' });
  });

  it('an admin cannot disable or demote itself; unknown ids are "unknown"', async () => {
    const { service } = make();
    expect(service.setDisabled(1, 1, true)).toEqual({ ok: false, error: 'self' });
    expect(service.setRole(1, 1, 'player')).toEqual({ ok: false, error: 'self' });
    expect(service.setDisabled(1, 99, true)).toEqual({ ok: false, error: 'unknown' });
    expect(service.setRole(1, 99, 'admin')).toEqual({ ok: false, error: 'unknown' });
    expect(service.isActive(99)).toBe(false);
    expect(service.isActive(Number.NaN)).toBe(false);
  });

  it('setRole makes a player admin; the next session says so', async () => {
    const { service } = make();
    const { userId } = await service.register('frank', PW, PW) as { ok: true; userId: number };
    expect(service.setRole(1, userId, 'admin')).toEqual({ ok: true });
    expect(service.session(await token(service, 'frank', PW))).toMatchObject({ role: 'admin' });
    expect(service.listUsers().map((u) => [u.username, u.role])).toEqual([['admin', 'admin'], ['frank', 'admin']]);
  });
});

describe('resetPassword (the admin\'s reset, spec §14: no e-mail)', () => {
  it('returns a new 16-character password once, revokes every token, sets the banner, clears the backoff', async () => {
    const { db, service } = make();
    const { userId } = await service.register('gina', PW, PW) as { ok: true; userId: number };
    const old = await token(service, 'gina', PW);
    db.prepare("UPDATE users SET failures = 4 WHERE username = 'gina'").run();
    const r = await service.resetPassword(userId);
    expect(r).toMatchObject({ ok: true });
    const fresh = (r as { ok: true; password: string }).password;
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(service.session(old)).toBeUndefined();
    expect(await service.signIn('gina', PW)).toEqual({ ok: false });
    const t = await token(service, 'gina', fresh);
    expect(service.session(t)).toMatchObject({ defaultPassword: true });
    const changed = await service.changePassword('gina', fresh, 'Gina-New-Pass-1', 'Gina-New-Pass-1');
    expect(changed).toMatchObject({ ok: true });
    expect(service.session((changed as { ok: true; token: string }).token)).toMatchObject({ defaultPassword: false });
    expect(await service.resetPassword(99)).toEqual({ ok: false, error: 'unknown' });
  });

  it('a password change follows passwordMinLength (10 in portal mode)', async () => {
    const { service } = make();
    expect(await service.changePassword('admin', ADMIN_PW, 'Nine-char', 'Nine-char')).toEqual({ ok: false, error: 'too_short' });
    expect(service.passwordMinLength).toBe(10);
    expect(make({ passwordMinLength: undefined }).service.passwordMinLength).toBe(8);
    expect(() => make({ passwordMinLength: 4 })).toThrow(/passwordMinLength/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/auth-users.spec.ts`
Expected: FAIL — `register`, `getUser`, `setDisabled`, `setRole`, `resetPassword`, `isActive`, `listUsers`, `passwordMinLength` and `USERNAME_RE` do not exist, and `session()` has no `userId`/`role`.

- [ ] **Step 3: Implement**

Replace `src/auth/service.ts` with:

```ts
// src/auth/service.ts — the platform login's state: the accounts (users: the admin alone in standalone mode, the admin
// and every registered player in portal mode), sign-in tokens, the brute-force backoff, the password-check cap and the
// CSRF tokens of the platform forms. PLATFORM code: it guards the labs and must not be a vulnerability
// (docs/SECURITY.md "The platform login").
//
// Storage (platform DB, migrations 2 and 3, src/db/auth.sql + users.sql): users holds the scrypt hash only;
// auth_tokens holds the SHA-256 of each token, never the token (the browser's hvwa_auth cookie has it). In standalone
// mode lab state, flags and the scoreboard stay keyed by hvwa_sid; in portal mode the range keys progress by users.id
// (src/range/progress.ts).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SCRYPT_HASHER, type PasswordHasher } from './password.js';

export const ADMIN_USERNAME = 'admin';
/** The DVWA-style default, used when HVWA_ADMIN_PASSWORD is unset on first start. Change it after signing in. */
export const DEFAULT_ADMIN_PASSWORD = 'password';
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 1024;
const USERNAME_MAX_LENGTH = 64;
/** A registered username (spec range §4): 3 to 24 of [a-z0-9_]. register() lower-cases what was typed first. */
export const USERNAME_RE = /^[a-z0-9_]{3,24}$/;
export const ROLES = Object.freeze(['player', 'admin'] as const);
export type Role = (typeof ROLES)[number];
export function isRole(x: unknown): x is Role {
  return x === 'player' || x === 'admin';
}

/** The platform's auth cookie (RECIPES section 4: hvwa_* names are the platform's; labs never use them). */
export const AUTH_COOKIE = 'hvwa_auth';

export const AUTH_LIMITS = Object.freeze({
  /** Consecutive failures before the account locks. */
  freeFailures: 5,
  /** The first lock; each further failure doubles it... */
  lockBaseMs: 30_000,
  /** ...up to this. */
  lockCapMs: 15 * 60_000,
  /** A token's absolute lifetime (also the cookie's Max-Age). */
  tokenTtlMs: 12 * 60 * 60_000,
  /** A token unused this long is dead. */
  idleMs: 2 * 60 * 60_000,
  /** last_seen_at is written at most this often (not one DB write per request). */
  touchEveryMs: 60_000,
  /** Newest tokens kept per account (one per browser that signed in); older ones are revoked. */
  maxTokens: 20,
  /**
   * Password checks (and hashes) running at once. Every attempt costs one scrypt on libuv's thread pool (4 threads), a
   * locked or unknown-user one included (uniform timing), and so does every registration and admin reset, so a flood
   * could keep the pool busy for the whole app. 2 leave the rest of the pool free and hold at most 64 MiB of scrypt.
   */
  checksInFlight: 2,
  /** Attempts that may wait for a check slot; beyond them an attempt is refused at once (503), unchecked. */
  checksQueued: 8,
});

/** How long the account stays locked after its `failures`-th consecutive failure (0 = not locked). */
export function lockMsAfter(failures: number): number {
  const { freeFailures, lockBaseMs, lockCapMs } = AUTH_LIMITS;
  if (!(failures >= freeFailures)) return 0;
  const exp = failures - freeFailures;
  return exp >= 30 ? lockCapMs : Math.min(lockCapMs, lockBaseMs * 2 ** exp);
}

/** A token as minted: 32 random bytes, base64url (43 characters). Anything else is never looked up. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AuthServiceOptions {
  /** Clock in ms (tokens, idle timeout, backoff, created_at). Default Date.now; tests inject a fake one. */
  now?: () => number;
  /** First password of the admin account, used only when no admin account exists yet. Default 'password'. */
  initialPassword?: string;
  /** Test seam: wraps the scrypt hasher (e.g. to count checks). Never set by server.ts. */
  hasher?: PasswordHasher;
  /** The shortest NEW password (change, registration). Default PASSWORD_MIN_LENGTH; portal mode passes 10 (spec §4). */
  passwordMinLength?: number;
}

export interface AuthSession {
  readonly userId: number;
  readonly username: string;
  readonly role: Role;
  /** A password someone else chose is in use: the default one, or an admin's reset (the banner). */
  readonly defaultPassword: boolean;
}

export interface UserSummary {
  readonly id: number;
  readonly username: string;
  readonly role: Role;
  readonly createdAt: number;
  readonly disabled: boolean;
}

export type PasswordChangeError = 'current' | 'too_short' | 'too_long' | 'control' | 'mismatch' | 'same' | 'default' | 'busy';

/** C0 controls and DEL: never part of a new password (NUL would even collide in scrypt, see password.ts). */
const CONTROL = /[\u0000-\u001f\u007f]/;
export type PasswordChange = { ok: true; token: string } | { ok: false; error: PasswordChangeError };
export type RegisterError = 'username' | 'taken' | 'too_short' | 'too_long' | 'control' | 'mismatch' | 'limited' | 'busy';
export type Registration = { ok: true; userId: number } | { ok: false; error: RegisterError };
export type AdminChange = { ok: true } | { ok: false; error: 'unknown' | 'self' };
export type PasswordReset = { ok: true; password: string } | { ok: false; error: 'unknown' | 'busy' };

export interface AuthService {
  /**
   * Sign in; on success a fresh token for the hvwa_auth cookie. Every credential failure (a disabled account included)
   * is the same `{ ok: false }`; `busy` means the attempt was refused unchecked because every check slot was taken.
   */
  signIn(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; busy?: true }>;
  /** The live session of a cookie value (touching it), or undefined for a missing, unknown, expired or disabled one. */
  session(token: unknown): AuthSession | undefined;
  /** Revoke one token (sign-out). Unknown tokens are ignored. */
  revoke(token: unknown): void;
  /** Change the password; on success EVERY token of the account is revoked and a new one is minted for this browser. */
  changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange>;
  /** Whether the admin account still uses the default password (the startup warning). */
  usesDefaultPassword(): boolean;
  /** Password checks running and waiting right now (AUTH_LIMITS.checksInFlight / checksQueued). */
  checkLoad(): { inFlight: number; queued: number };
  /** Whether THIS start created the admin account (so `initialPassword` was used); false when it already existed. */
  readonly accountCreated: boolean;
  /** The shortest new password this service accepts (the views' minlength and help text). */
  readonly passwordMinLength: number;
  /**
   * A form's synchroniser token. The login and registration forms' is bound to hvwa_sid (the browser has no sign-in
   * yet); the account forms' (logout, password, admin and range actions) also to the sign-in, `authToken` (the
   * hvwa_auth cookie): any same-host page can plant an hvwa_sid and read a page served to it, but not the sign-in.
   */
  csrfToken(sessionId: string, authToken?: string): string;
  /** Constant-time check of a submitted form token against the expected one (same arguments as csrfToken). */
  checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean;
  /**
   * Create a player (portal mode's /register). The username is trimmed and lower-cased, then must match USERNAME_RE
   * and be free whatever its case; the password follows passwordMinLength. `admit` (the per-IP limit) is asked after
   * every cheap check and right before the hash, under the same check slots as a sign-in.
   */
  register(username: string, password: string, confirm: string, admit?: () => boolean): Promise<Registration>;
  /** This account exists and is not disabled (the range's gate, forward-auth and launches). */
  isActive(userId: number): boolean;
  /** Every account, by id. */
  listUsers(): UserSummary[];
  getUser(id: number): UserSummary | undefined;
  /** Disable (revoking every token) or enable an account. `actorId` may not disable itself. */
  setDisabled(actorId: number, id: number, disabled: boolean): AdminChange;
  /** Make an account admin or player. `actorId` may not demote itself. */
  setRole(actorId: number, id: number, role: Role): AdminChange;
  /** A new random password, returned once: every token revoked, the backoff cleared, the banner on until it is changed. */
  resetPassword(id: number): Promise<PasswordReset>;
}

interface AccountRow {
  id: number; username: string; password_hash: string; role: string; disabled: number;
  is_default: number; failures: number; locked_until: number;
}
interface UserRow { id: number; username: string; role: string; created_at: number; disabled: number }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const summary = (r: UserRow): UserSummary => ({
  id: Number(r.id), username: r.username, role: isRole(r.role) ? r.role : 'player',
  createdAt: Number(r.created_at), disabled: r.disabled === 1,
});

/**
 * At most `max` jobs at once and `queueMax` waiting (FIFO); a job beyond that is not run at all. A finishing job
 * hands its slot straight to the next waiter, so the cap holds at every moment.
 */
function slots(max: number, queueMax: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    load: () => ({ inFlight: active, queued: waiting.length }),
    async run<T>(job: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
      if (active < max) active += 1;
      else if (waiting.length < queueMax) await new Promise<void>((resolve) => { waiting.push(resolve); });
      else return { ran: false };
      try {
        return { ran: true, value: await job() };
      } finally {
        const next = waiting.shift();
        if (next) next(); else active -= 1;
      }
    },
  };
}

/**
 * The login state over the platform DB. Creates the admin account on first use (no admin yet) with `initialPassword`
 * or the default. Brute force: one password check per attempt whatever happens (a dummy hash for an unknown username,
 * a locked or a disabled account, so timing tells nothing); each attempt is counted as a failure BEFORE the check, so
 * a parallel burst cannot run more than `freeFailures` real checks; the fifth consecutive failure locks the account
 * (lockMsAfter), a success resets the count, attempts while locked are refused unchecked and do not extend the lock.
 */
export function createAuthService(db: DatabaseSync, opts: AuthServiceOptions = {}): AuthService {
  const now = opts.now ?? Date.now;
  const hasher = opts.hasher ?? SCRYPT_HASHER;
  const minLength = opts.passwordMinLength ?? PASSWORD_MIN_LENGTH;
  if (!Number.isInteger(minLength) || minLength < PASSWORD_MIN_LENGTH || minLength > 128) {
    throw new Error(`auth: passwordMinLength must be an integer from ${PASSWORD_MIN_LENGTH} to 128`);
  }
  const csrfKey = randomBytes(32); // per process: a restart only expires open forms
  const checks = slots(AUTH_LIMITS.checksInFlight, AUTH_LIMITS.checksQueued);

  const getAccount = db.prepare(
    'SELECT id, username, password_hash, role, disabled, is_default, failures, locked_until FROM users WHERE username = ?');
  const getUserRow = db.prepare('SELECT id, username, role, created_at, disabled FROM users WHERE id = ?');
  const nameTaken = db.prepare('SELECT 1 AS taken FROM users WHERE username = ? COLLATE NOCASE');
  const listAll = db.prepare('SELECT id, username, role, created_at, disabled FROM users ORDER BY id');
  const insertUser = db.prepare(`INSERT INTO users (username, password_hash, role, created_at, disabled, is_default,
    failures, locked_until, changed_at) VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?)`);
  const setBackoff = db.prepare('UPDATE users SET failures = ?, locked_until = ? WHERE username = ?');
  const clearBackoff = db.prepare('UPDATE users SET failures = 0, locked_until = 0 WHERE username = ?');
  const setDisabledRow = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');
  const setRoleRow = db.prepare('UPDATE users SET role = ? WHERE id = ?');
  const insertToken = db.prepare(
    'INSERT INTO auth_tokens (token_hash, username, created_at, last_seen_at) VALUES (?, ?, ?, ?)');
  const pruneTokens = db.prepare(`DELETE FROM auth_tokens WHERE username = ? AND (created_at <= ? OR last_seen_at <= ?
    OR rowid NOT IN (SELECT rowid FROM auth_tokens WHERE username = ? ORDER BY rowid DESC LIMIT ?))`);
  const findToken = db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.is_default, t.created_at, t.last_seen_at
    FROM auth_tokens t JOIN users u ON u.username = t.username WHERE t.token_hash = ?`);
  const touchToken = db.prepare('UPDATE auth_tokens SET last_seen_at = ? WHERE token_hash = ?');
  const deleteToken = db.prepare('DELETE FROM auth_tokens WHERE token_hash = ?');
  const deleteAllTokens = db.prepare('DELETE FROM auth_tokens WHERE username = ?');
  const setPassword = db.prepare(`UPDATE users SET password_hash = ?, is_default = ?, failures = 0, locked_until = 0,
    changed_at = ? WHERE username = ?`);

  // First start: create the admin. Synchronous (once), so the app never serves without one.
  const accountCreated = !getAccount.get(ADMIN_USERNAME);
  if (accountCreated) {
    const first = opts.initialPassword ?? DEFAULT_ADMIN_PASSWORD;
    if (first.length < PASSWORD_MIN_LENGTH || first.length > PASSWORD_MAX_LENGTH || CONTROL.test(first)) {
      // Never the value itself in the message.
      throw new Error(`auth: the initial password must have ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters and no control characters`);
    }
    const t = now();
    insertUser.run(ADMIN_USERNAME, hasher.hashSync(first), 'admin', t, first === DEFAULT_ADMIN_PASSWORD ? 1 : 0, t);
  }

  // Same cost as a real check: unknown usernames, locked and disabled accounts verify against this.
  const dummy = hasher.hash(randomBytes(32).toString('base64url'));
  dummy.catch(() => { /* surfaced on first use */ });

  const account = (username: string): AccountRow | undefined =>
    (username.length > USERNAME_MAX_LENGTH ? undefined : getAccount.get(username) as AccountRow | undefined);
  const user = (id: number): UserSummary | undefined => {
    if (!Number.isSafeInteger(id) || id < 1) return undefined;
    const row = getUserRow.get(id) as UserRow | undefined;
    return row ? summary(row) : undefined;
  };

  /** One password check under the backoff rules. Exactly one hasher.verify() call, whatever the outcome. */
  async function check(username: string, password: string): Promise<boolean> {
    const acct = account(username);
    const t = now();
    const open = acct !== undefined && t >= acct.locked_until; // a locked account is refused unchecked
    if (acct && open) {
      // Count the attempt as a failure up front (synchronously, before the first await), so concurrent
      // attempts see it; the fifth one locks. A success below clears it.
      const failures = acct.failures + 1;
      const lock = lockMsAfter(failures);
      setBackoff.run(failures, lock > 0 ? t + lock : 0, acct.username);
    }
    const real = acct !== undefined && open && acct.disabled === 0 && password.length <= PASSWORD_MAX_LENGTH;
    const ok = await hasher.verify(real ? password : password.slice(0, PASSWORD_MAX_LENGTH), real ? acct.password_hash : await dummy);
    if (!ok || !real) return false;
    clearBackoff.run(acct.username);
    return true;
  }

  const newPasswordError = (next: string): 'too_short' | 'too_long' | 'control' | undefined =>
    (next.length < minLength ? 'too_short' : next.length > PASSWORD_MAX_LENGTH ? 'too_long' : CONTROL.test(next) ? 'control' : undefined);

  // Domain-separated: a login-form token is never an account-form token, nor one sign-in's another's.
  const csrfFor = (sessionId: string, authToken?: string) => createHmac('sha256', csrfKey)
    .update(authToken === undefined ? `hvwa-csrf:login:${sessionId}` : `hvwa-csrf:account:${sessionId}:${sha256(authToken)}`)
    .digest('base64url');

  function mint(username: string): string {
    const token = randomBytes(32).toString('base64url');
    const t = now();
    insertToken.run(sha256(token), username, t, t);
    pruneTokens.run(username, t - AUTH_LIMITS.tokenTtlMs, t - AUTH_LIMITS.idleMs, username, AUTH_LIMITS.maxTokens);
    return token;
  }

  return Object.freeze({
    async signIn(username: string, password: string) {
      const r = await checks.run(() => check(username, password));
      if (!r.ran) return { ok: false, busy: true } as const;
      if (!r.value) return { ok: false } as const;
      return { ok: true, token: mint(username) } as const;
    },

    session(token: unknown): AuthSession | undefined {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
      const hash = sha256(token);
      const row = findToken.get(hash) as {
        id: number; username: string; role: string; disabled: number; is_default: number; created_at: number; last_seen_at: number;
      } | undefined;
      if (!row) return undefined;
      const t = now();
      if (row.disabled === 1 || t - row.created_at >= AUTH_LIMITS.tokenTtlMs || t - row.last_seen_at >= AUTH_LIMITS.idleMs) {
        deleteToken.run(hash);
        return undefined;
      }
      if (t - row.last_seen_at >= AUTH_LIMITS.touchEveryMs) touchToken.run(t, hash);
      return {
        userId: Number(row.id), username: row.username, role: isRole(row.role) ? row.role : 'player',
        defaultPassword: row.is_default === 1,
      };
    },

    revoke(token: unknown): void {
      if (typeof token === 'string' && TOKEN_RE.test(token)) deleteToken.run(sha256(token));
    },

    async changePassword(username: string, current: string, next: string, confirm: string): Promise<PasswordChange> {
      const bad = newPasswordError(next);
      if (bad) return { ok: false, error: bad };
      if (next !== confirm) return { ok: false, error: 'mismatch' };
      if (next === current) return { ok: false, error: 'same' };
      if (next === DEFAULT_ADMIN_PASSWORD) return { ok: false, error: 'default' };
      // The check and the new hash share one slot: both are scrypt.
      const r = await checks.run(async () => ((await check(username, current)) ? hasher.hash(next) : undefined));
      if (!r.ran) return { ok: false, error: 'busy' };
      if (r.value === undefined) return { ok: false, error: 'current' };
      setPassword.run(r.value, 0, now(), username);
      deleteAllTokens.run(username);
      return { ok: true, token: mint(username) };
    },

    usesDefaultPassword(): boolean {
      return account(ADMIN_USERNAME)?.is_default === 1;
    },

    checkLoad: () => checks.load(),
    accountCreated,
    passwordMinLength: minLength,

    csrfToken: csrfFor,

    checkCsrf(sessionId: string, submitted: unknown, authToken?: string): boolean {
      if (typeof submitted !== 'string') return false;
      const expected = Buffer.from(csrfFor(sessionId, authToken));
      const got = Buffer.from(submitted);
      return got.length === expected.length && timingSafeEqual(got, expected);
    },

    async register(rawUsername: string, password: string, confirm: string, admit?: () => boolean): Promise<Registration> {
      const username = rawUsername.trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return { ok: false, error: 'username' };
      const bad = newPasswordError(password);
      if (bad) return { ok: false, error: bad };
      if (password !== confirm) return { ok: false, error: 'mismatch' };
      if (nameTaken.get(username)) return { ok: false, error: 'taken' };
      if (admit && !admit()) return { ok: false, error: 'limited' };
      const r = await checks.run(() => hasher.hash(password));
      if (!r.ran) return { ok: false, error: 'busy' };
      const t = now();
      try {
        const info = insertUser.run(username, r.value, 'player', t, 0, t);
        return { ok: true, userId: Number(info.lastInsertRowid) };
      } catch (err) {
        if (/UNIQUE constraint failed/.test(String(err))) return { ok: false, error: 'taken' }; // a concurrent twin
        throw err;
      }
    },

    isActive(userId: number): boolean {
      const u = user(userId);
      return u !== undefined && !u.disabled;
    },

    listUsers: () => (listAll.all() as unknown as UserRow[]).map(summary),
    getUser: user,

    setDisabled(actorId: number, id: number, disabled: boolean): AdminChange {
      const u = user(id);
      if (!u) return { ok: false, error: 'unknown' };
      if (actorId === id) return { ok: false, error: 'self' };
      setDisabledRow.run(disabled ? 1 : 0, id);
      if (disabled) deleteAllTokens.run(u.username);
      return { ok: true };
    },

    setRole(actorId: number, id: number, role: Role): AdminChange {
      const u = user(id);
      if (!u) return { ok: false, error: 'unknown' };
      if (actorId === id && role !== 'admin') return { ok: false, error: 'self' };
      setRoleRow.run(role, id);
      return { ok: true };
    },

    async resetPassword(id: number): Promise<PasswordReset> {
      const u = user(id);
      if (!u) return { ok: false, error: 'unknown' };
      const password = randomBytes(12).toString('base64url'); // 16 characters, 96 bits
      const r = await checks.run(() => hasher.hash(password));
      if (!r.ran) return { ok: false, error: 'busy' };
      setPassword.run(r.value, 1, now(), u.username);
      deleteAllTokens.run(u.username);
      return { ok: true, password };
    },
  });
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/auth-users.spec.ts tests/auth.spec.ts tests/auth-password.spec.ts tests/server-startup.spec.ts`
Expected: PASS (the existing auth specs are unchanged: one admin, same messages, same cookie, same backoff).

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/auth/service.ts tests/helpers.ts tests/auth-users.spec.ts
git commit -m "feat(auth): many users, roles, disabled accounts, registration and admin operations in the service"
```

---

### Task 4: Shared form guards, `formOk` / `requireAdmin`, Secure cookie option, user id and role in the layout

**Files:**
- Create: `src/auth/forms.ts`
- Modify: `src/auth/index.ts`, `src/auth/views/password.ejs`, `src/types/express.d.ts`, `src/core/i18n.ts`
- Modify: `tests/helpers.ts` (`csrfOf`, `authHarness`)
- Test: `tests/auth-forms.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/helpers.ts` (add the imports it needs: `import express from 'express';`, `import cookieParser from 'cookie-parser';`, `import type { Express } from 'express';` is already there, `import { openDb, migrate } from '../src/db/index.js';`, `import { platformAuth, type AuthOptions, type PlatformAuth } from '../src/auth/index.js';`, `import { sessionMiddleware } from '../src/core/session.js';`, `import { langMiddleware } from '../src/core/i18n.js';`, `import { themeMiddleware } from '../src/core/theme.js';`, `import { errorHandler, notFoundHandler } from '../src/core/errors.js';`):

```ts
/** The `_csrf` hidden field of a rendered form. */
export function csrfOf(html: string): string {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
}

/** The first password of the admin account in authHarness() apps. */
export const HARNESS_ADMIN_PASSWORD = 'Admin-Pass-1234';

/**
 * A bare Express app with only the platform login (no labs, no portal), for auth specs that mount routes of their own
 * after the gate (`extra`). FAST_HASHER unless `opts.hasher` is given; the DB closes when the test ends.
 */
export function authHarness(opts: AuthOptions = {}, extra?: (app: Express, auth: PlatformAuth) => void) {
  const db = openDb(':memory:');
  migrate(db);
  const auth = platformAuth(db, { hasher: FAST_HASHER, initialPassword: HARNESS_ADMIN_PASSWORD, ...opts });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware());
  app.use(langMiddleware());
  app.use(themeMiddleware());
  app.use(auth.publicRouter);
  app.use(auth.gate);
  app.use(auth.accountRouter);
  extra?.(app, auth);
  app.use(notFoundHandler());
  app.use(errorHandler());
  onTestFinished(() => { try { db.close(); } catch { /* closed by the test */ } });
  return { app, db, auth };
}
```

Create `tests/auth-forms.spec.ts`:

```ts
// The platform form guards other routers reuse (src/auth/forms.ts; PlatformAuth.formOk, csrfFor, refuse), requireAdmin,
// the Secure attribute of portal mode and the password page's minimum. Same rules as the login's own forms.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { requireAdmin } from '../src/auth/index.js';
import { authHarness, csrfOf, HARNESS_ADMIN_PASSWORD, setCookieHeader } from './helpers.js';
import { Router } from 'express';

type Agent = ReturnType<typeof request.agent>;
async function signIn(agent: Agent, username: string, password: string) {
  const page = await agent.get('/login');
  return agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username, password });
}
function harness(opts: Parameters<typeof authHarness>[0] = {}) {
  return authHarness(opts, (app, auth) => {
    app.get('/probe-token', (req, res) => { res.json({ csrf: auth.csrfFor(req) }); });
    app.post('/probe', async (req, res) => {
      if (!auth.formOk(req)) { await auth.refuse(req, res, '/'); return; }
      res.json({ ok: true, who: res.locals.platformAuth });
    });
    const admin = Router();
    admin.use(requireAdmin);
    admin.get('/admin/probe', (_req, res) => { res.send('admin only'); });
    app.use(admin);
  });
}

describe('PlatformAuth.formOk / csrfFor / refuse (account forms of other routers)', () => {
  it('accepts this browser\'s account token; the locals carry user id, name and role', async () => {
    const { app } = harness();
    const agent = request.agent(app);
    expect((await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD)).status).toBe(303);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    const res = await agent.post('/probe').type('form').send({ _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.body.who).toMatchObject({ signedIn: true, userId: 1, user: 'admin', role: 'admin', defaultPassword: false });
  });

  it('refuses a missing or login-form token, a foreign Origin and a cross-site fetch with the 403 page', async () => {
    const { app } = harness();
    const agent = request.agent(app);
    const loginToken = csrfOf((await agent.get('/login')).text);
    await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    for (const [label, send] of [
      ['no token', () => agent.post('/probe').type('form').send({})],
      ['login token', () => agent.post('/probe').type('form').send({ _csrf: loginToken })],
      ['foreign origin', () => agent.post('/probe').set('Origin', 'http://evil.example').type('form').send({ _csrf: csrf })],
      ['cross-site', () => agent.post('/probe').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: csrf })],
      ['same-site', () => agent.post('/probe').set('Sec-Fetch-Site', 'same-site').type('form').send({ _csrf: csrf })],
    ] as const) {
      const res = await send();
      expect(res.status, label).toBe(403);
      expect(res.text, label).toContain('data-testid="csrf-error"');
    }
  });
});

describe('requireAdmin', () => {
  it('lets an admin through; a player gets the ordinary 404', async () => {
    const { app, auth } = harness();
    await auth.service.register('player_one', 'Player-Pass-1', 'Player-Pass-1');
    const admin = request.agent(app);
    await signIn(admin, 'admin', HARNESS_ADMIN_PASSWORD);
    expect((await admin.get('/admin/probe')).text).toBe('admin only');
    const player = request.agent(app);
    expect((await signIn(player, 'player_one', 'Player-Pass-1')).status).toBe(303);
    expect((await player.get('/admin/probe')).status).toBe(404);
  });
});

describe('publicScheme (portal mode: the browser speaks https to Cloudflare, the portal sees http)', () => {
  it('the Origin must carry the public scheme, not the request\'s', async () => {
    const { app } = harness({ publicScheme: 'https' });
    const agent = request.agent(app);
    await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
    const { csrf } = (await agent.get('/probe-token')).body as { csrf: string };
    const post = (origin: string) => agent.post('/probe').set('Host', 'portal.test').set('Origin', origin).type('form').send({ _csrf: csrf });
    expect((await post('https://portal.test')).status).toBe(200);
    expect((await post('http://portal.test')).status).toBe(403);
  });
});

describe('secureCookies (portal mode, behind HTTPS)', () => {
  it('adds Secure to hvwa_auth; off by default (standalone serves plain http on loopback)', async () => {
    const secure = await signIn(request.agent(harness({ secureCookies: true }).app), 'admin', HARNESS_ADMIN_PASSWORD);
    expect(setCookieHeader(secure, 'hvwa_auth')).toMatch(/; Secure(;|$)/);
    const plain = await signIn(request.agent(harness().app), 'admin', HARNESS_ADMIN_PASSWORD);
    expect(setCookieHeader(plain, 'hvwa_auth')).not.toMatch(/Secure/);
  });
});

describe('the password page follows passwordMinLength', () => {
  it('minlength and the help text say 10 in portal mode, 8 by default', async () => {
    for (const [min, opts] of [[10, { passwordMinLength: 10 }], [8, {}]] as const) {
      const agent = request.agent(harness(opts).app);
      await signIn(agent, 'admin', HARNESS_ADMIN_PASSWORD);
      const page = (await agent.get('/account/password')).text;
      expect(page).toContain(`minlength="${min}"`);
      expect(page).toContain(`At least ${min} characters`);
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/auth-forms.spec.ts`
Expected: FAIL — `requireAdmin`, `formOk`, `csrfFor`, `refuse`, `secureCookies`, `publicScheme` do not exist; the password page has a fixed `minlength="8"`.

- [ ] **Step 3: Implement**

Create `src/auth/forms.ts` (the guards move here verbatim from `src/auth/index.ts`, now exported):

```ts
// src/auth/forms.ts — the platform's form guards, shared by every router that renders a platform form (login,
// registration, account, admin, range actions). PLATFORM code (docs/SECURITY.md "The platform login").
import type { Request, Response } from 'express';
import { AUTH_COOKIE } from './service.js';

/** Platform pages of the login: never cached, never framed (no clickjacking of the password forms). */
export function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('X-Frame-Options', 'DENY');
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
}

export const isApi = (req: Request) => /^\/api(?:\/|$)/i.test(req.path);
export const isHtmx = (req: Request) => req.get('HX-Request') === 'true';

/** The request's own origin host (Host header, normalised like URL.host: lowercased, default port dropped). */
export function ownHost(req: Request): string | undefined {
  try { return new URL(`http://${req.headers.host ?? ''}`).host; } catch { return undefined; }
}

/**
 * Same-origin check for the forms: an absent Origin passes (older clients, curl; the synchroniser token still
 * applies), a present one must be exactly this origin: `scheme` (default the request's own, req.protocol: 'http', as
 * 'trust proxy' is off; in portal mode the configured public scheme, because TLS ends at Cloudflare and the portal only
 * ever sees plain http) and the Host, port included. 'null', another port of the same host and every other origin
 * are refused.
 */
export function originOk(req: Request, scheme: string = req.protocol): boolean {
  const origin = req.get('origin');
  if (origin === undefined) return true;
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  return u.protocol === `${scheme}:` && u.origin === origin.toLowerCase() && u.host === ownHost(req);
}

/**
 * Fetch metadata: a browser marks every request with Sec-Fetch-Site. The forms accept only 'same-origin' (a page of
 * ours posting), or no header at all (older clients, curl). 'same-site' (another port of this host, or in portal mode
 * a lab host under the same domain), 'cross-site' and 'none' are refused.
 */
export function fetchSiteOk(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  return site === undefined || site.trim().toLowerCase() === 'same-origin';
}

/** The hvwa_auth cookie as presented (a string, else ''). */
export function authTokenOf(req: Request): string {
  const v: unknown = req.cookies?.[AUTH_COOKIE];
  return typeof v === 'string' ? v : '';
}

/**
 * After the gate, at the top of a Router: an admin goes on; anyone else leaves the router (next('router')) and gets the
 * same 404 as any unknown page, so the admin pages are not even advertised.
 */
export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (res.locals.platformAuth?.role === 'admin') next();
  else next('router');
};
```

(Its first line imports `type RequestHandler` too: `import type { Request, RequestHandler, Response } from 'express';`.)

In `src/auth/index.ts`:

1. Replace the imports block and the code from `export type AuthOptions = AuthServiceOptions;` down to (and including) `function authTokenOf(...) {...}` with:

```ts
import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { safeNext } from './next.js';
import { authTokenOf, fetchSiteOk, isApi, isHtmx, noStore, originOk, ownHost } from './forms.js';
import { AUTH_COOKIE, AUTH_LIMITS, createAuthService, type AuthService, type AuthServiceOptions } from './service.js';

export { safeNext } from './next.js';
export type { AuthService, AuthSession, Role, UserSummary } from './service.js';

/** createApp's `auth` option as an object (`auth: true` = all defaults). */
export interface AuthOptions extends AuthServiceOptions {
  /**
   * Give hvwa_auth the Secure attribute: portal mode behind the Cloudflare Tunnel (public scheme https). Off by default:
   * standalone serves plain http on loopback, where a Secure cookie would be dropped by most clients.
   */
  secureCookies?: boolean;
  /**
   * The scheme the BROWSER uses (portal mode: HVWA_RANGE_PUBLIC_SCHEME). The forms' Origin check compares against it,
   * since behind the tunnel the portal itself only sees plain http. Default: the request's own scheme.
   */
  publicScheme?: 'http' | 'https';
}

export const authViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
const view = (name: string) => join(authViewsDir, `${name}.ejs`);

// Explicit attributes: HttpOnly (no script reads it), SameSite=Lax (cross-site subrequests and posts never carry it),
// Path=/, Max-Age = the token's absolute lifetime, Secure only behind HTTPS (portal mode). No Domain (host-only).
function cookieAttributes(secure: boolean): { set: Readonly<CookieOptions>; clear: Readonly<CookieOptions> } {
  const base = { httpOnly: true, sameSite: 'lax', path: '/', ...(secure ? { secure: true } : {}) } as const;
  return { set: Object.freeze({ ...base, maxAge: AUTH_LIMITS.tokenTtlMs }), clear: Object.freeze({ ...base }) };
}
```

2. Replace the `PlatformAuth` interface with:

```ts
export interface PlatformAuth {
  readonly service: AuthService;
  readonly publicRouter: Router;
  readonly gate: RequestHandler;
  readonly accountRouter: Router;
  /**
   * An ACCOUNT form of this browser, posted from one of our pages: same Origin, same-origin Sec-Fetch-Site, and the
   * token bound to hvwa_sid AND the sign-in (hvwa_auth). Every state-changing platform form after the gate uses it.
   */
  formOk(req: Request): boolean;
  /** The account-form token for a form another router renders. */
  csrfFor(req: Request): string;
  /** The 403 "request refused" page for a failed formOk. */
  refuse(req: Request, res: Response, back: string): Promise<void>;
}
```

and re-export the guard next to the other re-exports: `export { requireAdmin } from './forms.js';`.

3. Inside `platformAuth()`: replace every `COOKIE` with `cookies.set` and every `CLEAR` with `cookies.clear`, add after `const service = createAuthService(db, opts);`:

```ts
  const cookies = cookieAttributes(opts.secureCookies === true);
```

and let the form guard use the public scheme:

```ts
  const formOk = (req: Request, account: boolean) => originOk(req, opts.publicScheme ?? req.protocol) && fetchSiteOk(req) &&
    service.checkCsrf(req.sessionId, field(req, '_csrf'), account ? authTokenOf(req) : undefined);
```

4. In the `gate`, set the locals with the id and role:

```ts
    if (session) {
      res.locals.platformAuth = {
        signedIn: true, userId: session.userId, user: session.username, role: session.role,
        defaultPassword: session.defaultPassword,
        csrf: service.csrfToken(req.sessionId, authTokenOf(req)), // the layout's logout form: an account form
      };
      next();
      return;
    }
```

5. `renderPassword` passes the minimum:

```ts
    return sendPage(res, view('password'), {
      pageTitle: res.locals.t('auth.pw_heading'), csrf: service.csrfToken(req.sessionId, authTokenOf(req)),
      user: res.locals.platformAuth?.user ?? '', error: data.error, changed: data.changed === true, notice: data.notice,
      pwMin: service.passwordMinLength,
    });
```

6. Replace the final `return Object.freeze({ service, publicRouter, gate, accountRouter });` with:

```ts
  return Object.freeze({
    service, publicRouter, gate, accountRouter,
    formOk: (req: Request) => formOk(req, true),
    csrfFor: (req: Request) => service.csrfToken(req.sessionId, authTokenOf(req)),
    refuse,
  });
```

In `src/auth/views/password.ejs`: both `minlength="8"` become `minlength="<%= pwMin %>"`; `<%= t('auth.pw_new_help') %>` becomes `<%= t('auth.pw_new_help').replace('{n}', pwMin) %>`; and every `t('auth.pw_err_' + error)` becomes `t('auth.pw_err_' + error).replace('{n}', pwMin)` (three places).

In `src/core/i18n.ts`, the two strings that named "8" take `{n}`:

```ts
  'auth.pw_new_help': {
    id: 'Minimal {n} karakter, berbeda dari kata sandi saat ini dan dari kata sandi bawaan. Lebih panjang lebih kuat: frasa sandi empat kata atau lebih paling baik.',
    en: 'At least {n} characters, different from the current one and from the default. Longer is stronger: a passphrase of four or more words is best.',
  },
```

```ts
  'auth.pw_err_too_short': { id: 'Kata sandi baru minimal {n} karakter.', en: 'The new password needs at least {n} characters.' },
```

In `src/types/express.d.ts`, `platformAuth` becomes:

```ts
      platformAuth?: {
        readonly signedIn: boolean;
        readonly userId?: number;
        readonly user?: string;
        readonly role?: 'player' | 'admin';
        readonly defaultPassword?: boolean;
        readonly csrf?: string;
      };
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/auth-forms.spec.ts tests/auth.spec.ts tests/auth-next.spec.ts tests/portal-frame.spec.ts`
Expected: PASS (the existing auth spec still sees the same Set-Cookie line and the same pages).

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/auth/forms.ts src/auth/index.ts src/auth/views/password.ejs src/types/express.d.ts src/core/i18n.ts tests/helpers.ts tests/auth-forms.spec.ts
git commit -m "feat(auth): shared form guards, requireAdmin, Secure cookie option, id and role in the locals"
```

---

### Task 5: Registration (`/register`, event code, open/closed switch) and per-IP limits on the client IP

**Files:**
- Create: `src/auth/rate-limit.ts`, `src/auth/client-ip.ts`, `src/auth/settings.ts`, `src/auth/register.ts`, `src/auth/views/register.ejs`
- Modify: `src/auth/index.ts`, `src/auth/views/login.ejs`, `src/core/i18n.ts`, `src/public/app.css`
- Test: `tests/auth-register.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-register.spec.ts`:

```ts
// Open self-registration (src/auth/register.ts, spec range §4): the rules, the per-IP limit (5 accounts per hour),
// the optional event code, the admin's open/closed switch, and the same CSRF / Origin / Sec-Fetch-Site guards as the
// login form. Mounted only when the `registration` option is given (portal mode).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { windowLimiter } from '../src/auth/rate-limit.js';
import { clientIp } from '../src/auth/client-ip.js';
import { adminSettings } from '../src/auth/settings.js';
import { authHarness, csrfOf, FAST_HASHER, HARNESS_ADMIN_PASSWORD } from './helpers.js';

const PW = 'Player-Pass-1';
const T0 = Date.UTC(2026, 10, 20, 10);
type Agent = ReturnType<typeof request.agent>;

function regApp(registration: { code?: string; perIp?: number } = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const h = authHarness({ passwordMinLength: 10, now: clock.now, registration: { now: clock.now, ...registration } });
  return { ...h, clock, settings: adminSettings(h.db, registration.code) };
}
async function register(agent: Agent, fields: Record<string, string>) {
  const page = await agent.get('/register');
  return agent.post('/register').type('form').send({ _csrf: csrfOf(page.text), ...fields });
}

describe('GET /register', () => {
  it('is open before the gate, never cached or framed, with username/password/confirm and a CSRF token', async () => {
    const { app } = regApp();
    const res = await request(app).get('/register');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    for (const name of ['username', 'password', 'confirm', '_csrf']) expect(res.text).toContain(`name="${name}"`);
    expect(res.text).not.toContain('name="code"');
    expect(res.text).toContain('minlength="10"');
  });

  it('asks for the event code only when one is set; a signed-in browser is sent home', async () => {
    const { app } = regApp({ code: 'EVENT-2026' });
    expect((await request(app).get('/register')).text).toContain('name="code"');
    const agent = request.agent(app);
    const page = await agent.get('/login');
    await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password: HARNESS_ADMIN_PASSWORD });
    const again = await agent.get('/register');
    expect(again.status).toBe(303);
    expect(again.headers.location).toBe('/');
  });

  it('is not mounted without the registration option (standalone)', async () => {
    const { app } = authHarnessWithoutRegistration();
    expect((await request(app).get('/register')).status).toBe(303); // behind the gate like any unknown page
  });
});

describe('POST /register', () => {
  it('creates a player, sends the browser to /login?registered=1, which says so; the account signs in', async () => {
    const { app, auth } = regApp();
    const agent = request.agent(app);
    const res = await register(agent, { username: 'Alice', password: PW, confirm: PW });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/login?registered=1');
    expect(auth.service.listUsers().map((u) => [u.username, u.role])).toEqual([['admin', 'admin'], ['alice', 'player']]);
    const login = await agent.get('/login?registered=1');
    expect(login.text).toContain('data-testid="registered"');
    const signed = await agent.post('/login').type('form').send({ _csrf: csrfOf(login.text), username: 'alice', password: PW });
    expect(signed.status).toBe(303);
  });

  it('needs the login-form token, a same-origin post and no foreign Origin (403, nothing created)', async () => {
    const { app, auth } = regApp();
    const agent = request.agent(app);
    const token = csrfOf((await agent.get('/register')).text);
    const ok = { username: 'bob', password: PW, confirm: PW };
    expect((await agent.post('/register').type('form').send(ok)).status).toBe(403);
    expect((await agent.post('/register').set('Origin', 'http://evil.example').type('form').send({ _csrf: token, ...ok })).status).toBe(403);
    expect((await agent.post('/register').set('Sec-Fetch-Site', 'cross-site').type('form').send({ _csrf: token, ...ok })).status).toBe(403);
    expect(auth.service.listUsers()).toHaveLength(1);
  });

  it.each([
    [{ username: 'ab', password: PW, confirm: PW }, 'username'],
    [{ username: 'admin', password: PW, confirm: PW }, 'taken'],
    [{ username: 'carol', password: 'Short-pw1', confirm: 'Short-pw1' }, 'too_short'],
    [{ username: 'carol', password: PW, confirm: `${PW}!` }, 'mismatch'],
  ])('a rule failure re-renders 400 with data-error, keeps the username (escaped), never a password: %j', async (fields, error) => {
    const { app } = regApp();
    const res = await register(request.agent(app), fields);
    expect(res.status).toBe(400);
    expect(res.text).toContain(`data-error="${error}"`);
    expect(res.text).not.toContain(PW);
  });

  it('escapes the typed username it shows again', async () => {
    const { app } = regApp();
    const res = await register(request.agent(app), { username: '"><script>x</script>', password: PW, confirm: PW });
    expect(res.text).toContain('value="&#34;&gt;&lt;script&gt;x&lt;/script&gt;"');
    expect(res.text).not.toContain('<script>x');
  });

  it('the event code: missing or wrong is 400 "code"; the right one registers; the admin\'s code wins, "" means none', async () => {
    const { app, settings, auth } = regApp({ code: 'EVENT-2026' });
    const agent = request.agent(app);
    expect((await register(agent, { username: 'dave', password: PW, confirm: PW })).text).toContain('data-error="code"');
    expect((await register(agent, { username: 'dave', password: PW, confirm: PW, code: 'WRONG' })).status).toBe(400);
    expect((await register(agent, { username: 'dave', password: PW, confirm: PW, code: ' EVENT-2026 ' })).status).toBe(303);
    settings.setEventCode('ADMIN-CODE');
    expect((await register(agent, { username: 'erin', password: PW, confirm: PW, code: 'EVENT-2026' })).status).toBe(400);
    expect((await register(agent, { username: 'erin', password: PW, confirm: PW, code: 'ADMIN-CODE' })).status).toBe(303);
    settings.setEventCode('');
    expect((await register(agent, { username: 'fay', password: PW, confirm: PW })).status).toBe(303);
    expect(auth.service.listUsers()).toHaveLength(4);
  });

  it('closed by the admin: GET and POST answer 403 "closed", nothing is created, the login page hides the link', async () => {
    const { app, settings, auth } = regApp();
    expect((await request(app).get('/login')).text).toContain('data-testid="register-link"');
    const agent = request.agent(app);
    const token = csrfOf((await agent.get('/register')).text);
    settings.setRegistrationOpen(false);
    const page = await agent.get('/register');
    expect(page.status).toBe(403);
    expect(page.text).toContain('data-testid="registration-closed"');
    const post = await agent.post('/register').type('form').send({ _csrf: token, username: 'gus', password: PW, confirm: PW });
    expect(post.status).toBe(403);
    expect(auth.service.listUsers()).toHaveLength(1);
    expect((await request(app).get('/login')).text).not.toContain('data-testid="register-link"');
  });

  it('5 accounts per IP per hour: the 6th is 429 and creates nothing; rule failures never count; an hour later it is open', async () => {
    const { app, clock, auth } = regApp({ perIp: 5 });
    const agent = request.agent(app);
    expect((await register(agent, { username: 'ab', password: PW, confirm: PW })).status).toBe(400);
    for (let i = 1; i <= 5; i++) expect((await register(agent, { username: `user_${i}`, password: PW, confirm: PW })).status).toBe(303);
    const sixth = await register(agent, { username: 'user_6', password: PW, confirm: PW });
    expect(sixth.status).toBe(429);
    expect(sixth.text).toContain('data-testid="registration-limited"');
    expect(auth.service.listUsers()).toHaveLength(6);
    clock.advance(60 * 60_000);
    expect((await register(agent, { username: 'user_6', password: PW, confirm: PW })).status).toBe(303);
  });
});

describe('windowLimiter', () => {
  it('allows max hits per key per window, keys are independent, and at most maxKeys keys are tracked', () => {
    let t = 0;
    const l = windowLimiter({ max: 2, windowMs: 1000, now: () => t, maxKeys: 2 });
    expect([l.allow('a'), l.allow('a'), l.allow('a')]).toEqual([true, true, false]);
    expect(l.allow('b')).toBe(true);
    t = 1000;
    expect(l.allow('a')).toBe(true);
    expect(l.count('a')).toBe(1);
    l.allow('c');
    expect(l.count('b')).toBe(0); // evicted: the least recently used key goes first
    expect(() => windowLimiter({ max: 0, windowMs: 1 })).toThrow();
  });
});

describe('the client IP (spec §12: CF-Connecting-IP behind the tunnel, else the socket address)', () => {
  it('clientIp takes a valid CF-Connecting-IP, else the socket address', () => {
    const req = (h?: string) => ({ get: (n: string) => (n.toLowerCase() === 'cf-connecting-ip' ? h : undefined), socket: { remoteAddress: '10.0.0.9' } });
    expect(clientIp(req('203.0.113.7') as never)).toBe('203.0.113.7');
    expect(clientIp(req(' 2001:db8::1 ') as never)).toBe('2001:db8::1');
    for (const bad of [undefined, '', 'evil', '203.0.113.7, 10.0.0.1']) expect(clientIp(req(bad) as never)).toBe('10.0.0.9');
  });

  it('the registration limit keys on it: one IP is full, another is not', async () => {
    const { app } = regApp({ perIp: 2 });
    const agent = request.agent(app);
    const from = async (ip: string, username: string) => {
      const page = await agent.get('/register');
      return agent.post('/register').set('CF-Connecting-IP', ip).type('form').send({ _csrf: csrfOf(page.text), username, password: PW, confirm: PW });
    };
    expect((await from('203.0.113.7', 'ip_a1')).status).toBe(303);
    expect((await from('203.0.113.7', 'ip_a2')).status).toBe(303);
    expect((await from('203.0.113.7', 'ip_a3')).status).toBe(429);
    expect((await from('198.51.100.4', 'ip_b1')).status).toBe(303);
  });

  it('signInPerIp: past the budget of failed sign-ins even the right password is refused unchecked (429); another IP is not', async () => {
    let verifies = 0;
    const hasher = { ...FAST_HASHER, verify: async (p: string, stored: string) => { verifies += 1; return FAST_HASHER.verify(p, stored); } };
    const { app } = authHarness({ hasher, signInPerIp: { max: 3, windowMs: 60_000 } });
    const agent = request.agent(app);
    const attempt = async (ip: string, password: string) => {
      const page = await agent.get('/login');
      return agent.post('/login').set('CF-Connecting-IP', ip).type('form').send({ _csrf: csrfOf(page.text), username: 'admin', password });
    };
    for (let i = 0; i < 3; i++) expect((await attempt('203.0.113.7', 'wrong-password')).status).toBe(401);
    const checked = verifies;
    const limited = await attempt('203.0.113.7', HARNESS_ADMIN_PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.text).toContain('Too many failed sign-ins');
    expect(verifies).toBe(checked);
    expect((await attempt('198.51.100.4', HARNESS_ADMIN_PASSWORD)).status).toBe(303);
  });
});

function authHarnessWithoutRegistration() {
  return authHarness({ passwordMinLength: 10 });
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/auth-register.spec.ts`
Expected: FAIL — `src/auth/rate-limit.ts`, `src/auth/client-ip.ts`, `src/auth/settings.ts` and the `registration` / `signInPerIp` options do not exist.

- [ ] **Step 3: Implement**

Create `src/auth/rate-limit.ts`:

```ts
// src/auth/rate-limit.ts — a sliding-window counter per key (registrations per client IP, spec range §4). Bounded:
// at most `maxKeys` keys are tracked; the least recently used one is dropped first.
export interface WindowLimiter {
  /** Record one hit for `key` and return true, or return false (recording nothing) when the window is full. */
  allow(key: string): boolean;
  /** Hits of `key` inside the window now. */
  count(key: string): number;
}

export function windowLimiter(opts: { max: number; windowMs: number; now?: () => number; maxKeys?: number }): WindowLimiter {
  const { max, windowMs } = opts;
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 10_000;
  if (!Number.isInteger(max) || max < 1) throw new Error('windowLimiter: max must be a positive integer');
  if (!(windowMs > 0)) throw new Error('windowLimiter: windowMs must be positive');
  const hits = new Map<string, number[]>();
  const live = (key: string, t: number): number[] => {
    const list = (hits.get(key) ?? []).filter((at) => t - at < windowMs);
    hits.delete(key);
    if (list.length > 0) hits.set(key, list); // re-inserted: the most recently used key is last
    return list;
  };
  return {
    allow(key: string): boolean {
      const t = now();
      const list = live(key, t);
      if (list.length >= max) return false;
      list.push(t);
      hits.delete(key);
      hits.set(key, list);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    count: (key: string) => live(key, now()).length,
  };
}
```

Create `src/auth/client-ip.ts`:

```ts
// src/auth/client-ip.ts — the client's IP for per-IP limits (portal mode, spec range §12 "Client IP"). Behind the
// Cloudflare Tunnel the socket peer is always Traefik and the real client is Cloudflare's CF-Connecting-IP header. It is
// trusted because Traefik publishes no port (only cloudflared reaches it, and instances find nothing listening) and only
// Traefik reaches the portal. Locally the header is absent and the socket address is used. Express `trust proxy` stays off.
import { isIP } from 'node:net';
import type { Request } from 'express';

export const CF_CONNECTING_IP = 'cf-connecting-ip';

export function clientIp(req: Pick<Request, 'get' | 'socket'>): string {
  const cf = req.get(CF_CONNECTING_IP)?.trim();
  if (cf !== undefined && isIP(cf) !== 0) return cf;
  return req.socket.remoteAddress ?? 'unknown';
}
```

Create `src/auth/settings.ts`:

```ts
// src/auth/settings.ts — the admin's switches for the range (portal mode), in range_settings (migration 3):
// registration open or closed, and the event code (overriding HVWA_REGISTRATION_CODE; '' = no code).
import type { DatabaseSync } from 'node:sqlite';

export interface AdminSettings {
  registrationOpen(): boolean;
  setRegistrationOpen(open: boolean): void;
  /** The code a registration needs: the admin's when set ('' = none), else HVWA_REGISTRATION_CODE, else none. */
  eventCode(): string | undefined;
  setEventCode(code: string): void;
}

export function adminSettings(db: DatabaseSync, envCode?: string): AdminSettings {
  const get = db.prepare('SELECT value FROM range_settings WHERE key = ?');
  const put = db.prepare('INSERT INTO range_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const read = (key: string) => (get.get(key) as { value: string } | undefined)?.value;
  return Object.freeze({
    registrationOpen: () => read('registration_open') !== '0',
    setRegistrationOpen: (open: boolean) => { put.run('registration_open', open ? '1' : '0'); },
    eventCode: () => {
      const stored = read('event_code');
      if (stored === undefined) return envCode === undefined || envCode === '' ? undefined : envCode;
      return stored === '' ? undefined : stored;
    },
    setEventCode: (code: string) => { put.run('event_code', code.trim()); },
  });
}
```

Create `src/auth/register.ts`:

```ts
// src/auth/register.ts — open self-registration (portal mode, spec range §4): GET/POST /register. PLATFORM code.
// Order of checks: the login form's guards (Origin, Sec-Fetch-Site, the token bound to hvwa_sid); registration open
// (the admin's switch); the event code when one is set (constant time); the service's username and password rules;
// then at most `perIp` accounts per client IP (clientIp: CF-Connecting-IP, else the socket) per `windowMs`, asked right
// before the hash, so a typo never spends it.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { clientIp } from './client-ip.js';
import { noStore } from './forms.js';
import { windowLimiter } from './rate-limit.js';
import type { AdminSettings } from './settings.js';
import type { AuthService, RegisterError } from './service.js';

export interface RegistrationOptions {
  /** HVWA_REGISTRATION_CODE: the event code while the admin has set none. */
  readonly code?: string;
  /** Accounts per client IP per window. Default 5 (spec §4). */
  readonly perIp?: number;
  /** Default one hour. */
  readonly windowMs?: number;
  /** Clock for the limit; tests inject one. */
  readonly now?: () => number;
}

export const REGISTRATION_DEFAULTS = Object.freeze({ perIp: 5, windowMs: 60 * 60_000 });

export interface RegistrationDeps {
  readonly service: AuthService;
  readonly settings: AdminSettings;
  readonly options: RegistrationOptions;
  /** Absolute path of register.ejs. */
  readonly view: string;
  /** The login form's guard (Origin, Sec-Fetch-Site, the token bound to hvwa_sid). */
  readonly loginFormOk: (req: Request) => boolean;
  readonly refuse: (req: Request, res: Response, back: string) => Promise<void>;
  readonly signedIn: (req: Request) => boolean;
}

type Failure = RegisterError | 'code';
const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const codeOk = (submitted: string, expected: string) => timingSafeEqual(digest(submitted.trim()), digest(expected));

export function registrationRouter(deps: RegistrationDeps): Router {
  const { service, settings, options } = deps;
  const limiter = windowLimiter({
    max: options.perIp ?? REGISTRATION_DEFAULTS.perIp, windowMs: options.windowMs ?? REGISTRATION_DEFAULTS.windowMs, now: options.now,
  });

  const render = (req: Request, res: Response, data: { error?: Failure; username?: string; limited?: boolean } = {}) => {
    noStore(res);
    res.locals.platformAuth ??= { signedIn: false }; // /register is before the gate
    return sendPage(res, deps.view, {
      pageTitle: res.locals.t('auth.register_heading'), csrf: service.csrfToken(req.sessionId),
      needsCode: settings.eventCode() !== undefined, pwMin: service.passwordMinLength,
      closed: !settings.registrationOpen(), limited: data.limited === true,
      error: data.error, username: data.username ?? '',
    });
  };

  const r = Router();
  r.get('/register', async (req, res) => {
    if (deps.signedIn(req)) { noStore(res); res.redirect(303, '/'); return; }
    if (!settings.registrationOpen()) res.status(403);
    await render(req, res);
  });
  r.post('/register', async (req, res) => {
    if (!deps.loginFormOk(req)) { await deps.refuse(req, res, '/register'); return; }
    if (!settings.registrationOpen()) { res.status(403); await render(req, res); return; }
    const username = field(req, 'username');
    const code = settings.eventCode();
    if (code !== undefined && !codeOk(field(req, 'code'), code)) {
      res.status(400);
      await render(req, res, { error: 'code', username });
      return;
    }
    const ip = clientIp(req);
    const result = await service.register(username, field(req, 'password'), field(req, 'confirm'), () => limiter.allow(ip));
    if (result.ok) { noStore(res); res.redirect(303, '/login?registered=1'); return; }
    if (result.error === 'limited') {
      res.status(429).set('Retry-After', String(Math.ceil((options.windowMs ?? REGISTRATION_DEFAULTS.windowMs) / 1000)));
      await render(req, res, { limited: true, username });
      return;
    }
    res.status(result.error === 'busy' ? 503 : 400);
    if (result.error === 'busy') res.set('Retry-After', '1');
    await render(req, res, { error: result.error, username });
  });
  return r;
}
```

Create `src/auth/views/register.ejs`:

```ejs
<%# Open registration (src/auth/register.ts). Each error is shown under the field it is about (data-error is the closed error key); the typed username is kept, a password never is. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<%
  var errUser = error === 'username' || error === 'taken';
  var errPw = error === 'too_short' || error === 'too_long' || error === 'control';
  var errConfirm = error === 'mismatch';
  var errCode = error === 'code';
-%>
<div class="auth-shell">
<section class="card auth-card" aria-labelledby="register-title">
  <span class="auth-mark"><svg class="icon icon-lg" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-user"></use></svg></span>
  <h1 class="page-title" id="register-title"><%= t('auth.register_heading') %></h1>
<% if (closed) { -%>
  <p class="result result-bad" role="alert" data-testid="registration-closed"><%= t('auth.reg_closed') %></p>
<% } else { -%>
  <p class="auth-intro"><%= t('auth.register_intro') %></p>
<% if (limited) { -%>
  <p class="result result-bad" role="alert" data-testid="registration-limited"><%= t('auth.reg_limited') %></p>
<% } -%>
<% if (error === 'busy') { -%>
  <p class="result result-bad" role="alert" data-error="busy"><%= t('auth.reg_err_busy') %></p>
<% } -%>
  <form method="post" action="/register" class="auth-form">
    <input type="hidden" name="_csrf" value="<%= csrf %>">
    <div class="field">
      <label for="reg-username"><%= t('auth.username') %></label>
      <input id="reg-username" type="text" name="username" value="<%= username %>" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="24" required autofocus aria-describedby="reg-username-help<% if (errUser) { %> reg-username-error<% } %>"<% if (errUser) { %> aria-invalid="true"<% } %>>
      <p class="help" id="reg-username-help"><%= t('auth.username_help') %></p>
<% if (errUser) { -%>
      <p class="result result-bad field-error" role="alert" id="reg-username-error" data-error="<%= error %>"><%= t('auth.reg_err_' + error) %></p>
<% } -%>
    </div>
    <div class="field">
      <label for="reg-password"><%= t('auth.password') %></label>
      <input id="reg-password" type="password" name="password" autocomplete="new-password" minlength="<%= pwMin %>" maxlength="1024" required data-strength="reg-strength" aria-describedby="reg-password-help<% if (errPw) { %> reg-password-error<% } %>"<% if (errPw) { %> aria-invalid="true"<% } %>>
      <p class="help" id="reg-password-help"><%= t('auth.reg_pw_help').replace('{n}', pwMin) %></p>
      <p class="strength" id="reg-strength" hidden aria-live="polite" data-label-weak="<%= t('auth.pw_strength_weak') %>" data-label-fair="<%= t('auth.pw_strength_fair') %>" data-label-strong="<%= t('auth.pw_strength_strong') %>"><span><%= t('auth.pw_strength') %>:</span><span class="strength-bar" aria-hidden="true"><span></span><span></span><span></span></span><span data-strength-value></span></p>
<% if (errPw) { -%>
      <p class="result result-bad field-error" role="alert" id="reg-password-error" data-error="<%= error %>"><%= t('auth.reg_err_' + error).replace('{n}', pwMin) %></p>
<% } -%>
    </div>
    <div class="field">
      <label for="reg-confirm"><%= t('auth.pw_confirm_plain') %></label>
      <input id="reg-confirm" type="password" name="confirm" autocomplete="new-password" minlength="<%= pwMin %>" maxlength="1024" required<% if (errConfirm) { %> aria-invalid="true" aria-describedby="reg-confirm-error"<% } %>>
<% if (errConfirm) { -%>
      <p class="result result-bad field-error" role="alert" id="reg-confirm-error" data-error="<%= error %>"><%= t('auth.reg_err_' + error) %></p>
<% } -%>
    </div>
<% if (needsCode) { -%>
    <div class="field">
      <label for="reg-code"><%= t('auth.event_code') %></label>
      <input id="reg-code" type="text" name="code" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="128" required<% if (errCode) { %> aria-invalid="true" aria-describedby="reg-code-error"<% } %>>
<% if (errCode) { -%>
      <p class="result result-bad field-error" role="alert" id="reg-code-error" data-error="code"><%= t('auth.reg_err_code') %></p>
<% } -%>
    </div>
<% } -%>
    <button type="submit" class="btn btn-primary btn-lg btn-block" data-testid="register-submit"><%= t('auth.register_button') %></button>
  </form>
<% } -%>
  <p class="auth-switch"><a href="/login"><%= t('auth.login_link') %></a></p>
</section>
</div>
```

In `src/auth/views/login.ejs`, after the `<p class="auth-intro">...</p>` line add:

```ejs
<% if (registered) { -%>
  <p class="result result-ok" role="status" data-testid="registered"><%= t('auth.registered') %></p>
<% } -%>
```

and after `</form>` add:

```ejs
<% if (registerLink) { -%>
  <p class="auth-switch"><a href="/register" data-testid="register-link"><%= t('auth.register_link') %></a></p>
<% } -%>
```

In `src/auth/index.ts`:

1. Add imports:

```ts
import { clientIp } from './client-ip.js';
import { windowLimiter } from './rate-limit.js';
import { registrationRouter, type RegistrationOptions } from './register.js';
import { adminSettings, type AdminSettings } from './settings.js';
```

and `export type { RegistrationOptions } from './register.js';` and `export type { AdminSettings } from './settings.js';`.

2. `AuthOptions` gains two options, and the defaults portal mode uses are exported:

```ts
  /** Mount GET/POST /register (portal mode). Absent: no registration (standalone). */
  registration?: RegistrationOptions;
  /**
   * Portal mode: at most `max` FAILED sign-ins per client IP (clientIp) per `windowMs`; beyond it a sign-in is refused
   * before any password check (429). In front of, not instead of, the per-account backoff. Absent: off (standalone).
   */
  signInPerIp?: { readonly max: number; readonly windowMs: number };
```

```ts
/** The failed-sign-in budget per client IP in portal mode (createApp). */
export const SIGN_IN_PER_IP_DEFAULTS = Object.freeze({ max: 30, windowMs: 15 * 60_000 });
```

3. `PlatformAuth` gains:

```ts
  /** The admin's switches (registration open, event code). */
  readonly settings: AdminSettings;
```

4. Inside `platformAuth()`, after `const cookies = ...`:

```ts
  const settings = adminSettings(db, opts.registration?.code);
  const registerLink = () => opts.registration !== undefined && settings.registrationOpen();
```

5. `renderLogin` passes the two new view values:

```ts
    return sendPage(res, view('login'), {
      pageTitle: res.locals.t('auth.login_heading'), csrf: service.csrfToken(req.sessionId), next, failed, notice,
      registered: req.query.registered === '1', registerLink: registerLink(),
    });
```

6. `POST /login` spends and checks the per-IP budget (the whole handler becomes):

```ts
  const ipFailures = opts.signInPerIp ? windowLimiter({ max: opts.signInPerIp.max, windowMs: opts.signInPerIp.windowMs, now: opts.now }) : undefined;
  publicRouter.post('/login', async (req, res) => {
    if (!formOk(req, false)) { await refuse(req, res, '/login'); return; }
    const next = safeNext(field(req, 'next'));
    const ip = clientIp(req);
    if (ipFailures && opts.signInPerIp && ipFailures.count(ip) >= opts.signInPerIp.max) {
      res.status(429).set('Retry-After', String(Math.ceil(opts.signInPerIp.windowMs / 1000)));
      await renderLogin(req, res, next, false, res.locals.t('auth.login_limited'));
      return;
    }
    const result = await service.signIn(field(req, 'username'), field(req, 'password'));
    if (!result.ok) {
      if (result.busy) { await renderLogin(req, res, next, false, busy(req, res)); return; }
      ipFailures?.allow(ip); // one failure spent from this IP's budget
      res.status(401);
      await renderLogin(req, res, next, true);
      return;
    }
    service.revoke(req.cookies?.[AUTH_COOKIE]); // a fresh token per sign-in; the old one dies
    noStore(res);
    res.cookie(AUTH_COOKIE, result.token, cookies.set);
    res.redirect(303, next);
  });
```

7. After that `publicRouter.post('/login', ...)` add:

```ts
  if (opts.registration) {
    publicRouter.use(registrationRouter({
      service, settings, options: opts.registration, view: view('register'),
      loginFormOk: (req) => formOk(req, false), refuse,
      signedIn: (req) => service.session(req.cookies?.[AUTH_COOKIE]) !== undefined,
    }));
  }
```

8. The returned object includes `settings`:

```ts
  return Object.freeze({
    service, settings, publicRouter, gate, accountRouter,
    formOk: (req: Request) => formOk(req, true),
    csrfFor: (req: Request) => service.csrfToken(req.sessionId, authTokenOf(req)),
    refuse,
  });
```

In `src/core/i18n.ts`, add after the `'auth.pw_err_default'` entry:

```ts
  // Registration (portal mode, src/auth/register.ts).
  'auth.register_heading': { id: 'Buat akun', en: 'Create an account' },
  'auth.register_intro': {
    id: 'Pilih nama pengguna dan kata sandi. Skor dan lab Anda tersimpan di akun ini.',
    en: 'Choose a username and a password. Your score and your labs belong to this account.',
  },
  'auth.register_button': { id: 'Buat akun', en: 'Create account' },
  'auth.register_link': { id: 'Belum punya akun? Buat akun', en: 'No account yet? Create one' },
  'auth.login_link': { id: 'Sudah punya akun? Masuk', en: 'Already have an account? Log in' },
  'auth.registered': { id: 'Akun dibuat. Silakan masuk.', en: 'Account created. Log in.' },
  'auth.username_help': {
    id: '3 sampai 24 karakter: huruf kecil, angka, dan garis bawah.',
    en: '3 to 24 characters: lowercase letters, digits and underscores.',
  },
  'auth.reg_pw_help': {
    id: 'Minimal {n} karakter. Lebih panjang lebih kuat: frasa sandi empat kata atau lebih paling baik.',
    en: 'At least {n} characters. Longer is stronger: a passphrase of four or more words is best.',
  },
  'auth.pw_confirm_plain': { id: 'Ulangi kata sandi', en: 'Repeat the password' },
  'auth.event_code': { id: 'Kode acara', en: 'Event code' },
  'auth.reg_closed': {
    id: 'Pendaftaran sedang ditutup. Minta akun kepada penyelenggara.',
    en: 'Registration is closed. Ask the organiser for an account.',
  },
  'auth.reg_limited': {
    id: 'Terlalu banyak akun dibuat dari jaringan Anda. Coba lagi nanti.',
    en: 'Too many accounts were created from your network. Try again later.',
  },
  'auth.reg_err_username': {
    id: 'Nama pengguna harus 3 sampai 24 karakter: huruf kecil, angka, atau garis bawah.',
    en: 'The username needs 3 to 24 characters: lowercase letters, digits or underscores.',
  },
  'auth.reg_err_taken': { id: 'Nama pengguna ini sudah dipakai.', en: 'This username is taken.' },
  'auth.reg_err_too_short': { id: 'Kata sandi minimal {n} karakter.', en: 'The password needs at least {n} characters.' },
  'auth.reg_err_too_long': { id: 'Kata sandi maksimal 1024 karakter.', en: 'The password can have at most 1024 characters.' },
  'auth.reg_err_control': { id: 'Kata sandi tidak boleh berisi karakter kontrol.', en: 'The password cannot contain control characters.' },
  'auth.reg_err_mismatch': { id: 'Kedua kata sandi tidak sama.', en: 'The two passwords do not match.' },
  'auth.reg_err_code': { id: 'Kode acara salah.', en: 'The event code is wrong.' },
  'auth.login_limited': {
    id: 'Terlalu banyak percobaan masuk yang gagal dari jaringan Anda. Coba lagi nanti.',
    en: 'Too many failed sign-ins from your network. Try again later.',
  },
  'auth.reg_err_busy': {
    id: 'Server sedang sibuk. Coba lagi sebentar lagi.',
    en: 'The server is busy. Try again in a moment.',
  },
```

In `src/public/app.css`, after the `.auth-form .btn { ... }` line add:

```css
.auth-switch { margin: var(--sp-4) 0 0; text-align: center; font-size: var(--fs-sm); }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/auth-register.spec.ts tests/auth.spec.ts tests/auth-forms.spec.ts tests/ui-contrast.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/auth/rate-limit.ts src/auth/settings.ts src/auth/register.ts src/auth/views/register.ejs src/auth/views/login.ejs src/auth/index.ts src/core/i18n.ts src/public/app.css tests/auth-register.spec.ts
git commit -m "feat(auth): open registration with per-IP limit, event code and the admin's open/closed switch"
```

---

### Task 6: The lab registry schema and `labs/registry.json`

**Files:**
- Create: `src/lab-registry.ts`, `labs/registry.json`, `tests/support/range.ts`
- Test: `tests/lab-registry.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/support/range.ts`:

```ts
// tests/support/range.ts — the range test kit: lab registry entries (and, from the portal-mode tasks on, a portal-mode
// app on a fake clock with accounts and signed-in browsers).
import { parseRegistry, type LabRegistry } from '../../src/lab-registry.js';

/** One registry entry as labs/registry.json holds it: a valid default, overridden per test. */
export function labEntry(id: string, slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, slug,
    title: { en: `${slug} title`, id: `judul ${slug}` },
    app: `App ${slug}`,
    category: 'SQL injection',
    difficulty: 'easy',
    levels: ['acolyte', 'templar', 'inquisitor', 'divine'],
    port: 8080,
    health: '/healthz',
    flag: { placement: 'file:/tmp/hvwa/flag.txt' },
    needsBot: false,
    themeId: `theme-${slug}`,
    scenario: { en: `Scenario of ${slug}`, id: `Skenario ${slug}` },
    briefing: { en: `Briefing of ${slug}`, id: `Briefing ${slug}` },
    hints: [{ id: 1, cost: 10, text: { en: `Hint one of ${slug}`, id: `Petunjuk satu ${slug}` } }],
    version: '1.0.0',
    image: `sigmajo/hvwa:lab-${slug}-1.0.0@sha256:${'a'.repeat(64)}`,
    ...over,
  };
}

/** Two labs: r01 (Easy, all four levels, one hint) and r02 (Medium, Acolyte and Divine, a local image id). */
export function testRegistry(): LabRegistry {
  return parseRegistry({
    schema: 1,
    labs: [
      labEntry('r01', 'clinic'),
      labEntry('r02', 'courier', {
        category: 'Broken access control', difficulty: 'medium', levels: ['acolyte', 'divine'],
        image: `sha256:${'b'.repeat(64)}`, hints: [],
      }),
    ],
  });
}
```

Create `tests/lab-registry.spec.ts`:

```ts
// The lab registry (src/lab-registry.ts, spec range §8.4/§12): one schema for lab.json and labs/registry.json. It is the
// warden's image allowlist (digest-pinned images only) and the portal's catalog, so anything outside it is refused.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIFFICULTY_POINTS, labManifestSchema, labPoints, loadRegistry, parseRegistry } from '../src/lab-registry.js';
import { labEntry } from './support/range.js';

const reg = (...labs: Record<string, unknown>[]) => ({ schema: 1, labs });

describe('parseRegistry', () => {
  it('parses an entry and fills the defaults: no lower limits, one 64 MiB /tmp tmpfs, no hints', () => {
    const r = parseRegistry(reg(labEntry('r01', 'clinic', { hints: undefined })));
    const lab = r.get('r01');
    expect(lab).toMatchObject({ id: 'r01', slug: 'clinic', resources: {}, tmpfs: [{ path: '/tmp', sizeMiB: 64 }], hints: [] });
    expect(r.labs).toHaveLength(1);
    expect(r.get('r99')).toBeUndefined();
    expect(Object.isFrozen(r.labs)).toBe(true);
  });

  it('accepts only digest-pinned images: repo[:tag]@sha256:<64 hex> or a local sha256:<64 hex> image id', () => {
    const digest = 'c'.repeat(64);
    for (const image of [`sigmajo/hvwa:lab-x-1.0.0@sha256:${digest}`, `hvwa-lab/r01@sha256:${digest}`, `sha256:${digest}`]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { image }))), image).not.toThrow();
    }
    for (const image of ['sigmajo/hvwa:lab-x-1.0.0', 'sigmajo/hvwa:latest', `sha256:${'C'.repeat(64)}`, `sha256:${digest.slice(1)}`,
      `docker.io/../x@sha256:${digest}`, '']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { image }))), image).toThrow(/image/);
    }
  });

  it('refuses keys it does not know: nothing in a manifest can widen the container (privileged, mounts, ports)', () => {
    for (const extra of [{ privileged: true }, { hostConfig: {} }, { mounts: ['/:/host'] }, { ports: ['80:80'] }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', extra)))).toThrow(/Unrecognized key/);
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources: { memoryMiB: 128, privileged: true } })))).toThrow();
  });

  it('a manifest may only lower the limits: memory <= 256 MiB, pids <= 128, cpus <= 0.5, tmpfs <= 64 MiB in total', () => {
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources: { memoryMiB: 128, pids: 64, cpus: 0.25 } })))).not.toThrow();
    for (const resources of [{ memoryMiB: 512 }, { pids: 256 }, { cpus: 1 }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { resources }))), JSON.stringify(resources)).toThrow();
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { tmpfs: [{ path: '/tmp', sizeMiB: 40 }, { path: '/var/run/app', sizeMiB: 30 }] })))).toThrow(/64 MiB/);
    for (const path of ['tmp', '/tmp/../etc', '/tmp//x', '/tmp x']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { tmpfs: [{ path, sizeMiB: 8 }] }))), path).toThrow();
    }
  });

  it('checks ids, levels, port, health, flag placement; refuses duplicate ids and slugs', () => {
    for (const over of [{ id: 'R01' }, { id: 'r1' }, { levels: ['divine'] }, { levels: ['acolyte', 'acolyte'] }, { port: 80 },
      { health: 'healthz' }, { flag: { placement: 'somewhere' } }, { difficulty: 'insane' }, { version: '1.0' }]) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', over))), JSON.stringify(over)).toThrow();
    }
    for (const placement of ['file:/tmp/hvwa/flag.txt', 'db:patients.notes', 'env-only', 'custom']) {
      expect(() => parseRegistry(reg(labEntry('r01', 'clinic', { flag: { placement } }))), placement).not.toThrow();
    }
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic'), labEntry('r01', 'other')))).toThrow(/duplicate id/);
    expect(() => parseRegistry(reg(labEntry('r01', 'clinic'), labEntry('r02', 'clinic')))).toThrow(/duplicate slug/);
  });

  it('lab.json is the same schema without version and image', () => {
    const { version, image, ...manifest } = labEntry('r03', 'bank');
    expect(version).toBe('1.0.0');
    expect(image).toMatch(/@sha256:/);
    expect(labManifestSchema.safeParse(manifest).success).toBe(true);
    expect(labManifestSchema.safeParse({ ...manifest, image }).success).toBe(false);
  });
});

describe('labs/registry.json', () => {
  it('is valid (empty until Plan B adds the pilot lab)', () => {
    const path = join(process.cwd(), 'labs', 'registry.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schema: 1, labs: [] });
    expect(loadRegistry(path).labs).toEqual([]);
  });

  it('loadRegistry names the file in its errors', () => {
    expect(() => loadRegistry(join(process.cwd(), 'labs', 'no-such-registry.json'))).toThrow(/no-such-registry\.json/);
  });
});

describe('labPoints', () => {
  it('base points by rating (100/200/300/400) times the level multiplier; Divine scores 0', () => {
    expect(DIFFICULTY_POINTS).toEqual({ easy: 100, medium: 200, hard: 300, expert: 400 });
    expect(['acolyte', 'templar', 'inquisitor', 'divine'].map((l) => labPoints({ difficulty: 'medium' }, l as 'acolyte')))
      .toEqual([200, 300, 400, 0]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/lab-registry.spec.ts`
Expected: FAIL — `src/lab-registry.ts` and `labs/registry.json` do not exist.

- [ ] **Step 3: Implement**

Create `labs/registry.json`:

```json
{ "schema": 1, "labs": [] }
```

Create `src/lab-registry.ts`:

```ts
// src/lab-registry.ts — the range's lab registry (labs/registry.json, spec 2026-11-20 range §8.4 and §12): one entry per
// lab image = the lab's manifest (lab.json) + its version + its image pinned by digest. Data only (zod). The portal
// reads it for the catalog and the scoring; the warden for the image allowlist, the container template and the Traefik
// labels. Nothing else decides which image a range container runs, and no key here can widen a container.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FLAG_LEVELS, LEVELS, pointsForLevel, type Level } from './core/levels.js';

/** r00..r99 (lower case: Docker repository names, hvwa-lab/<id>:<version>). r00 is the fixture lab. */
export const LAB_ID_RE = /^r\d{2}$/;
export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard', 'expert'] as const);
export type Difficulty = (typeof DIFFICULTIES)[number];
/** Base points per rating (spec §8.2); a level scales them like every other challenge (core/levels.ts). */
export const DIFFICULTY_POINTS: Readonly<Record<Difficulty, number>> = Object.freeze({ easy: 100, medium: 200, hard: 300, expert: 400 });
/**
 * An image the warden may run: `sha256:<64 hex>` (a local image id, for a lab built on this host) or
 * `<repo>[:<tag>]@sha256:<64 hex>` (a pulled image, by its manifest digest). A tag alone is never enough.
 */
export const IMAGE_REF_RE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@)?sha256:[a-f0-9]{64}$/;
/** Where the lab's start hook plants HVWA_FLAG (spec §6, §8.4). */
export const FLAG_PLACEMENT_RE = /^(?:file:\/[A-Za-z0-9_./-]{1,200}|db:[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}|env-only|custom)$/;
/** Spec §7's defaults, which are also the ceilings: a manifest may only lower them. */
export const LAB_LIMITS = Object.freeze({ memoryMiB: 256, pids: 128, cpus: 0.5, tmpfsMiB: 64 });

const text = z.object({ en: z.string().trim().min(1).max(600), id: z.string().trim().min(1).max(600) }).strict();
const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const tmpfsPath = z.string().regex(/^\/[A-Za-z0-9_./-]{1,100}$/)
  .refine((p) => !p.split('/').includes('..') && !p.includes('//'), 'must be a plain absolute path');

export const labManifestSchema = z.object({
  id: z.string().regex(LAB_ID_RE, 'must be r00..r99'),
  slug: z.string().max(40).regex(kebab),
  title: text,
  app: z.string().trim().min(1).max(60),
  category: z.string().trim().min(1).max(60),
  difficulty: z.enum(DIFFICULTIES),
  levels: z.array(z.enum(LEVELS)).min(1).max(4)
    .refine((ls) => new Set(ls).size === ls.length, 'levels must be unique')
    .refine((ls) => ls.some((l) => FLAG_LEVELS.includes(l)), 'needs at least one exploitable level'),
  port: z.number().int().min(1024).max(65535),
  health: z.string().regex(/^\/[\x21-\x7e]{0,199}$/, 'must be a path such as /healthz'),
  flag: z.object({ placement: z.string().regex(FLAG_PLACEMENT_RE) }).strict(),
  resources: z.object({
    memoryMiB: z.number().int().min(32).max(LAB_LIMITS.memoryMiB),
    pids: z.number().int().min(16).max(LAB_LIMITS.pids),
    cpus: z.number().min(0.1).max(LAB_LIMITS.cpus),
  }).partial().strict().default({}),
  tmpfs: z.array(z.object({ path: tmpfsPath, sizeMiB: z.number().int().min(1).max(LAB_LIMITS.tmpfsMiB) }).strict())
    .min(1).max(8)
    .default([{ path: '/tmp', sizeMiB: LAB_LIMITS.tmpfsMiB }])
    .refine((ts) => ts.reduce((n, t) => n + t.sizeMiB, 0) <= LAB_LIMITS.tmpfsMiB, `tmpfs sizes must total at most ${LAB_LIMITS.tmpfsMiB} MiB`)
    .refine((ts) => new Set(ts.map((t) => t.path)).size === ts.length, 'tmpfs paths must be unique'),
  needsBot: z.boolean(),
  themeId: z.string().max(40).regex(kebab),
  scenario: text,
  briefing: text,
  hints: z.array(z.object({
    id: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    cost: z.number().int().min(0).max(1000),
    text,
  }).strict()).max(3).default([])
    .refine((hs) => new Set(hs.map((h) => h.id)).size === hs.length, 'hint ids must be unique'),
}).strict();

export const registryEntrySchema = labManifestSchema.extend({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'must be x.y.z'),
  image: z.string().regex(IMAGE_REF_RE, 'image must be pinned by digest (sha256:...)'),
}).strict();

const registrySchema = z.object({ schema: z.literal(1), labs: z.array(registryEntrySchema).max(100) }).strict()
  .superRefine((r, ctx) => {
    for (const key of ['id', 'slug'] as const) {
      const seen = new Set<string>();
      r.labs.forEach((lab, i) => {
        if (seen.has(lab[key])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['labs', i, key], message: `duplicate ${key} ${lab[key]}` });
        seen.add(lab[key]);
      });
    }
  });

export type LabManifest = z.output<typeof labManifestSchema>;
export type LabEntry = z.output<typeof registryEntrySchema>;
export interface LabRegistry {
  readonly labs: readonly LabEntry[];
  get(id: string): LabEntry | undefined;
}

/** Validate a parsed registry; throws one readable line per problem. */
export function parseRegistry(raw: unknown): LabRegistry {
  const r = registrySchema.safeParse(raw);
  if (!r.success) {
    throw new Error(`lab registry: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const labs = Object.freeze(r.data.labs.map((lab) => Object.freeze(lab)));
  const byId = new Map(labs.map((lab) => [lab.id, lab]));
  return Object.freeze({ labs, get: (id: string) => byId.get(id) });
}

/** Read and validate a registry file (the portal and the warden, at start-up). */
export function loadRegistry(path: string): LabRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`lab registry ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseRegistry(raw);
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Points a solve of `lab` at `level` is worth (Divine: 0). */
export function labPoints(lab: Pick<LabEntry, 'difficulty'>, level: Level): number {
  return pointsForLevel(DIFFICULTY_POINTS[lab.difficulty], level);
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/lab-registry.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/lab-registry.ts labs/registry.json tests/support/range.ts tests/lab-registry.spec.ts
git commit -m "feat(range): lab manifest and registry schema (digest-pinned images, limits only lowered)"
```

---

### Task 7: Range progress, scoring and the leaderboard, keyed by user id (migration 4)

**Files:**
- Create: `src/db/range.sql`, `src/range/progress.ts`
- Modify: `src/db/index.ts` (migration step 4), `tests/db.spec.ts`, `tests/smoke.spec.ts`
- Test: `tests/range-progress.spec.ts`

- [ ] **Step 1: Write the failing test**

In `tests/db.spec.ts`, the table list of the first case becomes (and add the column check below it):

```ts
    expect(tables(db)).toEqual(['auth_tokens', 'events', 'hint_unlocks', 'range_hint_unlocks', 'range_instances',
      'range_settings', 'range_solves', 'solves', 'users']);
    expect(columns(db, 'range_instances')).toEqual(['id', 'user_id', 'lab_id', 'level', 'state', 'reason', 'flag_hash',
      'created_at', 'started_at', 'ready_at', 'expires_at', 'last_seen_at', 'ended_at']);
```

In `tests/smoke.spec.ts` the table list becomes the same nine names:

```ts
    expect(names.map((r) => r.name)).toEqual(['auth_tokens', 'events', 'hint_unlocks', 'range_hint_unlocks', 'range_instances',
      'range_settings', 'range_solves', 'solves', 'users']);
```

Create `tests/range-progress.spec.ts`:

```ts
// Range scoring keyed by users.id (src/range/progress.ts, spec range §4): best level per lab, paid hints with the cost
// captured at unlock time, a score floored at 0, and a leaderboard ranked by score, then by the earlier last solve.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createAuthService } from '../src/auth/service.js';
import {
  bestRangeSolve, leaderboard, rangeHintCost, rangeScore, rangeSolvesOf, rangeUnlockedTiers, recordRangeSolve, unlockRangeHint,
} from '../src/range/progress.js';
import { FAST_HASHER } from './helpers.js';
import { testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
async function setup(...names: string[]) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  const service = createAuthService(db, { hasher: FAST_HASHER, initialPassword: 'Admin-Pass-1234', passwordMinLength: 10 });
  const ids: number[] = [];
  for (const n of names) {
    const r = await service.register(n, 'Player-Pass-1', 'Player-Pass-1');
    if (!r.ok) throw new Error(r.error);
    ids.push(r.userId);
  }
  return { db, service, ids };
}
const clinic = testRegistry().get('r01')!;

describe('recordRangeSolve', () => {
  it('keeps the best level per (user, lab): a higher one replaces it, a lower one does not', async () => {
    const { db, ids: [alice] } = await setup('alice');
    expect(recordRangeSolve(db, alice, 'r01', 'templar', 150, 10)).toEqual({ status: 'new_best', best: { level: 'templar', points: 150 }, gained: 150 });
    expect(recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 20)).toEqual({ status: 'same_or_lower', best: { level: 'templar', points: 150 }, gained: 0 });
    expect(recordRangeSolve(db, alice, 'r01', 'inquisitor', 200, 30)).toEqual({ status: 'new_best', best: { level: 'inquisitor', points: 200 }, gained: 50 });
    expect(bestRangeSolve(db, alice, 'r01')).toEqual({ level: 'inquisitor', points: 200 });
    expect([...rangeSolvesOf(db, alice)]).toEqual([['r01', { level: 'inquisitor', points: 200 }]]);
  });

  it('is per user: another user\'s solve is not mine', async () => {
    const { db, ids: [alice, bob] } = await setup('alice', 'bob');
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 10);
    expect(rangeSolvesOf(db, bob).size).toBe(0);
    expect(rangeScore(db, bob)).toBe(0);
  });
});

describe('hints', () => {
  it('unlocking costs the hint\'s cost once; unknown tiers are refused; the score is floored at 0', async () => {
    const { db, ids: [alice] } = await setup('alice');
    expect(unlockRangeHint(db, alice, clinic, 2, 5)).toEqual({ ok: false, error: 'unknown_tier' });
    expect(unlockRangeHint(db, alice, clinic, 1, 5)).toMatchObject({ ok: true, hint: { id: 1, cost: 10 } });
    expect(unlockRangeHint(db, alice, clinic, 1, 6)).toMatchObject({ ok: true });
    expect(rangeUnlockedTiers(db, alice, 'r01')).toEqual([1]);
    expect(rangeHintCost(db, alice)).toBe(10);
    expect(rangeScore(db, alice)).toBe(0);
    recordRangeSolve(db, alice, 'r01', 'acolyte', 100, 10);
    expect(rangeScore(db, alice)).toBe(90);
  });
});

describe('leaderboard', () => {
  it('ranks by score, then by the earlier last solve, then by name; only users with a solve; disabled users are left out', async () => {
    const { db, service, ids: [alice, bob, carol, dave] } = await setup('alice', 'bob', 'carol', 'dave');
    recordRangeSolve(db, alice, 'r01', 'templar', 150, 300);
    recordRangeSolve(db, bob, 'r01', 'templar', 150, 200);   // same score, earlier: ahead of alice
    recordRangeSolve(db, carol, 'r01', 'inquisitor', 200, 900);
    recordRangeSolve(db, carol, 'r02', 'acolyte', 200, 950);
    recordRangeSolve(db, dave, 'r02', 'acolyte', 200, 100);
    unlockRangeHint(db, dave, clinic, 1, 101);               // 200 - 10 = 190
    expect(leaderboard(db)).toEqual([
      { rank: 1, userId: carol, username: 'carol', score: 400, solved: 2, lastSolveAt: 950 },
      { rank: 2, userId: dave, username: 'dave', score: 190, solved: 1, lastSolveAt: 100 },
      { rank: 3, userId: bob, username: 'bob', score: 150, solved: 1, lastSolveAt: 200 },
      { rank: 4, userId: alice, username: 'alice', score: 150, solved: 1, lastSolveAt: 300 },
    ]);
    service.setDisabled(1, carol, true);
    expect(leaderboard(db).map((r) => r.username)).toEqual(['dave', 'bob', 'alice']);
    expect(leaderboard(db, 2).map((r) => r.rank)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-progress.spec.ts tests/db.spec.ts tests/smoke.spec.ts`
Expected: FAIL — no range tables, no `src/range/progress.ts`.

- [ ] **Step 3: Implement**

Create `src/db/range.sql`:

```sql
-- src/db/range.sql — PLATFORM schema, migration step 4 (see MIGRATIONS in index.ts): the range (portal mode, src/range,
-- spec 2026-11-20 range §4-§6). Frozen once released. Progress is keyed by users.id, never by hvwa_sid; an instance
-- record keeps the SHA-256 of its flag, never the flag.

CREATE TABLE range_solves (
  user_id   INTEGER NOT NULL,
  lab_id    TEXT    NOT NULL,
  level     TEXT    NOT NULL,          -- the best level proved so far
  points    INTEGER NOT NULL,
  solved_at INTEGER NOT NULL,          -- ms: when this best was reached (the leaderboard's tie-break)
  PRIMARY KEY (user_id, lab_id)
);

-- cost is captured at unlock time so scoring never depends on the registry.
CREATE TABLE range_hint_unlocks (
  user_id     INTEGER NOT NULL,
  lab_id      TEXT    NOT NULL,
  tier        INTEGER NOT NULL,
  cost        INTEGER NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, lab_id, tier)
);

CREATE TABLE range_instances (
  id           TEXT    PRIMARY KEY,    -- 128-bit random, base32 lower case (26 chars); also the host i-<id>.<domain>
  user_id      INTEGER NOT NULL,
  lab_id       TEXT    NOT NULL,
  level        TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'stopping', 'stopped', 'failed')),
  reason       TEXT,                   -- why it stopped or failed: a closed set of codes (src/range/lifecycle.ts)
  flag_hash    TEXT,                   -- hex SHA-256 of the instance's flag; NULL at Divine (no flag)
  created_at   INTEGER NOT NULL,       -- ms: queued or launched
  started_at   INTEGER,                -- ms: handed to the warden
  ready_at     INTEGER,                -- ms: its health check passed
  expires_at   INTEGER,                -- ms: hard stop (maximum lifetime, moved by Extend up to the ceiling)
  last_seen_at INTEGER,                -- ms: last request through forward-auth (flushed every 30 s)
  ended_at     INTEGER                 -- ms: stopped or failed
);
-- One active instance per user, enforced by the database too.
CREATE UNIQUE INDEX range_instances_one_active ON range_instances (user_id) WHERE state IN ('queued', 'starting', 'running');
CREATE INDEX range_instances_state ON range_instances (state, created_at);
CREATE INDEX range_instances_flag ON range_instances (user_id, lab_id, flag_hash);
```

In `src/db/index.ts`, append step 4:

```ts
  // 4: the range (portal mode): solves and hint unlocks keyed by users.id, and the instance records. src/range.
  (db: DatabaseSync) => db.exec(readFileSync(join(here, 'range.sql'), 'utf8')),
```

Create `src/range/progress.ts`:

```ts
// src/range/progress.ts — range scoring, keyed by users.id (spec range §4): one row per (user, lab) holding the best
// level, hint unlocks with their cost captured at unlock time, a score floored at 0, and the leaderboard.
import type { DatabaseSync } from 'node:sqlite';
import { isLevel, type Level } from '../core/levels.js';
import type { LabEntry } from '../lab-registry.js';

export interface Best { readonly level: Level; readonly points: number }
export type SolveResult =
  | { readonly status: 'new_best'; readonly best: Best; readonly gained: number }
  | { readonly status: 'same_or_lower'; readonly best: Best; readonly gained: 0 };

export function bestRangeSolve(db: DatabaseSync, userId: number, labId: string): Best | undefined {
  const r = db.prepare('SELECT level, points FROM range_solves WHERE user_id = ? AND lab_id = ?').get(userId, labId) as
    { level: string; points: number } | undefined;
  return r && isLevel(r.level) ? { level: r.level, points: Number(r.points) } : undefined;
}

/** Record a proved level: the stored best changes only when this one is worth more. */
export function recordRangeSolve(db: DatabaseSync, userId: number, labId: string, level: Level, points: number, at: number): SolveResult {
  const prev = bestRangeSolve(db, userId, labId);
  db.prepare(`INSERT INTO range_solves (user_id, lab_id, level, points, solved_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user_id, lab_id) DO UPDATE SET level = excluded.level, points = excluded.points, solved_at = excluded.solved_at
    WHERE excluded.points > range_solves.points`).run(userId, labId, level, points, at);
  const best = bestRangeSolve(db, userId, labId) ?? { level, points };
  if (prev === undefined || points > prev.points) return { status: 'new_best', best, gained: points - (prev?.points ?? 0) };
  return { status: 'same_or_lower', best, gained: 0 };
}

/** Every best solve of a user, by lab id. */
export function rangeSolvesOf(db: DatabaseSync, userId: number): Map<string, Best> {
  const rows = db.prepare('SELECT lab_id, level, points FROM range_solves WHERE user_id = ?').all(userId) as
    { lab_id: string; level: string; points: number }[];
  const out = new Map<string, Best>();
  for (const r of rows) if (isLevel(r.level)) out.set(r.lab_id, { level: r.level, points: Number(r.points) });
  return out;
}

export type HintUnlock = { ok: true; hint: LabEntry['hints'][number] } | { ok: false; error: 'unknown_tier' };

/** Unlock a paid hint (idempotent: twice costs once). The cost is stored with the unlock. */
export function unlockRangeHint(db: DatabaseSync, userId: number, lab: LabEntry, tier: number, at: number): HintUnlock {
  const hint = lab.hints.find((h) => h.id === tier);
  if (!hint) return { ok: false, error: 'unknown_tier' };
  db.prepare('INSERT OR IGNORE INTO range_hint_unlocks (user_id, lab_id, tier, cost, unlocked_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, lab.id, hint.id, hint.cost, at);
  return { ok: true, hint };
}

export function rangeUnlockedTiers(db: DatabaseSync, userId: number, labId: string): number[] {
  return (db.prepare('SELECT tier FROM range_hint_unlocks WHERE user_id = ? AND lab_id = ? ORDER BY tier').all(userId, labId) as
    { tier: number }[]).map((r) => Number(r.tier));
}

export function rangeHintCost(db: DatabaseSync, userId: number): number {
  return Number((db.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM range_hint_unlocks WHERE user_id = ?').get(userId) as { c: number }).c);
}

/** Sum of best-level points minus hint costs, floored at 0. */
export function rangeScore(db: DatabaseSync, userId: number): number {
  const pts = Number((db.prepare('SELECT COALESCE(SUM(points), 0) AS p FROM range_solves WHERE user_id = ?').get(userId) as { p: number }).p);
  return Math.max(0, pts - rangeHintCost(db, userId));
}

export interface LeaderRow {
  readonly rank: number;
  readonly userId: number;
  readonly username: string;
  readonly score: number;
  readonly solved: number;
  readonly lastSolveAt: number;
}

/** Spec §10: top players by score, then by the time of their last solve (earlier first); disabled accounts left out. */
export function leaderboard(db: DatabaseSync, limit = 100): LeaderRow[] {
  const rows = db.prepare(`
    WITH s AS (SELECT user_id, SUM(points) AS pts, COUNT(*) AS solved, MAX(solved_at) AS last_at FROM range_solves GROUP BY user_id),
         h AS (SELECT user_id, SUM(cost) AS cost FROM range_hint_unlocks GROUP BY user_id)
    SELECT u.id AS id, u.username AS username, MAX(0, s.pts - COALESCE(h.cost, 0)) AS score, s.solved AS solved, s.last_at AS last_at
    FROM users u JOIN s ON s.user_id = u.id LEFT JOIN h ON h.user_id = u.id
    WHERE u.disabled = 0
    ORDER BY score DESC, last_at ASC, username ASC
    LIMIT ?`).all(limit) as { id: number; username: string; score: number; solved: number; last_at: number }[];
  return rows.map((r, i) => ({
    rank: i + 1, userId: Number(r.id), username: r.username, score: Number(r.score), solved: Number(r.solved), lastSolveAt: Number(r.last_at),
  }));
}
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-progress.spec.ts tests/db.spec.ts tests/smoke.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/db/range.sql src/db/index.ts src/range/progress.ts tests/range-progress.spec.ts tests/db.spec.ts tests/smoke.spec.ts
git commit -m "feat(range): progress, hints, score and leaderboard keyed by user id (migration 4)"
```

---

### Task 8: Engine hooks: a host predicate in the host guard, htmx fragments, reserved `portalNav` / `myLab`

**Files:**
- Modify: `src/core/host-guard.ts`, `src/core/render.ts`, `src/types/express.d.ts`
- Modify tests: `tests/host-guard.spec.ts`, `tests/render.spec.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/host-guard.spec.ts` (add `import express from 'express';` and `import { hostGuard } from '../src/core/host-guard.js';` to the imports; `hostGuard` joins the existing import line):

```ts
describe('hostGuard with a host predicate (portal mode: i-<instance>.<domain>)', () => {
  const app = express();
  app.use(hostGuard(['range.test'], (h) => /^i-[a-z2-7]{26}\.range\.test$/.test(h)));
  app.use((_req, res) => { res.send('in'); });
  const lab = `i-${'a'.repeat(26)}.range.test`;

  it('passes the exact names and whatever the predicate accepts, in Host and in an absolute-form target', async () => {
    expect((await request(app).get('/').set('Host', 'range.test')).text).toBe('in');
    expect((await request(app).get('/').set('Host', `${lab}:8443`)).text).toBe('in');
    expect((await request(app).get('/').set('Host', lab.toUpperCase())).text).toBe('in');
  });

  it('still refuses everything else with 421', async () => {
    for (const host of ['evil.example', `x.${lab}`, `${'a'.repeat(26)}.range.test`, `i-${'a'.repeat(25)}.range.test`]) {
      expect((await request(app).get('/').set('Host', host)).status, host).toBe(421);
    }
  });
});
```

In `tests/render.spec.ts`, both reserved-key lists gain `'portalNav', 'myLab'`:

```ts
  it('reserves exactly the keys ejs and the layout depend on', () => {
    expect([...RESERVED_VIEW_KEYS].sort()).toEqual(
      ['__append', '__output', 'body', 'challenge', 'escapeFn', 'include', 'labBar', 'lang', 'level', 'locals',
        'labPath', 'platformAuth', 'rethrow', 'simPanel', 't', 'title', 'uiTheme', 'prefQuery', 'portalNav', 'myLab'].sort());
  });

  it.each(['escapeFn', 'include', 'rethrow', '__append', '__output', 'locals', 'body', 't', 'lang',
    'challenge', 'level', 'labBar', 'labPath', 'simPanel', 'title', 'platformAuth', 'uiTheme', 'prefQuery', 'portalNav', 'myLab'])(
```

and append (with `fragment` added to the existing `../src/core/render.js` import):

```ts
describe('fragment() (htmx partials)', () => {
  it('renders a view WITHOUT the layout, with res.locals, and refuses reserved keys like page()', async () => {
    const ok = appWith(async (_req, res) => { res.send(await fragment(res, fixture, { name: 'part' })); });
    const html = (await request(ok).get('/')).text;
    expect(html).toContain('part');
    expect(html).not.toContain('<!doctype html>');
    const bad = appWith(async (_req, res) => { res.send(await fragment(res, fixture, { name: 'x', myLab: 'y' })); });
    expect((await request(bad).get('/')).body.message).toMatch(/reserved.*"myLab"/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/host-guard.spec.ts tests/render.spec.ts`
Expected: FAIL — `hostGuard` takes no predicate, `fragment` does not exist, the reserved list lacks the two keys.

- [ ] **Step 3: Implement**

In `src/core/host-guard.ts`, replace `hostGuard` with:

```ts
/**
 * Middleware: pass requests whose Host hostname is a loopback name, one of `extraHostnames` (exact,
 * case-insensitive) or accepted by `extraMatch` (portal mode: instance hosts i-<id>.<domain>, which the range's
 * edge router then handles alone), and, for an absolute-form target (`GET http://name/...`, which HTTP says overrides
 * Host), whose target is allowed the same way. Everything else, including a missing Host, gets 421. More than one
 * Host header gets 400: which one counts would be ambiguous. Only the raw Host header counts, never req.hostname or
 * X-Forwarded-Host: with `trust proxy` those come from the client, and labs may use them as attack vectors
 * (host-header poisoning). Mounted first, so rejected requests get no session cookie and reach no route.
 */
export function hostGuard(extraHostnames: readonly string[] = [], extraMatch?: (hostname: string) => boolean): RequestHandler {
  const allowed = new Set([...LOOPBACK_HOSTNAMES, ...extraHostnames.map((h) => h.toLowerCase())]);
  const ok = (h: string) => allowed.has(h) || (extraMatch !== undefined && extraMatch(h));
  return (req, res, next) => {
    if (hostHeaderCount(req.rawHeaders) > 1) {
      res.status(400).type('text/plain').send(DUPLICATE_HOST_BODY);
      return;
    }
    const name = hostnameOf(req.headers.host);
    const target = targetHostname(req.originalUrl);
    const targetOk = target === null || (target !== undefined && ok(target));
    if (name !== undefined && ok(name) && targetOk) {
      next();
      return;
    }
    res.status(421).type('text/plain').send(MISDIRECTED_BODY);
  };
}
```

In `src/core/render.ts`:

1. `RESERVED_VIEW_KEYS` gains the two keys (and its doc comment ends with: "plus portalNav and myLab, the range portal's header, from res.locals"):

```ts
export const RESERVED_VIEW_KEYS: ReadonlySet<string> = new Set([
  'escapeFn', 'include', 'rethrow', '__append', '__output', 'locals', 'body', 't', 'lang',
  'challenge', 'level', 'labBar', 'labPath', 'simPanel', 'title', 'platformAuth', 'uiTheme', 'prefQuery',
  'portalNav', 'myLab',
]);
```

2. After `sendPage`, add:

```ts
/**
 * Render an EJS view (absolute .ejs path) WITHOUT the layout: an htmx fragment (the range's Lab panel, the My Lab chip).
 * Same context and the same reserved-key rule as page().
 */
export async function fragment(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<string> {
  assertViewFile(viewFile);
  assertNoReservedKeys(data);
  return renderFile(viewFile, { ...res.locals, ...data }, serverEjsOptions());
}

/** fragment() sent as text/html. */
export async function sendFragment(res: Response, viewFile: string, data: Record<string, unknown> = {}): Promise<void> {
  res.type('html').send(await fragment(res, viewFile, data));
}
```

In `src/types/express.d.ts`, inside `interface Locals` after `platformAuth`, add:

```ts
      /** Portal mode (src/range/index.ts): the range's navigation instead of Districts / Scoreboard. */
      portalNav?: { readonly admin: boolean };
      /** Portal mode: the My Lab chip in the header (src/range/panel.ts myLabChip). */
      myLab?: { readonly href: string; readonly state: string; readonly text: string };
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run tests/host-guard.spec.ts tests/render.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/core/host-guard.ts src/core/render.ts src/types/express.d.ts tests/host-guard.spec.ts tests/render.spec.ts
git commit -m "feat(core): host predicate in the host guard, htmx fragments, reserved portalNav/myLab"
```

---

### Task 9: Portal mode in `createApp`: no labs, the range catalog, lab pages, hints, leaderboard, range navigation

**Files:**
- Create: `src/range/types.ts`, `src/range/ids.ts`, `src/range/hosts.ts`, `src/range/catalog.ts`, `src/range/index.ts`, `src/range/views/catalog.ejs`, `src/range/views/lab.ejs`, `src/range/views/leaderboard.ejs`
- Modify: `src/app.ts`, `src/core/views/layout.ejs`, `src/core/i18n.ts`, `src/public/app.css`, `tests/support/range.ts`
- Test: `tests/portal-mode.spec.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/support/range.ts` (and add these imports at its top: `import { onTestFinished } from 'vitest';`, `import request from 'supertest';`, `import { createApp, type HvwaApp } from '../../src/app.js';`, `import type { RegistrationOptions } from '../../src/auth/index.js';`, `import { DEFAULT_LIMITS, type RangePortalOptions } from '../../src/range/types.js';`, `import { csrfOf, FAST_HASHER, TEST_SECRET } from '../helpers.js';`):

```ts
export const T0 = Date.UTC(2026, 10, 20, 12);
export const DOMAIN = 'range.test';
export const ADMIN_PASSWORD = 'Admin-Pass-1234';
export const PLAYER_PASSWORD = 'Player-Pass-1';

export interface Clock { readonly now: () => number; readonly advance: (ms: number) => void }
export interface Kit { readonly app: HvwaApp; readonly clock: Clock; readonly registry: LabRegistry }
export type Agent = ReturnType<typeof request.agent>;

/**
 * An app in portal mode on a fake clock: the test registry, the fast hasher, 10-character passwords, a lifted
 * registration limit (tests/auth-register.spec.ts covers the real one). Closed when the test ends.
 */
export function portalApp(o: { range?: Partial<RangePortalOptions>; registration?: RegistrationOptions } = {}): Kit {
  let t = T0;
  const clock: Clock = { now: () => t, advance: (ms) => { t += ms; } };
  const registry = o.range?.registry ?? testRegistry();
  const app = createApp({
    flagSecret: TEST_SECRET, mode: 'portal',
    auth: {
      initialPassword: ADMIN_PASSWORD, hasher: FAST_HASHER, now: clock.now, passwordMinLength: 10,
      registration: { perIp: 1000, now: clock.now, ...o.registration },
    },
    range: { domain: DOMAIN, portalHost: DOMAIN, internalHost: 'portal', registry, limits: DEFAULT_LIMITS, now: clock.now, ...o.range },
  });
  onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed by the test */ } });
  return { app, clock, registry };
}

/** Create a player through the service (no HTTP); returns its id. */
export async function createUser(app: HvwaApp, username: string, password = PLAYER_PASSWORD): Promise<number> {
  const r = await app.locals.auth!.register(username, password, password);
  if (!r.ok) throw new Error(`createUser ${username}: ${r.error}`);
  return r.userId;
}

/** A browser signed in as `username` (303 expected). */
export async function signInAs(app: HvwaApp, username: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfOf(page.text), username, password });
  if (res.status !== 303) throw new Error(`sign-in of ${username} -> ${res.status}`);
  return agent;
}

/** A new player, signed in. */
export async function player(app: HvwaApp, username: string): Promise<{ agent: Agent; userId: number }> {
  const userId = await createUser(app, username);
  return { agent: await signInAs(app, username, PLAYER_PASSWORD), userId };
}

/** The admin, signed in. */
export const signInAdmin = (app: HvwaApp) => signInAs(app, 'admin', ADMIN_PASSWORD);

/** This browser's account-form token (rendered on /account/password). */
export async function accountCsrf(agent: Agent): Promise<string> {
  return csrfOf((await agent.get('/account/password')).text);
}
```

Create `tests/portal-mode.spec.ts`:

```ts
// HVWA_MODE=portal (createApp({ mode: 'portal', range })): the range portal mounts no labs and no /api, puts every page
// behind the login, lists the range labs from the registry (difficulty, levels, points, hints), ranks players, shows the
// range navigation, and fails closed on instance hosts and the internal host until the gate exists.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import '../src/districts/index.js'; // the standalone challenges are registered: portal mode must serve none of them
import { createApp } from '../src/app.js';
import { recordRangeSolve } from '../src/range/progress.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { csrfOf, TEST_SECRET } from './helpers.js';
import { DOMAIN, player, portalApp, signInAdmin, testRegistry, T0 } from './support/range.js';

describe('portal mode: what is mounted', () => {
  it('signed out: every page goes to /login; /login, /register, /healthz and /static are open', async () => {
    const { app } = portalApp();
    for (const path of ['/', '/labs/r01', '/leaderboard', '/admin/users']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(303);
      expect(res.headers.location, path).toBe(`/login?next=${encodeURIComponent(path)}`);
    }
    for (const path of ['/login', '/register', '/healthz', '/static/app.css']) expect((await request(app).get(path)).status, path).toBe(200);
  });

  it('mounts no labs, no standalone portal pages and no JSON API, even signed in', async () => {
    const { app } = portalApp();
    expect(app.locals.mode).toBe('portal');
    expect(app.locals.challenges.all()).toEqual([]);
    const { agent } = await player(app, 'alice');
    for (const path of ['/d/gatekeeper/sqli-login', '/d/gatekeeper', '/c/GK-01', '/scoreboard', '/api/submit']) {
      expect((await agent.get(path)).status, path).toBe(404);
    }
    expect((await agent.post('/api/submit').send({ challengeId: 'GK-01', submission: 'x' })).status).toBe(404);
  });

  it('needs its range options and the login', () => {
    expect(() => createApp({ flagSecret: TEST_SECRET, mode: 'portal' })).toThrow(/range/);
    expect(() => createApp({
      flagSecret: TEST_SECRET, mode: 'portal', auth: false,
      range: { domain: DOMAIN, portalHost: DOMAIN, internalHost: 'portal', registry: testRegistry(), limits: DEFAULT_LIMITS },
    })).toThrow(/login/);
  });

  it('standalone stays the default (HVWA_MODE unset): labs mounted, no range', () => {
    const app = createApp({ flagSecret: TEST_SECRET });
    expect(app.locals.mode).toBe('standalone');
    expect(app.locals.range).toBeUndefined();
    app.locals.db.close();
  });

  it('fails closed on instance hosts, the internal host and /__hvwa/* of the portal host; other hosts are 421', async () => {
    const { app } = portalApp();
    const lab = `i-${'a'.repeat(26)}.${DOMAIN}`;
    for (const [host, path] of [[lab, '/'], [lab, '/__hvwa/gate?t=x'], ['portal', '/__hvwa/auth'], ['portal', '/'], [DOMAIN, '/__hvwa/gate']]) {
      const res = await request(app).get(path).set('Host', host);
      expect(res.status, `${host}${path}`).toBe(404);
      expect(res.headers['set-cookie'], `${host}${path}`).toBeUndefined();
    }
    expect((await request(app).get('/').set('Host', 'evil.example')).status).toBe(421);
  });
});

describe('the catalog', () => {
  it('lists every registry lab: app, title, category, difficulty badge, scenario and level chips', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/')).text;
    const cards = [...html.matchAll(/data-testid="lab-card" data-lab="(r\d{2})" data-difficulty="([a-z]+)" data-solved="(true|false)"/g)]
      .map((m) => m.slice(1).join(':'));
    expect(cards).toEqual(['r01:easy:false', 'r02:medium:false']);
    for (const text of ['App clinic', 'clinic title', 'Scenario of clinic', 'SQL injection', 'Easy', 'Medium', 'Broken access control']) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain('href="/labs/r01"');
  });

  it('filters by category, difficulty and solved state (a GET form: no JavaScript), ignoring unknown values', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r02', 'acolyte', 200, T0);
    const ids = async (q: string) => [...(await agent.get(`/${q}`)).text.matchAll(/data-lab="(r\d{2})"/g)].map((m) => m[1]);
    expect(await ids('?difficulty=medium')).toEqual(['r02']);
    expect(await ids(`?category=${encodeURIComponent('SQL injection')}`)).toEqual(['r01']);
    expect(await ids('?show=done')).toEqual(['r02']);
    expect(await ids('?show=todo')).toEqual(['r01']);
    expect(await ids('?difficulty=insane&category=%3Cx%3E')).toEqual(['r01', 'r02']);
    expect((await agent.get('/')).text).toContain('data-testid="range-score">200<');
  });
});

describe('a lab page', () => {
  it('briefing, scenario and a level picker with points (Easy: 100 / 150 / 200, Divine not scored); ?level= is clamped', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/labs/r01?level=templar')).text;
    expect(html).toContain('Briefing of clinic');
    for (const [level, text] of [['acolyte', '100'], ['templar', '150'], ['inquisitor', '200']]) {
      expect(html).toMatch(new RegExp(`data-testid="range-level-${level}"[^>]*>[\\s\\S]*?${text} `));
    }
    expect(html).toMatch(/data-testid="range-level-templar"[^>]*aria-current="true"/);
    const courier = (await agent.get('/labs/r02?level=inquisitor')).text; // r02 has acolyte + divine: clamped to acolyte
    expect(courier).toMatch(/data-testid="range-level-acolyte"[^>]*aria-current="true"/);
    expect((await agent.get('/labs/r99')).status).toBe(404);
  });

  it('a hint costs points: the account CSRF token is required; it shows the text and the score drops once', async () => {
    const { app } = portalApp();
    const { agent, userId } = await player(app, 'alice');
    recordRangeSolve(app.locals.db, userId, 'r01', 'acolyte', 100, T0);
    expect((await agent.post('/labs/r01/hint').type('form').send({ tier: '1' })).status).toBe(403);
    const csrf = csrfOf((await agent.get('/labs/r01')).text);
    const res = await agent.post('/labs/r01/hint').set('HX-Request', 'true').type('form').send({ _csrf: csrf, tier: '1' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Hint one of clinic');
    await agent.post('/labs/r01/hint').type('form').send({ _csrf: csrf, tier: '1' });
    expect((await agent.get('/')).text).toContain('data-testid="range-score">90<');
    expect((await agent.post('/labs/r01/hint').set('HX-Request', 'true').type('form').send({ _csrf: csrf, tier: '3' })).status).toBe(400);
  });
});

describe('the leaderboard and the navigation', () => {
  it('ranks players by score, then by the earlier last solve; marks the viewer', async () => {
    const { app } = portalApp();
    const a = await player(app, 'alice');
    const b = await player(app, 'bob');
    recordRangeSolve(app.locals.db, a.userId, 'r01', 'templar', 150, T0 + 2);
    recordRangeSolve(app.locals.db, b.userId, 'r01', 'templar', 150, T0 + 1);
    const html = (await a.agent.get('/leaderboard')).text;
    expect([...html.matchAll(/data-rank="(\d+)" data-user="([a-z_0-9]+)"/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual(['1:bob', '2:alice']);
    expect(html).toMatch(/data-user="alice"[^>]*aria-current="true"/);
  });

  it('Labs and Leaderboard for everyone, Admin for admins only; no Districts or Scoreboard links', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    const html = (await agent.get('/')).text;
    expect(html).toContain('data-testid="nav-labs"');
    expect(html).toContain('data-testid="nav-leaderboard"');
    expect(html).not.toContain('data-testid="nav-admin"');
    expect(html).not.toContain('href="/scoreboard"');
    expect((await (await signInAdmin(app)).get('/')).text).toContain('data-testid="nav-admin"');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/portal-mode.spec.ts`
Expected: FAIL — `createApp` has no `mode`/`range` options and `src/range/types.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/range/types.ts`:

```ts
// src/range/types.ts — the shapes the range portal's modules share (src/range/index.ts composes them).
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformAuth } from '../auth/index.js';
import type { LabRegistry } from '../lab-registry.js';

/** Spec §5's limits in ms (src/range/config.ts reads them from HVWA_RANGE_* minutes). */
export interface RangeLimits {
  readonly capacity: number;
  readonly idleMs: number;
  readonly maxMs: number;
  readonly extendMs: number;
  readonly ceilingMs: number;
  /** A start that has not passed its health check by then fails (start_timeout). */
  readonly startTimeoutMs: number;
}

export const DEFAULT_LIMITS: RangeLimits = Object.freeze({
  capacity: 140, idleMs: 30 * 60_000, maxMs: 120 * 60_000, extendMs: 30 * 60_000, ceilingMs: 240 * 60_000, startTimeoutMs: 90_000,
});

/** createApp's `range` option (portal mode); src/range/options.ts builds it from the environment. */
export interface RangePortalOptions {
  /** HVWA_RANGE_DOMAIN: instances live at i-<instanceId>.<domain> (one level: Cloudflare's Universal SSL covers it). */
  readonly domain: string;
  /** HVWA_PORTAL_HOST: the portal's public host name. */
  readonly portalHost: string;
  /** HVWA_RANGE_PUBLIC_SCHEME: what the browser uses. Default 'https' (TLS ends at Cloudflare); 'http' for local runs. */
  readonly publicScheme?: 'http' | 'https';
  /** HVWA_RANGE_PUBLIC_PORT: the port of public URLs when it is not the scheme's default (local runs). */
  readonly publicPort?: number;
  /** HVWA_FORWARD_AUTH_HOST: the only Host /__hvwa/auth answers on (Traefik calls http://portal:1337/__hvwa/auth). */
  readonly internalHost: string;
  readonly registry: LabRegistry;
  readonly limits: RangeLimits;
  /** HVWA_REGISTRATION_CODE. */
  readonly registrationCode?: string;
  /** Secure on the range's cookies (hvwa_gate): true when the public scheme is https (src/range/options.ts). */
  readonly secureCookies?: boolean;
  /** Clock (ms); tests inject one. */
  readonly now?: () => number;
}

/** What every range router gets. */
export interface RangeContext {
  readonly db: DatabaseSync;
  readonly auth: PlatformAuth;
  readonly opts: RangePortalOptions;
  readonly registry: LabRegistry;
  readonly now: () => number;
}
```

Create `src/range/ids.ts`:

```ts
// src/range/ids.ts — instance ids (spec range §5.2): 128-bit random, RFC 4648 base32 in lower case, 26 characters. The
// id is also the lab's host name: i-<id>.<domain>.
import { randomBytes } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const INSTANCE_ID_RE = /^[a-z2-7]{26}$/;

/** RFC 4648 base32, lower case, no padding. */
export function base32(bytes: Uint8Array): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function newInstanceId(): string {
  return base32(randomBytes(16));
}
```

Create `src/range/hosts.ts`:

```ts
// src/range/hosts.ts — the range's host names and public origins (spec range §5 config). One level deep, so Cloudflare's
// Universal SSL covers them: the portal is HVWA_PORTAL_HOST (the domain), instances i-<instanceId>.<domain>, request
// catchers c-<userId>.<domain> (Plan C). Locally hvwa.localhost and i-<id>.localhost. Public URLs use the public scheme
// (https behind the tunnel, http locally) and a port only when it is not the scheme's default.
import { INSTANCE_ID_RE } from './ids.js';

export type PublicScheme = 'http' | 'https';

export const instanceHost = (instanceId: string, domain: string) => `i-${instanceId}.${domain}`;

/** The instance id of a (lower-cased, port-less) host name, or undefined when it is not an instance host of this domain. */
export function instanceIdOfHost(hostname: string, domain: string): string | undefined {
  const suffix = `.${domain}`;
  if (!hostname.startsWith('i-') || !hostname.endsWith(suffix)) return undefined;
  const id = hostname.slice(2, -suffix.length);
  return INSTANCE_ID_RE.test(id) ? id : undefined;
}

const DEFAULT_PORT: Readonly<Record<PublicScheme, number>> = Object.freeze({ http: 80, https: 443 });
const portPart = (scheme: PublicScheme, port?: number) => (port === undefined || port === DEFAULT_PORT[scheme] ? '' : `:${port}`);
export const instanceOrigin = (instanceId: string, domain: string, scheme: PublicScheme = 'https', port?: number) =>
  `${scheme}://${instanceHost(instanceId, domain)}${portPart(scheme, port)}`;
export const portalOrigin = (portalHost: string, scheme: PublicScheme = 'https', port?: number) =>
  `${scheme}://${portalHost}${portPart(scheme, port)}`;
```

Create `src/range/catalog.ts`:

```ts
// src/range/catalog.ts — the range's read pages and hints (portal mode): the catalog (/), a lab's page (/labs/:id), a
// paid hint unlock, and the leaderboard. Everything is the signed-in user's (src/range/progress.ts).
import type { Request, Response, Router } from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, sendPage } from '../core/render.js';
import { parseTier } from '../core/hints.js';
import { clampLevel, FLAG_LEVELS, LEVELS, levelRank, type Level } from '../core/levels.js';
import type { Lang } from '../core/i18n.js';
import { DIFFICULTIES, labPoints, type Difficulty, type LabEntry } from '../lab-registry.js';
import { leaderboard, rangeScore, rangeSolvesOf, rangeUnlockedTiers, unlockRangeHint, type Best } from './progress.js';
import type { RangeContext } from './types.js';

export const rangeViewsDir = join(dirname(fileURLToPath(import.meta.url)), 'views');
export const rangeView = (name: string) => join(rangeViewsDir, `${name}.ejs`);

export interface RangeUser { readonly userId: number; readonly username: string; readonly role: 'player' | 'admin' }

/** The signed-in user (the login gate runs before every range route). */
export function userOf(res: Response): RangeUser {
  const a = res.locals.platformAuth;
  if (!a?.signedIn || a.userId === undefined || a.user === undefined) throw new Error('range: no signed-in user (is the login gate mounted?)');
  return { userId: a.userId, username: a.user, role: a.role === 'admin' ? 'admin' : 'player' };
}

export const isHtmx = (req: Request) => req.get('HX-Request') === 'true';
const isDifficulty = (x: unknown): x is Difficulty => typeof x === 'string' && (DIFFICULTIES as readonly string[]).includes(x);

/** Solved per level, counted like the standalone portal: a scored level ranked at or below the best solved one. */
function levelSolved(level: Level, best: Best | undefined): boolean {
  return level !== 'divine' && best !== undefined && levelRank(level) <= levelRank(best.level);
}

export function labCard(lab: LabEntry, best: Best | undefined, lang: Lang, t: (key: string) => string) {
  return {
    id: lab.id, app: lab.app, title: lab.title[lang], category: lab.category, difficulty: lab.difficulty,
    difficultyLabel: t(`range.difficulty.${lab.difficulty}`), scenario: lab.scenario[lang], href: `/labs/${lab.id}`,
    solved: best !== undefined, best: best?.level,
    levels: LEVELS.filter((l) => lab.levels.includes(l)).map((l) => ({ id: l, solved: levelSolved(l, best) })),
  };
}

function unlockedHintHtml(tier: number, text: string, t: (key: string) => string): string {
  return `<details class="accordion hint" open><summary><span class="hint-name">${escapeHtml(t('challenge.hint_tier'))} ${tier}</span>`
    + `<span class="badge badge-ok">${escapeHtml(t('challenge.hint_unlocked'))}</span></summary>`
    + `<div class="accordion-body"><p class="hint-text" data-tier="${tier}">${escapeHtml(text)}</p></div></details>`;
}

export function catalogRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth } = ctx;

  router.get('/', async (req, res) => {
    const { userId } = userOf(res);
    const t = res.locals.t;
    const solves = rangeSolvesOf(db, userId);
    const categories = [...new Set(registry.labs.map((l) => l.category))].sort((a, b) => a.localeCompare(b));
    const category = typeof req.query.category === 'string' && categories.includes(req.query.category) ? req.query.category : '';
    const difficulty = isDifficulty(req.query.difficulty) ? req.query.difficulty : '';
    const show = req.query.show === 'todo' || req.query.show === 'done' ? req.query.show : 'all';
    const cards = registry.labs.map((lab) => labCard(lab, solves.get(lab.id), req.lang, t)).filter((c) =>
      (category === '' || c.category === category) && (difficulty === '' || c.difficulty === difficulty)
      && (show === 'all' || (show === 'done') === c.solved));
    await sendPage(res, rangeView('catalog'), {
      pageTitle: t('range.catalog_title'), cards, categories, difficulties: DIFFICULTIES, filter: { category, difficulty, show },
      score: rangeScore(db, userId), solved: registry.labs.filter((l) => solves.has(l.id)).length, total: registry.labs.length,
    });
  });

  router.get('/labs/:id', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    const { userId } = userOf(res);
    const t = res.locals.t;
    const best = rangeSolvesOf(db, userId).get(lab.id);
    const currentLevel = clampLevel(req.level, lab.levels);
    const unlocked = new Set(rangeUnlockedTiers(db, userId, lab.id));
    await sendPage(res, rangeView('lab'), {
      pageTitle: `${lab.app} — ${lab.title[req.lang]}`,
      lab: { ...labCard(lab, best, req.lang, t), briefing: lab.briefing[req.lang] },
      best, currentLevel, csrf: auth.csrfFor(req),
      levels: LEVELS.filter((l) => lab.levels.includes(l)).map((l) => ({
        id: l, scored: FLAG_LEVELS.includes(l), points: labPoints(lab, l), solved: levelSolved(l, best),
        current: l === currentLevel, href: `/labs/${lab.id}?level=${l}`,
      })),
      hints: [...lab.hints].sort((a, b) => a.id - b.id)
        .map((h) => ({ id: h.id, cost: h.cost, unlocked: unlocked.has(h.id), text: h.text[req.lang] })),
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: lab.app }],
    });
  });

  router.post('/labs/:id/hint', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const tier = parseTier(req.body?.tier);
    const result = tier === undefined ? undefined : unlockRangeHint(db, userOf(res).userId, lab, tier, ctx.now());
    if (!result?.ok) {
      if (isHtmx(req)) {
        res.status(400).type('html')
          .send(`<p class="result result-bad" role="alert" data-error="tier">${escapeHtml(res.locals.t('challenge.err_unknown_tier'))}</p>`);
        return;
      }
      res.redirect(303, `/labs/${lab.id}`);
      return;
    }
    if (isHtmx(req)) { res.type('html').send(unlockedHintHtml(result.hint.id, result.hint.text[req.lang], res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}#hint-${result.hint.id}`);
  });

  router.get('/leaderboard', async (req, res) => {
    const t = res.locals.t;
    await sendPage(res, rangeView('leaderboard'), {
      pageTitle: t('leaderboard.title'), rows: leaderboard(db, 100), me: userOf(res).userId,
      crumbs: [{ label: t('nav.labs'), href: '/' }, { label: t('leaderboard.title') }],
    });
  });
}
```

Create `src/range/index.ts`:

```ts
// src/range/index.ts — the range portal (HVWA_MODE=portal, spec 2026-11-20 range). PLATFORM code: the labs it launches
// are the vulnerable part, this is not. createApp mounts `edge` before the session, `locals` right after the login
// gate, and `router` after the account pages.
import { Router, type RequestHandler } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import type { PlatformAuth } from '../auth/index.js';
import { hostnameOf } from '../core/host-guard.js';
import { portalFramePolicy } from '../portal/frame-policy.js';
import { catalogRoutes } from './catalog.js';
import { instanceIdOfHost } from './hosts.js';
import type { RangeContext, RangePortalOptions } from './types.js';

export type { RangeLimits, RangePortalOptions } from './types.js';
export { DEFAULT_LIMITS } from './types.js';

export interface RangePortal {
  /** Instance hosts (i-<id>.<domain>): the host guard lets them through, and only `edge` answers them. */
  readonly isInstanceHost: (hostname: string) => boolean;
  /** Before the session: every request on an instance host or the internal host ends here, as does /__hvwa/* anywhere. */
  readonly edge: RequestHandler;
  /** Right after the login gate: the layout's range navigation. */
  readonly locals: RequestHandler;
  /** After the account pages: the range's own pages. */
  readonly router: Router;
}

export function createRangePortal(db: DatabaseSync, auth: PlatformAuth, opts: RangePortalOptions): RangePortal {
  const ctx: RangeContext = { db, auth, opts, registry: opts.registry, now: opts.now ?? Date.now };
  const isInstanceHost = (hostname: string) => instanceIdOfHost(hostname, opts.domain) !== undefined;

  const edge: RequestHandler = (req, res, next) => {
    const host = hostnameOf(req.headers.host);
    const ours = host !== undefined && (host === opts.internalHost || isInstanceHost(host));
    if (!ours && !/^\/__hvwa(?:\/|$)/i.test(req.path)) { next(); return; }
    res.set('Cache-Control', 'no-store');
    res.status(404).type('text/plain').send('Not found\n');
  };

  const locals: RequestHandler = (_req, res, next) => {
    res.locals.portalNav = { admin: res.locals.platformAuth?.role === 'admin' };
    next();
  };

  const router = Router();
  router.use(portalFramePolicy());
  catalogRoutes(router, ctx);
  return Object.freeze({ isInstanceHost, edge, locals, router });
}
```

Create `src/range/views/catalog.ejs`:

```ejs
<%# Range catalog (src/range/catalog.ts): the player's score, filters (a GET form, no JavaScript), one card per lab. Hooks: range-score, range-solved, lab-card (data-lab, data-difficulty, data-solved). Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <h1 class="page-title"><%= t('range.catalog_title') %></h1>
  <p class="page-lead"><%= t('range.catalog_lead') %></p>
</header>
<div class="stat-row">
  <div class="card stat">
    <div class="stat-label"><%= t('range.your_score') %></div>
    <div class="stat-value accent" data-testid="range-score"><%= score %></div>
  </div>
  <div class="card stat">
    <div class="stat-label"><%= t('home.stat_solved') %></div>
    <div class="stat-value" data-testid="range-solved"><%= solved %> <span class="stat-of"><%= t('home.of').replace('{n}', total) %></span></div>
  </div>
</div>
<form method="get" action="/" class="range-filters" data-testid="range-filters">
  <div class="field">
    <label for="f-category"><%= t('range.filter_category') %></label>
    <select id="f-category" name="category">
      <option value=""><%= t('range.filter_all') %></option>
<% categories.forEach(function (c) { -%>
      <option value="<%= c %>"<% if (c === filter.category) { %> selected<% } %>><%= c %></option>
<% }); -%>
    </select>
  </div>
  <div class="field">
    <label for="f-difficulty"><%= t('range.filter_difficulty') %></label>
    <select id="f-difficulty" name="difficulty">
      <option value=""><%= t('range.filter_all') %></option>
<% difficulties.forEach(function (d) { -%>
      <option value="<%= d %>"<% if (d === filter.difficulty) { %> selected<% } %>><%= t('range.difficulty.' + d) %></option>
<% }); -%>
    </select>
  </div>
  <div class="field">
    <label for="f-show"><%= t('range.filter_show') %></label>
    <select id="f-show" name="show">
      <option value="all"><%= t('range.filter_all') %></option>
      <option value="todo"<% if (filter.show === 'todo') { %> selected<% } %>><%= t('range.show_todo') %></option>
      <option value="done"<% if (filter.show === 'done') { %> selected<% } %>><%= t('range.show_done') %></option>
    </select>
  </div>
  <button type="submit" class="btn btn-secondary"><%= t('range.filter_apply') %></button>
</form>
<% if (cards.length === 0) { -%>
<div class="empty">
  <svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg>
  <p><%= t('range.empty') %></p>
</div>
<% } -%>
<div class="catalog-grid">
<% cards.forEach(function (c) { -%>
  <a class="card lab-card" href="<%= c.href %>" data-testid="lab-card" data-lab="<%= c.id %>" data-difficulty="<%= c.difficulty %>" data-solved="<%= c.solved ? 'true' : 'false' %>">
    <p class="lab-card-meta"><span class="tag"><%= c.category %></span><span class="badge difficulty-badge" data-difficulty="<%= c.difficulty %>"><%= c.difficultyLabel %></span></p>
    <h2 class="lab-card-app"><%= c.app %></h2>
    <p class="lab-card-title"><%= c.title %></p>
    <p class="lab-card-scenario"><%= c.scenario %></p>
    <ul class="level-chips" aria-label="<%= t('challenge.levels') %>">
<% c.levels.forEach(function (l) { -%>
      <li class="level-chip level-<%= l.id %>" data-solved="<%= l.solved ? 'true' : 'false' %>"><%= t('level.' + l.id) %><% if (l.solved) { %><svg class="icon icon-sm" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-check"></use></svg><span class="sr-only"> <%= t('challenge.solved') %></span><% } %></li>
<% }); -%>
    </ul>
  </a>
<% }); -%>
</div>
```

Create `src/range/views/lab.ejs`:

```ejs
<%# Range lab page (src/range/catalog.ts): briefing, difficulty, the level picker with points, paid hints; the side column holds how the range works. Hooks: briefing, range-level-<level> (data-solved, aria-current), hint-<tier>. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <p class="lab-card-meta"><span class="tag"><%= lab.category %></span><span class="badge difficulty-badge" data-difficulty="<%= lab.difficulty %>"><%= lab.difficultyLabel %></span></p>
  <h1 class="page-title"><span><%= lab.app %></span> <span class="muted"><%= lab.title %></span></h1>
<% if (best) { -%>
  <p class="status status-solved"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-check-circle"></use></svg><%= t('challenge.solved_at').replace('{level}', t('level.' + best.level)) %></p>
<% } -%>
</header>

<div class="player">
  <div class="player-main">
    <section class="card panel" aria-labelledby="briefing-title">
      <h2 id="briefing-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-target"></use></svg><%= t('challenge.briefing') %></h2>
      <p class="briefing-text" data-testid="briefing"><%= lab.briefing %></p>
      <p class="lab-card-scenario"><%= lab.scenario %></p>
    </section>

    <section class="card panel" aria-labelledby="levels-title">
      <h2 id="levels-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-layers"></use></svg><%= t('challenge.levels') %></h2>
      <p class="panel-lead"><%= t('range.levels_lead') %></p>
      <ul class="level-tabs">
<% levels.forEach(function (l) { -%>
        <li data-level="<%= l.id %>">
          <a class="level-tab" data-testid="range-level-<%= l.id %>" data-solved="<%= l.solved ? 'true' : 'false' %>" href="<%= l.href %>"<% if (l.current) { %> aria-current="true"<% } %>><%= t(l.id === 'divine' ? 'challenge.divine_tab' : 'level.' + l.id) %><span class="level-tab-meaning"><%= t('level_meaning.' + l.id) %></span><span class="level-tab-meta"><span><%= l.scored ? l.points + ' ' + t('challenge.points') : t('scoreboard.not_scored') %></span></span></a>
<% if (l.scored) { -%>
          <span class="badge <%= l.solved ? 'badge-ok' : 'muted' %>"><%= l.solved ? t('challenge.solved') : t('challenge.unsolved') %></span>
<% } -%>
        </li>
<% }); -%>
      </ul>
    </section>

    <section class="card panel" aria-labelledby="hints-title">
      <h2 id="hints-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-bulb"></use></svg><%= t('challenge.hints') %></h2>
      <p class="panel-lead"><%= hints.length ? t('challenge.hints_lead') : t('challenge.no_hints') %></p>
      <ul class="hint-list">
<% hints.forEach(function (h) { -%>
        <li id="hint-<%= h.id %>" data-testid="hint-<%= h.id %>">
<% if (h.unlocked) { -%>
          <details class="accordion hint" open><summary><span class="hint-name"><%= t('challenge.hint_tier') %> <%= h.id %></span><span class="badge badge-ok"><%= t('challenge.hint_unlocked') %></span></summary><div class="accordion-body"><p class="hint-text" data-tier="<%= h.id %>"><%= h.text %></p></div></details>
<% } else { -%>
          <details class="accordion hint">
            <summary><span class="hint-name"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-lock"></use></svg><%= t('challenge.hint_tier') %> <%= h.id %></span><span class="badge"><%= t('challenge.hint_cost') %>: <%= h.cost %> <%= t('challenge.points') %></span></summary>
            <div class="accordion-body">
              <form method="post" action="/labs/<%= lab.id %>/hint" hx-post="/labs/<%= lab.id %>/hint" hx-target="#hint-<%= h.id %>" hx-swap="innerHTML" hx-confirm="<%= t('challenge.hint_confirm') %>">
                <input type="hidden" name="_csrf" value="<%= csrf %>">
                <input type="hidden" name="tier" value="<%= h.id %>">
                <button type="submit" class="btn btn-secondary btn-sm"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-unlock"></use></svg><%= t('challenge.hint_unlock') %> <%= h.id %> (<%= t('challenge.hint_cost') %>: <%= h.cost %>)</button>
              </form>
            </div>
          </details>
<% } -%>
        </li>
<% }); -%>
      </ul>
    </section>
  </div>

  <aside class="player-side">
    <section class="card panel" aria-labelledby="range-howto-title">
      <h2 id="range-howto-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-compass"></use></svg><%= t('range.howto_heading') %></h2>
      <ol class="howto">
        <li><span><%= t('range.howto1') %></span></li>
        <li><span><%= t('range.howto2') %></span></li>
        <li><span><%= t('range.howto3') %></span></li>
      </ol>
    </section>
  </aside>
</div>
```

Create `src/range/views/leaderboard.ejs`:

```ejs
<%# Range leaderboard (src/range/catalog.ts, progress.ts leaderboard): rank, player, score, labs solved; the viewer's row is marked. Hooks: leaderboard, data-rank, data-user. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <h1 class="page-title"><%= t('leaderboard.title') %></h1>
  <p class="page-lead"><%= t('leaderboard.lead') %></p>
</header>
<% if (rows.length === 0) { -%>
<div class="empty">
  <svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-trophy"></use></svg>
  <p><%= t('leaderboard.empty') %></p>
</div>
<% } else { -%>
<div class="table-wrap">
  <table class="table" data-testid="leaderboard">
    <thead><tr><th scope="col" class="num"><%= t('leaderboard.col_rank') %></th><th scope="col"><%= t('leaderboard.col_player') %></th><th scope="col" class="num"><%= t('leaderboard.col_score') %></th><th scope="col" class="num"><%= t('leaderboard.col_solved') %></th></tr></thead>
    <tbody>
<% rows.forEach(function (r) { -%>
      <tr data-rank="<%= r.rank %>" data-user="<%= r.username %>"<% if (r.userId === me) { %> class="leaderboard-me" aria-current="true"<% } %>>
        <td class="num"><%= r.rank %></td>
        <th scope="row"><%= r.username %><% if (r.userId === me) { %> <span class="muted"><%= t('leaderboard.you') %></span><% } %></th>
        <td class="num"><%= r.score %></td>
        <td class="num"><%= r.solved %></td>
      </tr>
<% }); -%>
    </tbody>
  </table>
</div>
<% } -%>
```

Replace `src/app.ts` with:

```ts
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db/index.js';
import { authModeFrom, editionFrom, modeFrom, type Config, type Mode } from './config.js';
import { editionChallengeIds, type Edition } from './editions.js';
import { challengeSet, getChallenge, type ChallengeSet } from './core/registry.js';
import { setFlagSecret } from './core/flags.js';
import { hostGuard } from './core/host-guard.js';
import { resolveFlagSecret } from './core/secrets.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { themeMiddleware } from './core/theme.js';
import { checkerRouter } from './core/checker.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import { mountChallenges } from './core/mount.js';
import { portalRouter } from './portal/index.js';
import { platformAuth, SIGN_IN_PER_IP_DEFAULTS, type AuthOptions, type AuthService } from './auth/index.js';
import { createRangePortal, type RangePortal, type RangePortalOptions } from './range/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Vendored htmx (pinned dependency), served locally — no network at runtime.
// Only this one file is exposed, not the rest of the package's dist/.
// sendFile gets it as a root + name: with a bare absolute path, send's
// dotfiles check covers every segment, so a checkout under any dot-directory
// (.worktrees/, ~/.local/...) would answer 404.
const htmxDistDir = join(
  dirname(createRequire(import.meta.url).resolve('htmx.org/package.json')), 'dist');

export interface AppOptions {
  /** Clock (ms) for the Restart-lab cooldown; tests inject one. Default Date.now. */
  resetClock?: () => number;
  /** Most new `hvwa_sid` sessions issued per rolling minute (default 60); beyond it: 429. */
  maxNewSessionsPerMinute?: number;
  /** Clock (ms) for the session-issuance limit; tests inject one. Default Date.now. */
  sessionClock?: () => number;
  /** SQLite path. Defaults to an in-memory database (tests). */
  dbPath?: string;
  /**
   * HMAC secret for flags. PROCESS-WIDE: the flag secret is a single module
   * value in core/flags.ts shared by every app in this process, so passing it
   * here changes it for all of them. When omitted, the current secret is kept
   * (by default a random value generated once per process). server.ts always
   * passes the env/persisted secret.
   */
  flagSecret?: string;
  /**
   * Extra Host names to answer to, besides localhost / 127.0.0.1 / [::1]
   * (DNS-rebinding guard). server.ts passes HVWA_ALLOWED_HOSTS.
   */
  allowedHosts?: readonly string[];
  /**
   * Which challenges to serve (src/editions.ts): 'full' = every registered one, 'lite' = the lite list.
   * Overrides the environment; when omitted, HVWA_EDITION decides (blank/unset = 'full'). server.ts
   * passes the validated config value; tests/support/setup.ts pins HVWA_EDITION=full for every spec.
   */
  edition?: Edition;
  /**
   * The platform login (src/auth): false = off, true or an AuthOptions object = on (`initialPassword` is
   * the admin's first password, used only when no account exists yet; `now` a clock for tests).
   * Overrides the environment; when omitted, HVWA_AUTH decides, and unset/blank HVWA_AUTH means ON only
   * when NODE_ENV=production (config.ts authModeFrom). server.ts passes the validated config value;
   * tests/support/setup.ts pins HVWA_AUTH=off, so only specs that pass `auth` run with the login.
   * Portal mode always has the login (false is refused there).
   */
  auth?: boolean | AuthOptions;
  /**
   * standalone (every lab in one process: the lite and full images) or portal (the range portal: accounts, catalog,
   * instances; it mounts no labs). Overrides the environment; when omitted, HVWA_MODE decides (blank/unset =
   * standalone). tests/support/setup.ts pins standalone; portal-mode specs pass `mode: 'portal'` and `range`.
   */
  mode?: Mode;
  /** Portal mode only, and required there: the range (src/range/options.ts portalAppOptions builds it). */
  range?: RangePortalOptions;
}

/**
 * The options server.ts builds the app with: the DB in the data dir, the
 * configured or persisted flag secret (created on first use), the extra
 * Host names from HVWA_ALLOWED_HOSTS, the edition and the login.
 */
export function appOptionsFromConfig(
  config: Pick<Config, 'FLAG_SECRET' | 'HVWA_ALLOWED_HOSTS' | 'HVWA_EDITION' | 'HVWA_AUTH' | 'HVWA_ADMIN_PASSWORD'>,
  dataDir: string,
): AppOptions {
  return {
    dbPath: join(dataDir, 'hvwa.db'),
    flagSecret: resolveFlagSecret(dataDir, config.FLAG_SECRET),
    allowedHosts: config.HVWA_ALLOWED_HOSTS,
    edition: config.HVWA_EDITION,
    auth: config.HVWA_AUTH === 'on' ? { initialPassword: config.HVWA_ADMIN_PASSWORD } : false,
  };
}

/**
 * The Express app plus its typed platform DB handle on `locals.db`, the edition it serves
 * (`locals.challenges` is what it mounts, lists and scores; server.ts prints its count), the
 * login service when auth is on (`locals.auth`, undefined when off), its mode, and the range portal in portal mode.
 */
export type HvwaApp = Express & {
  locals: {
    db: DatabaseSync; edition: Edition; challenges: ChallengeSet; auth: AuthService | undefined;
    mode: Mode; range: RangePortal | undefined;
  };
};

/** The ChallengeSet of an edition. Every challenge the edition lists must be registered by now. */
function editionSet(edition: Edition): ChallengeSet {
  const ids = editionChallengeIds(edition);
  const missing = (ids ?? []).filter((id) => getChallenge(id) === undefined);
  if (missing.length > 0) {
    throw new Error(`createApp: the ${edition} edition lists ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not ` +
      'registered (import src/districts/index.js before createApp, or fix src/editions.ts)');
  }
  return challengeSet(ids);
}

/** /static (the shell's CSS, icons, ui.js) and the vendored htmx: open before any login, in both modes. */
function serveStatic(app: Express): void {
  app.get('/static/vendor/htmx.min.js', (_req, res, next) => {
    res.sendFile('htmx.min.js', { root: htmxDistDir }, (err) => { if (err) next(err); });
  });
  app.use('/static', express.static(join(here, 'public'), { index: false }));
}

export function createApp(opts: AppOptions = {}): HvwaApp {
  if (opts.flagSecret) setFlagSecret(opts.flagSecret);
  if ((opts.mode ?? modeFrom(process.env)) === 'portal') return createPortalApp(opts);
  const edition = opts.edition ?? editionFrom(process.env);
  const challenges = editionSet(edition);
  const authOn = opts.auth === undefined ? authModeFrom(process.env) === 'on' : opts.auth !== false;

  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);
  const login = authOn ? platformAuth(db, typeof opts.auth === 'object' ? opts.auth : {}) : undefined;

  // The app's DB handle: closed by server.ts on shutdown, and by tests that
  // use a file DB (Windows cannot delete a file SQLite still holds open).
  // Object.assign keeps the same locals object and yields the typed shape.
  const base = express();
  const app: HvwaApp = Object.assign(base, {
    locals: Object.assign(base.locals, { db, edition, challenges, auth: login?.service, mode: 'standalone' as const, range: undefined }),
  });

  // FIRST: requests for a foreign Host (DNS rebinding) never reach anything else.
  app.use(hostGuard(opts.allowedHosts));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware({ maxNewPerMinute: opts.maxNewSessionsPerMinute, now: opts.sessionClock }));
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.use(themeMiddleware());
  serveStatic(app);

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  // The platform login: /login stays open; EVERYTHING after the gate (the API, every lab, the portal,
  // the 404 page) needs a signed-in admin. Off: nothing is mounted and the portal is exactly as before.
  if (login) {
    app.use(login.publicRouter);
    app.use(login.gate);
    app.use(login.accountRouter);
  }
  app.use('/api', checkerRouter(db, challenges));
  mountChallenges(app, { now: opts.resetClock, challenges }); // the edition's challenges at /d/<district>/<slug>
  app.use('/', portalRouter(db, challenges));

  app.use(notFoundHandler());
  app.use(errorHandler()); // must stay last
  return app;
}

/**
 * Portal mode (spec 2026-11-20 range): accounts, the range catalog, instances, the gate and forward-auth. No lab is
 * mounted and there is no /api: range labs run in their own containers, behind Traefik.
 */
function createPortalApp(opts: AppOptions): HvwaApp {
  const range = opts.range;
  if (!range) throw new Error('createApp: portal mode needs the `range` option (src/range/options.ts portalAppOptions)');
  if (opts.auth === false) throw new Error('createApp: portal mode always has the login (auth cannot be false)');
  const edition = opts.edition ?? editionFrom(process.env);
  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);
  const authOpts: AuthOptions = typeof opts.auth === 'object' ? opts.auth : {};
  // Portal-mode login: a budget of failed sign-ins per client IP (CF-Connecting-IP behind the tunnel), and the forms'
  // Origin check against the public scheme (TLS ends at Cloudflare; the portal itself only sees plain http).
  const login = platformAuth(db, {
    signInPerIp: SIGN_IN_PER_IP_DEFAULTS, publicScheme: range.publicScheme ?? 'https',
    ...authOpts, registration: { code: range.registrationCode, ...authOpts.registration },
  });
  const portal = createRangePortal(db, login, range);

  const base = express();
  const app: HvwaApp = Object.assign(base, {
    locals: Object.assign(base.locals, {
      db, edition, challenges: challengeSet([]), auth: login.service, mode: 'portal' as const, range: portal,
    }),
  });
  // FIRST: foreign Hosts get 421. The portal host, the internal forward-auth host and instance hosts pass; `edge`
  // then answers everything on the last two (and /__hvwa/* anywhere) before a session cookie could be issued.
  app.use(hostGuard([...(opts.allowedHosts ?? []), range.portalHost, range.internalHost], portal.isInstanceHost));
  app.use(cookieParser());
  app.use(portal.edge);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(sessionMiddleware({ maxNewPerMinute: opts.maxNewSessionsPerMinute, now: opts.sessionClock }));
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.use(themeMiddleware());
  serveStatic(app);
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

  app.use(login.publicRouter); // /login, /register
  app.use(login.gate);         // everything below needs a signed-in, active account
  app.use(portal.locals);
  app.use(login.accountRouter);
  app.use(portal.router);

  app.use(notFoundHandler());
  app.use(errorHandler()); // must stay last
  return app;
}
```

In `src/core/views/layout.ejs`:

1. The banner text line becomes:

```ejs
      <span class="banner-text"><%= t(typeof portalNav !== 'undefined' && portalNav ? 'auth.temp_banner' : 'auth.default_banner') %></span>
```

2. The `<nav class="site-nav">` block becomes:

```ejs
<% if (!platformAuth || platformAuth.signedIn) { -%>
      <nav class="site-nav" aria-label="<%= t('nav.main') %>">
<% if (typeof portalNav !== 'undefined' && portalNav) { -%>
        <a href="/" class="nav-link" data-testid="nav-labs"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg><span><%= t('nav.labs') %></span></a>
        <a href="/leaderboard" class="nav-link" data-testid="nav-leaderboard"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-trophy"></use></svg><span><%= t('nav.leaderboard') %></span></a>
<% if (portalNav.admin) { -%>
        <a href="/admin/users" class="nav-link" data-testid="nav-admin"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-shield"></use></svg><span><%= t('nav.admin') %></span></a>
<% } -%>
<% } else { -%>
        <a href="/" class="nav-link"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-map"></use></svg><span><%= t('nav.districts') %></span></a>
        <a href="/scoreboard" class="nav-link"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-trophy"></use></svg><span><%= t('nav.scoreboard') %></span></a>
<% } -%>
      </nav>
<% } -%>
```

In `src/core/i18n.ts`, add after `'nav.account'`:

```ts
  // Portal mode (the range): navigation.
  'nav.labs': { id: 'Lab', en: 'Labs' },
  'nav.leaderboard': { id: 'Peringkat', en: 'Leaderboard' },
  'nav.admin': { id: 'Admin', en: 'Admin' },
```

and after the registration block (Task 5):

```ts
  'auth.temp_banner': {
    id: 'Anda memakai kata sandi sementara — segera ganti.',
    en: "You're using a temporary password — change it.",
  },
  // The range catalog and lab pages (src/range/catalog.ts).
  'range.catalog_title': { id: 'Lab Range', en: 'Range labs' },
  'range.catalog_lead': {
    id: 'Setiap lab adalah aplikasi tersendiri di kontainernya sendiri. Jalankan, temukan celahnya, ambil flag-nya.',
    en: 'Each lab is its own application in its own container. Launch it, find the flaw, capture the flag.',
  },
  'range.your_score': { id: 'Skor Anda', en: 'Your score' },
  'range.filter_category': { id: 'Kategori', en: 'Category' },
  'range.filter_difficulty': { id: 'Tingkat kesulitan', en: 'Difficulty' },
  'range.filter_show': { id: 'Tampilkan', en: 'Show' },
  'range.filter_all': { id: 'Semua', en: 'All' },
  'range.filter_apply': { id: 'Saring', en: 'Filter' },
  'range.show_todo': { id: 'Belum terpecahkan', en: 'Not solved' },
  'range.show_done': { id: 'Terpecahkan', en: 'Solved' },
  'range.empty': { id: 'Tidak ada lab yang cocok.', en: 'No lab matches.' },
  'range.difficulty.easy': { id: 'Mudah', en: 'Easy' },
  'range.difficulty.medium': { id: 'Sedang', en: 'Medium' },
  'range.difficulty.hard': { id: 'Sulit', en: 'Hard' },
  'range.difficulty.expert': { id: 'Ahli', en: 'Expert' },
  'range.levels_lead': {
    id: 'Setiap level adalah instans terpisah dengan flag-nya sendiri. Divine adalah referensi aman dan tidak dinilai.',
    en: 'Each level is a separate instance with its own flag. Divine is the secure reference and is not scored.',
  },
  'range.howto_heading': { id: 'Cara kerja range', en: 'How the range works' },
  'range.howto1': { id: 'Pilih level, lalu jalankan lab Anda sendiri.', en: 'Pick a level, then launch your own lab.' },
  'range.howto2': { id: 'Buka lab di tab baru: hanya Anda yang dapat menjangkaunya.', en: 'Open it in a new tab: only you can reach it.' },
  'range.howto3': { id: 'Temukan flag di dalam aplikasi dan kirimkan di sini.', en: 'Find the flag inside the app and submit it here.' },
  // The leaderboard.
  'leaderboard.title': { id: 'Papan Peringkat', en: 'Leaderboard' },
  'leaderboard.lead': {
    id: 'Pemain teratas menurut skor; bila sama, yang lebih dulu mencapainya di atas.',
    en: 'Top players by score; on a tie, whoever got there first is ahead.',
  },
  'leaderboard.col_rank': { id: '#', en: '#' },
  'leaderboard.col_player': { id: 'Pemain', en: 'Player' },
  'leaderboard.col_score': { id: 'Skor', en: 'Score' },
  'leaderboard.col_solved': { id: 'Lab terpecahkan', en: 'Labs solved' },
  'leaderboard.empty': { id: 'Belum ada yang terpecahkan.', en: 'Nothing solved yet.' },
  'leaderboard.you': { id: '(Anda)', en: '(you)' },
```

In `src/public/app.css`, insert this block immediately before the line `/* Reduced motion: no transitions, no transforms, no animation. */`:

```css
/* ==========================================================================
   Range (portal mode, src/range): catalog, lab page, leaderboard, admin
   ========================================================================== */
.range-filters { display: flex; flex-wrap: wrap; gap: var(--sp-3); align-items: flex-end; margin: 0 0 var(--sp-5); }
.range-filters .field { margin: 0; min-width: 10rem; flex: 1 1 10rem; }
.catalog-grid { display: grid; gap: var(--sp-4); grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); }
.lab-card { display: grid; gap: var(--sp-2); align-content: start; padding: var(--sp-5); color: inherit; text-decoration: none; }
.lab-card:hover { border-color: var(--border-strong); }
.lab-card-meta { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin: 0; }
.lab-card-app { font-size: var(--fs-lg); margin: 0; }
.lab-card-title { margin: 0; color: var(--text); font-weight: 600; }
.lab-card-scenario { margin: 0; color: var(--text-muted); font-size: var(--fs-sm); }
.difficulty-badge[data-difficulty="easy"] { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
.difficulty-badge[data-difficulty="medium"] { color: var(--info); background: var(--info-bg); border-color: var(--info-border); }
.difficulty-badge[data-difficulty="hard"] { color: var(--warning); background: var(--warning-bg); border-color: var(--warning-border); }
.difficulty-badge[data-difficulty="expert"] { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
.leaderboard-me { background: var(--surface-3); }
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/portal-mode.spec.ts tests/ui-shell.spec.ts tests/ui-contrast.spec.ts tests/auth.spec.ts tests/edition.spec.ts`
Expected: PASS (standalone pages are byte-for-byte the same: `portalNav` is undefined there).

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/types.ts src/range/ids.ts src/range/hosts.ts src/range/catalog.ts src/range/index.ts src/range/views/catalog.ejs src/range/views/lab.ejs src/range/views/leaderboard.ejs src/app.ts src/core/views/layout.ejs src/core/i18n.ts src/public/app.css tests/support/range.ts tests/portal-mode.spec.ts
git commit -m "feat(range): portal mode: no labs, range catalog, lab pages, paid hints, leaderboard, range nav"
```

---

### Task 10: Admin pages: users (disable, reset password, make admin) and registration settings

**Files:**
- Create: `src/auth/admin.ts`, `src/auth/views/admin-users.ejs`, `src/auth/views/admin-settings.ejs`, `src/auth/views/admin-nav.ejs`
- Modify: `src/auth/index.ts`, `src/app.ts`, `src/core/i18n.ts`, `src/public/app.css`
- Test: `tests/auth-admin.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/auth-admin.spec.ts`:

```ts
// The admin pages of portal mode (src/auth/admin.ts, spec range §10): users (disable, enable, reset password, make admin
// or player) and registration (open/closed, the event code). Admins only (a player gets 404); every action is an
// account form; an admin never disables or demotes itself.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { csrfOf } from './helpers.js';
import { accountCsrf, player, PLAYER_PASSWORD, portalApp, signInAdmin, signInAs } from './support/range.js';

describe('admin pages are for admins only', () => {
  it('a player gets 404 on every admin page and action', async () => {
    const { app } = portalApp();
    const { agent } = await player(app, 'alice');
    for (const path of ['/admin/users', '/admin/settings']) expect((await agent.get(path)).status, path).toBe(404);
    const csrf = await accountCsrf(agent);
    expect((await agent.post('/admin/users/1/disable').type('form').send({ _csrf: csrf })).status).toBe(404);
    expect((await agent.post('/admin/settings/registration').type('form').send({ _csrf: csrf, open: '0' })).status).toBe(404);
  });
});

describe('/admin/users', () => {
  it('lists every account with role and status; no self-actions on the admin\'s own row', async () => {
    const { app } = portalApp();
    await player(app, 'alice');
    const admin = await signInAdmin(app);
    const html = (await admin.get('/admin/users')).text;
    expect([...html.matchAll(/data-user="([a-z_0-9]+)" data-role="([a-z]+)" data-disabled="(true|false)"/g)].map((m) => m.slice(1).join(':')))
      .toEqual(['admin:admin:false', 'alice:player:false']);
    expect(html).not.toContain('action="/admin/users/1/disable"');
    expect(html).toContain('action="/admin/users/2/disable"');
    expect(html).toContain('data-testid="users"');
  });

  it('disable signs the player out at once and refuses sign-in; enable restores it', async () => {
    const { app } = portalApp();
    const alice = await player(app, 'alice');
    const admin = await signInAdmin(app);
    const csrf = csrfOf((await admin.get('/admin/users')).text);
    const res = await admin.post(`/admin/users/${alice.userId}/disable`).type('form').send({ _csrf: csrf });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/admin/users');
    expect((await alice.agent.get('/')).status).toBe(303); // to /login: the token is gone
    await expect(signInAs(app, 'alice', PLAYER_PASSWORD)).rejects.toThrow(/401/);
    await admin.post(`/admin/users/${alice.userId}/enable`).type('form').send({ _csrf: csrf });
    expect((await (await signInAs(app, 'alice', PLAYER_PASSWORD)).get('/')).status).toBe(200);
  });

  it('reset password: shows a temporary password once; the old one fails; the new one signs in with the banner', async () => {
    const { app } = portalApp();
    const alice = await player(app, 'alice');
    const admin = await signInAdmin(app);
    const csrf = csrfOf((await admin.get('/admin/users')).text);
    const res = await admin.post(`/admin/users/${alice.userId}/reset`).type('form').send({ _csrf: csrf });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const temp = /data-testid="temp-password-value">([A-Za-z0-9_-]{16})</.exec(res.text)?.[1];
    expect(temp).toBeDefined();
    expect((await admin.get('/admin/users')).text).not.toContain(temp);
    await expect(signInAs(app, 'alice', PLAYER_PASSWORD)).rejects.toThrow();
    const page = (await (await signInAs(app, 'alice', temp as string)).get('/')).text;
    expect(page).toContain('data-testid="default-password-banner"');
    expect(page).toContain('temporary password');
  });

  it('make admin / make player; an admin cannot disable or demote itself (400 with a notice); CSRF is required', async () => {
    const { app } = portalApp();
    const alice = await player(app, 'alice');
    const admin = await signInAdmin(app);
    const csrf = csrfOf((await admin.get('/admin/users')).text);
    expect((await admin.post(`/admin/users/${alice.userId}/role`).type('form').send({ _csrf: csrf, role: 'admin' })).status).toBe(303);
    expect((await (await signInAs(app, 'alice', PLAYER_PASSWORD)).get('/admin/users')).status).toBe(200);
    const self = await admin.post('/admin/users/1/disable').type('form').send({ _csrf: csrf });
    expect(self.status).toBe(400);
    expect(self.text).toContain('data-testid="admin-notice"');
    expect((await admin.post('/admin/users/1/role').type('form').send({ _csrf: csrf, role: 'player' })).status).toBe(400);
    expect((await admin.post(`/admin/users/${alice.userId}/disable`).type('form').send({})).status).toBe(403);
    expect((await admin.post('/admin/users/999/disable').type('form').send({ _csrf: csrf })).status).toBe(404);
    expect((await admin.post(`/admin/users/${alice.userId}/role`).type('form').send({ _csrf: csrf, role: 'root' })).status).toBe(404);
  });
});

describe('/admin/settings', () => {
  it('closes and reopens registration; sets and clears the event code', async () => {
    const { app } = portalApp();
    const admin = await signInAdmin(app);
    const page = await admin.get('/admin/settings');
    expect(page.text).toContain('data-testid="registration-state" data-open="true"');
    const csrf = csrfOf(page.text);
    expect((await admin.post('/admin/settings/registration').type('form').send({ _csrf: csrf, open: '0' })).status).toBe(303);
    expect((await request(app).get('/register')).status).toBe(403);
    await admin.post('/admin/settings/registration').type('form').send({ _csrf: csrf, open: '1' });
    expect((await request(app).get('/register')).status).toBe(200);
    expect((await admin.post('/admin/settings/code').type('form').send({ _csrf: csrf, code: 'EVENT-77' })).status).toBe(303);
    expect((await request(app).get('/register')).text).toContain('name="code"');
    expect((await admin.get('/admin/settings')).text).toContain('value="EVENT-77"');
    await admin.post('/admin/settings/code').type('form').send({ _csrf: csrf, code: '' });
    expect((await request(app).get('/register')).text).not.toContain('name="code"');
    expect((await admin.post('/admin/settings/code').type('form').send({ _csrf: csrf, code: 'x'.repeat(129) })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/auth-admin.spec.ts`
Expected: FAIL — `/admin/users` and `/admin/settings` are 404 for the admin too.

- [ ] **Step 3: Implement**

Create `src/auth/admin.ts`:

```ts
// src/auth/admin.ts — the admin pages of portal mode (spec range §10): users (disable, enable, reset password, make admin
// or player) and registration (open or closed, the event code). PLATFORM code: every action is an account form
// (formOk) of an admin (requireAdmin), and an admin never disables or demotes itself.
import { Router, type Request, type Response } from 'express';
import { join } from 'node:path';
import { sendPage } from '../core/render.js';
import { field } from '../core/lab.js';
import { noStore, requireAdmin } from './forms.js';
import { isRole, type AuthService } from './service.js';
import type { AdminSettings } from './settings.js';

export interface AdminDeps {
  readonly service: AuthService;
  readonly settings: AdminSettings;
  readonly viewsDir: string;
  formOk(req: Request): boolean;
  csrfFor(req: Request): string;
  refuse(req: Request, res: Response, back: string): Promise<void>;
}

type Notice = 'self' | 'unknown' | 'busy' | 'code';
const ID_RE = /^[1-9]\d{0,15}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const ACTIONS: ReadonlySet<string> = new Set(['disable', 'enable', 'role', 'reset']);

export function createAdminRouter(deps: AdminDeps): Router {
  const { service, settings } = deps;
  const view = (name: string) => join(deps.viewsDir, `${name}.ejs`);
  const me = (res: Response) => res.locals.platformAuth?.userId ?? 0;
  const crumbs = (res: Response, label: string) => [{ label: res.locals.t('nav.labs'), href: '/' }, { label: res.locals.t('admin.title') }, { label }];

  const renderUsers = (req: Request, res: Response, extra: { temp?: { username: string; password: string }; notice?: Notice } = {}) => {
    noStore(res);
    return sendPage(res, view('admin-users'), {
      pageTitle: res.locals.t('admin.users'), users: service.listUsers(), me: me(res), csrf: deps.csrfFor(req),
      temp: extra.temp, notice: extra.notice, crumbs: crumbs(res, res.locals.t('admin.users')),
    });
  };
  const renderSettings = (req: Request, res: Response, notice?: Notice) => {
    noStore(res);
    return sendPage(res, view('admin-settings'), {
      pageTitle: res.locals.t('admin.settings'), open: settings.registrationOpen(), code: settings.eventCode() ?? '',
      saved: req.query.saved === '1', notice, csrf: deps.csrfFor(req), crumbs: crumbs(res, res.locals.t('admin.settings')),
    });
  };

  const r = Router();
  r.use(requireAdmin);
  r.get('/admin/users', async (req, res) => { await renderUsers(req, res); });
  r.post('/admin/users/:id/:action', async (req, res, next) => {
    const { action } = req.params;
    if (!ACTIONS.has(action)) { next(); return; }
    if (!deps.formOk(req)) { await deps.refuse(req, res, '/admin/users'); return; }
    const id = ID_RE.test(req.params.id) ? Number(req.params.id) : 0;
    if (action === 'reset') {
      if (id === me(res)) { res.status(400); await renderUsers(req, res, { notice: 'self' }); return; }
      const reset = await service.resetPassword(id);
      if (!reset.ok) { res.status(reset.error === 'busy' ? 503 : 404); await renderUsers(req, res, { notice: reset.error }); return; }
      await renderUsers(req, res, { temp: { username: service.getUser(id)?.username ?? '', password: reset.password } });
      return;
    }
    const role = field(req, 'role');
    const result = action === 'role'
      ? (isRole(role) ? service.setRole(me(res), id, role) : { ok: false as const, error: 'unknown' as const })
      : service.setDisabled(me(res), id, action === 'disable');
    if (!result.ok) {
      res.status(result.error === 'self' ? 400 : 404);
      await renderUsers(req, res, { notice: result.error });
      return;
    }
    noStore(res);
    res.redirect(303, '/admin/users');
  });

  r.get('/admin/settings', async (req, res) => { await renderSettings(req, res); });
  r.post('/admin/settings/registration', async (req, res) => {
    if (!deps.formOk(req)) { await deps.refuse(req, res, '/admin/settings'); return; }
    settings.setRegistrationOpen(field(req, 'open') === '1');
    noStore(res);
    res.redirect(303, '/admin/settings?saved=1');
  });
  r.post('/admin/settings/code', async (req, res) => {
    if (!deps.formOk(req)) { await deps.refuse(req, res, '/admin/settings'); return; }
    const code = field(req, 'code').trim();
    if (code.length > 128 || CONTROL.test(code) || (code !== '' && code.length < 4)) {
      res.status(400);
      await renderSettings(req, res, 'code');
      return;
    }
    settings.setEventCode(code);
    noStore(res);
    res.redirect(303, '/admin/settings?saved=1');
  });
  return r;
}
```

Create `src/auth/views/admin-nav.ejs`:

```ejs
<%# Admin sub-navigation (src/auth/admin.ts, src/range/admin.ts): `current` names the page. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<nav class="seg admin-nav" aria-label="<%= t('admin.title') %>" data-testid="admin-nav">
  <a class="seg-item" href="/admin/users"<% if (current === 'users') { %> aria-current="page"<% } %>><%= t('admin.users') %></a>
  <a class="seg-item" href="/admin/settings"<% if (current === 'settings') { %> aria-current="page"<% } %>><%= t('admin.settings') %></a>
</nav>
```

Create `src/auth/views/admin-users.ejs`:

```ejs
<%# Admin: users (src/auth/admin.ts). A reset's temporary password is shown once (temp-password); notices are a closed set. Hooks: users, data-user / data-role / data-disabled. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <h1 class="page-title"><%= t('admin.title') %></h1>
</header>
<%- include('admin-nav', { current: 'users' }) %>
<% if (temp) { -%>
<div class="alert alert-warning" role="status" data-testid="temp-password">
  <svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-key"></use></svg>
  <div class="alert-body">
    <p><%= t('admin.temp_password').replace('{user}', temp.username) %> <code class="temp-password" data-testid="temp-password-value"><%= temp.password %></code></p>
    <p><%= t('admin.temp_password_help') %></p>
  </div>
</div>
<% } -%>
<% if (notice) { -%>
<p class="result result-bad" role="alert" data-testid="admin-notice" data-notice="<%= notice %>"><%= t('admin.err_' + notice) %></p>
<% } -%>
<div class="table-wrap">
  <table class="table" data-testid="users">
    <thead><tr><th scope="col"><%= t('admin.col_user') %></th><th scope="col"><%= t('admin.col_role') %></th><th scope="col"><%= t('admin.col_status') %></th><th scope="col"><%= t('admin.col_created') %></th><th scope="col"><%= t('admin.col_actions') %></th></tr></thead>
    <tbody>
<% users.forEach(function (u) { -%>
      <tr data-user="<%= u.username %>" data-role="<%= u.role %>" data-disabled="<%= u.disabled ? 'true' : 'false' %>">
        <th scope="row"><%= u.username %><% if (u.id === me) { %> <span class="muted"><%= t('admin.self') %></span><% } %></th>
        <td><%= t('admin.role_' + u.role) %></td>
        <td><%= u.disabled ? t('admin.disabled') : t('admin.active') %></td>
        <td><time datetime="<%= new Date(u.createdAt).toISOString() %>"><%= new Date(u.createdAt).toISOString().slice(0, 10) %></time></td>
        <td>
<% if (u.id !== me) { -%>
          <div class="admin-actions">
            <form method="post" action="/admin/users/<%= u.id %>/<%= u.disabled ? 'enable' : 'disable' %>"><input type="hidden" name="_csrf" value="<%= csrf %>"><button type="submit" class="btn btn-secondary btn-xs"><%= u.disabled ? t('admin.enable') : t('admin.disable') %></button></form>
            <form method="post" action="/admin/users/<%= u.id %>/role"><input type="hidden" name="_csrf" value="<%= csrf %>"><input type="hidden" name="role" value="<%= u.role === 'admin' ? 'player' : 'admin' %>"><button type="submit" class="btn btn-secondary btn-xs"><%= u.role === 'admin' ? t('admin.make_player') : t('admin.make_admin') %></button></form>
            <form method="post" action="/admin/users/<%= u.id %>/reset"><input type="hidden" name="_csrf" value="<%= csrf %>"><button type="submit" class="btn btn-danger btn-xs"><%= t('admin.reset_password') %></button></form>
          </div>
<% } -%>
        </td>
      </tr>
<% }); -%>
    </tbody>
  </table>
</div>
```

Create `src/auth/views/admin-settings.ejs`:

```ejs
<%# Admin: registration settings (src/auth/admin.ts): open or closed, the event code (empty = none). Hooks: registration-state (data-open). Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <h1 class="page-title"><%= t('admin.title') %></h1>
</header>
<%- include('admin-nav', { current: 'settings' }) %>
<% if (saved) { -%>
<p class="result result-ok" role="status" data-testid="admin-saved"><%= t('admin.saved') %></p>
<% } -%>
<% if (notice) { -%>
<p class="result result-bad" role="alert" data-testid="admin-notice" data-notice="<%= notice %>"><%= t('admin.err_' + notice) %></p>
<% } -%>
<section class="card panel" aria-labelledby="reg-state-title">
  <h2 id="reg-state-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-user"></use></svg><%= t('admin.registration') %></h2>
  <p data-testid="registration-state" data-open="<%= open ? 'true' : 'false' %>"><%= open ? t('admin.reg_open') : t('admin.reg_closed') %></p>
  <form method="post" action="/admin/settings/registration">
    <input type="hidden" name="_csrf" value="<%= csrf %>">
    <input type="hidden" name="open" value="<%= open ? '0' : '1' %>">
    <button type="submit" class="btn <%= open ? 'btn-danger' : 'btn-primary' %>"><%= open ? t('admin.reg_close') : t('admin.reg_reopen') %></button>
  </form>
</section>
<section class="card panel" aria-labelledby="code-title">
  <h2 id="code-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-key"></use></svg><%= t('admin.event_code') %></h2>
  <form method="post" action="/admin/settings/code" class="auth-form">
    <input type="hidden" name="_csrf" value="<%= csrf %>">
    <div class="field">
      <label for="event-code"><%= t('admin.event_code') %></label>
      <input id="event-code" type="text" name="code" value="<%= code %>" maxlength="128" autocomplete="off" spellcheck="false" aria-describedby="event-code-help">
      <p class="help" id="event-code-help"><%= t('admin.event_code_help') %></p>
    </div>
    <button type="submit" class="btn btn-secondary"><%= t('admin.event_code_save') %></button>
  </form>
</section>
```

In `src/auth/index.ts`:

1. Add the import `import { createAdminRouter } from './admin.js';`.
2. `PlatformAuth` gains:

```ts
  /** The admin pages (portal mode only; createApp mounts it after the account pages). */
  readonly adminRouter: Router;
```

3. Before the final `return`, add:

```ts
  const adminRouter = createAdminRouter({
    service, settings, viewsDir: authViewsDir, refuse,
    formOk: (req) => formOk(req, true),
    csrfFor: (req) => service.csrfToken(req.sessionId, authTokenOf(req)),
  });
```

4. The returned object includes `adminRouter`:

```ts
  return Object.freeze({
    service, settings, publicRouter, gate, accountRouter, adminRouter,
    formOk: (req: Request) => formOk(req, true),
    csrfFor: (req: Request) => service.csrfToken(req.sessionId, authTokenOf(req)),
    refuse,
  });
```

In `src/app.ts` (`createPortalApp`), after `app.use(login.accountRouter);` add:

```ts
  app.use(login.adminRouter);  // /admin/users, /admin/settings (admins only; anyone else falls through to 404)
```

In `src/core/i18n.ts`, add after the leaderboard block:

```ts
  // Admin pages (portal mode, src/auth/admin.ts and src/range/admin.ts).
  'admin.title': { id: 'Admin', en: 'Admin' },
  'admin.users': { id: 'Pengguna', en: 'Users' },
  'admin.settings': { id: 'Pendaftaran', en: 'Registration' },
  'admin.registration': { id: 'Pendaftaran', en: 'Registration' },
  'admin.col_user': { id: 'Pengguna', en: 'User' },
  'admin.col_role': { id: 'Peran', en: 'Role' },
  'admin.col_status': { id: 'Status', en: 'Status' },
  'admin.col_created': { id: 'Dibuat', en: 'Created' },
  'admin.col_actions': { id: 'Tindakan', en: 'Actions' },
  'admin.role_admin': { id: 'Admin', en: 'Admin' },
  'admin.role_player': { id: 'Pemain', en: 'Player' },
  'admin.active': { id: 'Aktif', en: 'Active' },
  'admin.disabled': { id: 'Nonaktif', en: 'Disabled' },
  'admin.disable': { id: 'Nonaktifkan', en: 'Disable' },
  'admin.enable': { id: 'Aktifkan', en: 'Enable' },
  'admin.make_admin': { id: 'Jadikan admin', en: 'Make admin' },
  'admin.make_player': { id: 'Jadikan pemain', en: 'Make player' },
  'admin.reset_password': { id: 'Atur ulang kata sandi', en: 'Reset password' },
  'admin.self': { id: '(Anda)', en: '(you)' },
  'admin.temp_password': { id: 'Kata sandi sementara untuk {user}:', en: 'Temporary password for {user}:' },
  'admin.temp_password_help': {
    id: 'Hanya ditampilkan sekali. Berikan kepada pengguna; ia harus menggantinya setelah masuk.',
    en: 'Shown once. Give it to the user; they must change it after signing in.',
  },
  'admin.err_self': { id: 'Anda tidak dapat melakukan ini pada akun Anda sendiri.', en: 'You cannot do this to your own account.' },
  'admin.err_unknown': { id: 'Akun ini tidak ada.', en: 'This account does not exist.' },
  'admin.err_busy': { id: 'Server sedang sibuk. Coba lagi sebentar lagi.', en: 'The server is busy. Try again in a moment.' },
  'admin.err_code': {
    id: 'Kode acara harus 4 sampai 128 karakter tanpa karakter kontrol, atau kosong.',
    en: 'The event code needs 4 to 128 characters and no control characters, or nothing at all.',
  },
  'admin.reg_open': { id: 'Pendaftaran dibuka.', en: 'Registration is open.' },
  'admin.reg_closed': { id: 'Pendaftaran ditutup.', en: 'Registration is closed.' },
  'admin.reg_close': { id: 'Tutup pendaftaran', en: 'Close registration' },
  'admin.reg_reopen': { id: 'Buka pendaftaran', en: 'Open registration' },
  'admin.event_code': { id: 'Kode acara', en: 'Event code' },
  'admin.event_code_help': {
    id: 'Kosongkan agar pendaftaran tidak memerlukan kode. Menggantikan HVWA_REGISTRATION_CODE.',
    en: 'Leave it empty for registration without a code. Overrides HVWA_REGISTRATION_CODE.',
  },
  'admin.event_code_save': { id: 'Simpan kode', en: 'Save code' },
  'admin.saved': { id: 'Tersimpan.', en: 'Saved.' },
```

In `src/public/app.css`, append to the Range block (Task 9):

```css
.admin-nav { margin: 0 0 var(--sp-5); }
.admin-actions { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.admin-actions form { margin: 0; }
.temp-password { font-family: var(--mono); font-size: var(--fs-lg); user-select: all; }
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/auth-admin.spec.ts tests/portal-mode.spec.ts tests/ui-contrast.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/auth/admin.ts src/auth/views/admin-users.ejs src/auth/views/admin-settings.ejs src/auth/views/admin-nav.ejs src/auth/index.ts src/app.ts src/core/i18n.ts src/public/app.css tests/auth-admin.spec.ts
git commit -m "feat(auth): admin pages for users (disable, reset password, role) and registration settings"
```

---

## Part 2 — Warden and socket-proxy client (spec §13 step 2)

### Task 11: Warden protocol, the Docker Engine API client, and a stub Docker Engine for tests

**Files:**
- Create: `src/warden/protocol.ts`, `src/warden/docker.ts`, `tests/support/docker-stub.ts`
- Test: `tests/warden-docker.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/support/docker-stub.ts`:

```ts
// tests/support/docker-stub.ts — a stub Docker Engine API over real HTTP, in memory: just the endpoints the warden calls
// (/_ping, containers and networks under /v1.44), answering with the Engine's status codes and JSON shapes. It records
// every call; anything it does not model gets 404 and is recorded in `unexpected`, so a spec can prove the warden never
// touches images, exec, volumes, swarm or system endpoints. No Docker needed.
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export const STUB_API = '/v1.44';
export interface StubCall { readonly method: string; readonly path: string; readonly body: unknown }
export type StubHealth = 'starting' | 'healthy' | 'unhealthy';
export interface StubContainer {
  readonly id: string;
  readonly name: string;
  readonly body: Record<string, unknown>;
  status: 'created' | 'running' | 'exited';
  exitCode: number;
  oom: boolean;
  health: StubHealth | undefined;
  readonly networks: Set<string>;
}
export interface StubNetwork { readonly id: string; readonly name: string; readonly body: Record<string, unknown>; readonly containers: Set<string> }

export interface DockerStub {
  readonly url: string;
  readonly calls: StubCall[];
  readonly unexpected: StubCall[];
  /** Images present on the "host": reference -> whether the image declares a HEALTHCHECK. */
  readonly images: Map<string, { healthcheck: boolean }>;
  container(nameOrId: string): StubContainer | undefined;
  containers(): StubContainer[];
  network(nameOrId: string): StubNetwork | undefined;
  networks(): StubNetwork[];
  setHealth(name: string, health: StubHealth | undefined): void;
  exit(name: string, code: number, oom?: boolean): void;
  /** The next request matching `method` and the path regex answers `status` (once). */
  failNext(method: string, path: RegExp, status: number): void;
  /** A container that exists without the warden (Traefik, an orphan). */
  addContainer(name: string, labels?: Record<string, string>, status?: 'running' | 'exited'): void;
  close(): Promise<void>;
}

export async function startDockerStub(): Promise<DockerStub> {
  const calls: StubCall[] = [];
  const unexpected: StubCall[] = [];
  const images = new Map<string, { healthcheck: boolean }>();
  const containers = new Map<string, StubContainer>();
  const networks = new Map<string, StubNetwork>();
  const failures: { method: string; path: RegExp; status: number }[] = [];
  let seq = 0;
  const newId = () => (++seq).toString(16).padStart(64, '0');
  const findC = (k: string) => containers.get(k) ?? [...containers.values()].find((c) => c.id === k);
  const findN = (k: string) => networks.get(k) ?? [...networks.values()].find((n) => n.id === k);

  function addContainer(name: string, labels: Record<string, string> = {}, status: 'running' | 'exited' = 'running'): void {
    containers.set(name, {
      id: newId(), name, body: { Image: 'stub', Labels: labels, HostConfig: {} }, status, exitCode: 0, oom: false, health: undefined, networks: new Set(),
    });
  }

  function inspect(c: StubContainer) {
    return {
      Id: c.id, Name: `/${c.name}`,
      State: { Status: c.status, Running: c.status === 'running', ExitCode: c.exitCode, OOMKilled: c.oom, ...(c.health ? { Health: { Status: c.health } } : {}) },
      Config: { Image: c.body.Image, User: c.body.User, Env: c.body.Env, Labels: c.body.Labels ?? {}, Healthcheck: c.body.Healthcheck },
      HostConfig: c.body.HostConfig ?? {},
      NetworkSettings: { Networks: Object.fromEntries([...c.networks].map((n) => [n, {}])) },
    };
  }

  /** [status, payload]; null payload = no body; undefined = not modelled. */
  function handle(method: string, url: URL, body: unknown): [number, unknown] | undefined {
    const p = url.pathname;
    if (method === 'GET' && p === '/_ping') return [200, 'OK'];
    if (!p.startsWith(`${STUB_API}/`)) return undefined;
    const rest = p.slice(STUB_API.length);
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && rest === '/networks/create') {
      const name = String(b.Name ?? '');
      if (networks.has(name)) return [409, { message: `network with name ${name} already exists` }];
      const n: StubNetwork = { id: newId(), name, body: b, containers: new Set() };
      networks.set(name, n);
      return [201, { Id: n.id, Warning: '' }];
    }
    if (method === 'POST' && (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(rest))) {
      const n = findN(decodeURIComponent(m[1]));
      const c = findC(String(b.Container ?? ''));
      if (!n || !c) return [404, { message: 'No such network or container' }];
      if (m[2] === 'connect') { n.containers.add(c.name); c.networks.add(n.name); return [200, null]; }
      if (!n.containers.has(c.name)) return [404, { message: `container ${c.name} is not connected to network ${n.name}` }];
      n.containers.delete(c.name);
      c.networks.delete(n.name);
      return [200, null];
    }
    if (method === 'DELETE' && (m = /^\/networks\/([^/]+)$/.exec(rest))) {
      const n = findN(decodeURIComponent(m[1]));
      if (!n) return [404, { message: 'network not found' }];
      if (n.containers.size > 0) return [403, { message: `error while removing network: network ${n.name} has active endpoints` }];
      networks.delete(n.name);
      return [204, null];
    }
    if (method === 'POST' && rest === '/containers/create') {
      const name = url.searchParams.get('name') ?? '';
      if (containers.has(name)) return [409, { message: `Conflict. The container name "/${name}" is already in use` }];
      if (!images.has(String(b.Image ?? ''))) return [404, { message: `No such image: ${String(b.Image)}` }];
      const net = findN(String(((b.HostConfig ?? {}) as Record<string, unknown>).NetworkMode ?? ''));
      if (!net) return [404, { message: 'network not found' }];
      const c: StubContainer = { id: newId(), name, body: b, status: 'created', exitCode: 0, oom: false, health: undefined, networks: new Set([net.name]) };
      net.containers.add(name);
      containers.set(name, c);
      return [201, { Id: c.id, Warnings: [] }];
    }
    if (method === 'POST' && (m = /^\/containers\/([^/]+)\/start$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      if (!c) return [404, { message: 'No such container' }];
      if (c.status === 'running') return [304, null];
      c.status = 'running';
      c.health = images.get(String(c.body.Image))?.healthcheck ? 'starting' : undefined;
      return [204, null];
    }
    if (method === 'GET' && (m = /^\/containers\/([^/]+)\/json$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      return c ? [200, inspect(c)] : [404, { message: 'No such container' }];
    }
    if (method === 'DELETE' && (m = /^\/containers\/([^/]+)$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      if (!c) return [404, { message: 'No such container' }];
      for (const n of c.networks) networks.get(n)?.containers.delete(c.name);
      containers.delete(c.name);
      return [204, null];
    }
    if (method === 'GET' && rest === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] };
      const wanted = (filters.label ?? []).map((l) => l.split('='));
      const all = url.searchParams.get('all') === 'true';
      const list = [...containers.values()].filter((c) => {
        const labels = (c.body.Labels ?? {}) as Record<string, string>;
        return (all || c.status === 'running') && wanted.every(([k, v]) => (v === undefined ? k in labels : labels[k] === v));
      });
      return [200, list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.body.Labels ?? {}, State: c.status, Status: c.status }))];
    }
    return undefined;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (d: string) => { raw += d; }).on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      let body: unknown;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      const call: StubCall = { method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body };
      calls.push(call);
      const f = failures.findIndex((x) => x.method === call.method && x.path.test(url.pathname));
      let out: [number, unknown] | undefined;
      if (f >= 0) {
        const [fail] = failures.splice(f, 1);
        out = [fail.status, { message: `stub failure ${fail.status}` }];
      } else {
        out = handle(call.method, url, body);
      }
      if (out === undefined) { unexpected.push(call); out = [404, { message: 'page not found' }]; }
      const [status, payload] = out;
      if (payload === null) { res.writeHead(status).end(); return; }
      if (typeof payload === 'string') { res.writeHead(status, { 'content-type': 'text/plain' }).end(payload); return; }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, calls, unexpected, images,
    container: findC, containers: () => [...containers.values()],
    network: findN, networks: () => [...networks.values()],
    setHealth(name, health) { const c = findC(name); if (c) c.health = health; },
    exit(name, code, oom = false) { const c = findC(name); if (c) { c.status = 'exited'; c.exitCode = code; c.oom = oom; c.health = undefined; } },
    failNext(method, path, status) { failures.push({ method, path, status }); },
    addContainer,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
```

Create `tests/warden-docker.spec.ts`:

```ts
// The warden's Docker Engine API client (src/warden/docker.ts) against the stub Engine: versioned container and network
// endpoints only, the Engine's status codes turned into DockerError, 404 on removal tolerated (idempotent stop).
import { describe, it, expect, afterEach } from 'vitest';
import { createDockerClient, DOCKER_API, DockerError } from '../src/warden/docker.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';

const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });
async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  stub.images.set('img@sha256:x', { healthcheck: true });
  return { stub, docker: createDockerClient(stub.url) };
}

describe('createDockerClient', () => {
  it('creates a network and a container on it, starts it, inspects it, lists it by label, removes both', async () => {
    const { stub, docker } = await setup();
    await docker.ping();
    expect(await docker.createNetwork({ Name: 'net-a', Internal: true })).toMatch(/^[0-9a-f]{64}$/);
    await docker.createContainer('box-a', { Image: 'img@sha256:x', Labels: { 'hvwa.range': '1' }, HostConfig: { NetworkMode: 'net-a' } });
    await docker.startContainer('box-a');
    await docker.startContainer('box-a'); // 304: already running is fine
    const info = await docker.inspectContainer('box-a');
    expect(info?.State).toMatchObject({ Status: 'running', Running: true, Health: { Status: 'starting' } });
    expect((await docker.listContainers('hvwa.range=1')).map((c) => c.Names[0])).toEqual(['/box-a']);
    expect(await docker.listContainers('hvwa.range=2')).toEqual([]);
    await docker.removeContainer('box-a');
    await docker.removeContainer('box-a'); // 404: already gone is fine
    expect(await docker.inspectContainer('box-a')).toBeUndefined();
    await docker.removeNetwork('net-a');
    await docker.removeNetwork('net-a');
    expect(stub.networks()).toEqual([]);
    expect(stub.unexpected).toEqual([]);
    for (const c of stub.calls) expect(c.path, c.path).toMatch(new RegExp(`^(/_ping|${DOCKER_API.replace('.', '\\.')}/(containers|networks)[/?])`));
  });

  it('turns Engine errors into DockerError with the status and the Engine\'s message', async () => {
    const { stub, docker } = await setup();
    await docker.createNetwork({ Name: 'net-b' });
    await expect(docker.createNetwork({ Name: 'net-b' })).rejects.toMatchObject({ name: 'DockerError', status: 409 });
    await expect(docker.createContainer('box-b', { Image: 'missing@sha256:y', HostConfig: { NetworkMode: 'net-b' } }))
      .rejects.toThrow(/No such image/);
    stub.addContainer('peer');
    await docker.connectNetwork('net-b', 'peer');
    await expect(docker.removeNetwork('net-b')).rejects.toMatchObject({ status: 403 });
    await docker.disconnectNetwork('net-b', 'peer');
    await docker.disconnectNetwork('net-b', 'peer'); // not connected any more: tolerated
    await docker.removeNetwork('net-b');
  });

  it('an unreachable Engine is a DockerError with status 0, never an unhandled fetch error', async () => {
    const { stub } = await setup();
    const url = stub.url;
    await stub.close();
    stubs.length = 0;
    const err = await createDockerClient(url, { timeoutMs: 2000 }).ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/warden-docker.spec.ts`
Expected: FAIL — `src/warden/docker.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/warden/protocol.ts`:

```ts
// src/warden/protocol.ts — the warden's API contract, shared by the warden (src/warden/server.ts) and the portal's client
// (src/range/warden-client.ts). The portal passes only what identifies an instance; the container's configuration is
// fixed inside the warden (template.ts) and nothing here can change it (spec range §3, §7; plan decision D1).
import { z } from 'zod';
import { LEVELS } from '../core/levels.js';
import { LAB_ID_RE } from '../lab-registry.js';
import { INSTANCE_ID_RE } from '../range/ids.js';

/** A range flag (spec §6): HVWA{ + 26 base32 characters + }. */
export const RANGE_FLAG_RE = /^HVWA\{[a-z2-7]{26}\}$/;
/** Shortest HVWA_WARDEN_SECRET. */
export const WARDEN_SECRET_MIN = 32;

/**
 * POST /v1/instances. `userId` and `expiresAt` only become container labels. `.strict()`: an image, a mount, a port or
 * any HostConfig key is refused, not ignored. A flag is required below Divine and refused at Divine (spec §6).
 */
export const launchRequestSchema = z.object({
  labId: z.string().regex(LAB_ID_RE),
  level: z.enum(LEVELS),
  instanceId: z.string().regex(INSTANCE_ID_RE),
  flag: z.string().regex(RANGE_FLAG_RE).optional(),
  userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine((r) => (r.level === 'divine') === (r.flag === undefined), {
  message: 'a flag is required below Divine and refused at Divine', path: ['flag'],
});
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export const HEALTH_STATUSES = Object.freeze(['starting', 'ready', 'failed', 'missing'] as const);
export type HealthStatus = (typeof HEALTH_STATUSES)[number];
export const instanceHealthSchema = z.object({ status: z.enum(HEALTH_STATUSES), reason: z.string().max(40).optional() }).strict();
export type InstanceHealth = z.infer<typeof instanceHealthSchema>;

export const listedInstanceSchema = z.object({
  instanceId: z.string().regex(INSTANCE_ID_RE),
  labId: z.string().max(10),
  level: z.string().max(20),
  userId: z.number().int(),
  expiresAt: z.number().int(),
  state: z.string().max(20),
}).strict();
export type ListedInstance = z.infer<typeof listedInstanceSchema>;
export const listResponseSchema = z.object({ instances: z.array(listedInstanceSchema) }).strict();

/** What the portal needs from the warden (src/range/warden-client.ts over HTTP; tests/support/fake-warden.ts in tests). */
export interface WardenApi {
  /** Create the network, the container (fixed template), connect Traefik, start. Resolves when started. */
  launch(req: LaunchRequest): Promise<void>;
  /** Remove the container, disconnect Traefik, remove the network. Idempotent. */
  stop(instanceId: string): Promise<void>;
  /** Every container labelled hvwa.range=1. */
  list(): Promise<ListedInstance[]>;
  /** The container's state as the portal needs it: starting, ready (health check passed), failed (reason), missing. */
  health(instanceId: string): Promise<InstanceHealth>;
}

/** Codes a warden call can fail with; the portal stores them as an instance's failure reason. */
export const WARDEN_ERROR_CODES = Object.freeze(
  ['bad_request', 'unknown_lab', 'bad_level', 'exists', 'docker', 'unauthorized', 'unavailable'] as const);
export type WardenErrorCode = (typeof WARDEN_ERROR_CODES)[number];

export class WardenError extends Error {
  constructor(readonly code: WardenErrorCode, readonly status: number) {
    super(`warden: ${code}`);
    this.name = 'WardenError';
  }
}
```

Create `src/warden/docker.ts`:

```ts
// src/warden/docker.ts — the warden's Docker Engine API client: plain HTTP to the write-limited socket proxy
// (tecnativa/docker-socket-proxy with CONTAINERS=1, NETWORKS=1, POST=1 and every other section off). Only container and
// network endpoints, versioned /v1.44 (Engine 25+; Engine 29 refuses anything older). Never images, exec, volumes,
// swarm or system: the proxy refuses them too, and tests/warden-ops.spec.ts proves the warden never asks.
export const DOCKER_API = '/v1.44';

export class DockerError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(`docker ${status} ${path}: ${message}`);
    this.name = 'DockerError';
  }
}

export interface ContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly State: {
    readonly Status: string; readonly Running: boolean; readonly ExitCode: number; readonly OOMKilled: boolean;
    readonly Health?: { readonly Status: string };
  };
  readonly Config: { readonly Image: string; readonly Labels: Record<string, string> | null };
  readonly HostConfig: Record<string, unknown>;
}

export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Record<string, string>;
  readonly State: string;
}

export interface DockerClient {
  ping(): Promise<void>;
  createNetwork(body: object): Promise<string>;
  removeNetwork(nameOrId: string): Promise<void>;
  connectNetwork(network: string, container: string): Promise<void>;
  disconnectNetwork(network: string, container: string): Promise<void>;
  createContainer(name: string, body: object): Promise<string>;
  startContainer(nameOrId: string): Promise<void>;
  removeContainer(nameOrId: string): Promise<void>;
  inspectContainer(nameOrId: string): Promise<ContainerInspect | undefined>;
  listContainers(label: string): Promise<ContainerSummary[]>;
}

export function createDockerClient(baseUrl: string, opts: { timeoutMs?: number } = {}): DockerClient {
  const root = baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body: object | undefined, ok: readonly number[]): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new DockerError(0, path, err instanceof Error ? err.message : String(err));
    }
    const text = await res.text();
    let json: unknown;
    try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
    if (!ok.includes(res.status)) {
      const message = (json as { message?: unknown } | undefined)?.message;
      throw new DockerError(res.status, path, typeof message === 'string' ? message : text.slice(0, 200));
    }
    return { status: res.status, json };
  }

  const idOf = (path: string, json: unknown): string => {
    const id = (json as { Id?: unknown } | undefined)?.Id;
    if (typeof id !== 'string') throw new DockerError(500, path, 'no Id in the answer');
    return id;
  };

  return Object.freeze({
    async ping() { await call('GET', '/_ping', undefined, [200]); },
    async createNetwork(body: object) {
      const path = `${DOCKER_API}/networks/create`;
      return idOf(path, (await call('POST', path, body, [201])).json);
    },
    async removeNetwork(name: string) { await call('DELETE', `${DOCKER_API}/networks/${enc(name)}`, undefined, [204, 404]); },
    async connectNetwork(network: string, container: string) {
      await call('POST', `${DOCKER_API}/networks/${enc(network)}/connect`, { Container: container }, [200]);
    },
    async disconnectNetwork(network: string, container: string) {
      await call('POST', `${DOCKER_API}/networks/${enc(network)}/disconnect`, { Container: container, Force: true }, [200, 404]);
    },
    async createContainer(name: string, body: object) {
      const path = `${DOCKER_API}/containers/create?name=${enc(name)}`;
      return idOf(path, (await call('POST', path, body, [201])).json);
    },
    async startContainer(name: string) { await call('POST', `${DOCKER_API}/containers/${enc(name)}/start`, undefined, [204, 304]); },
    async removeContainer(name: string) { await call('DELETE', `${DOCKER_API}/containers/${enc(name)}?force=true&v=true`, undefined, [204, 404]); },
    async inspectContainer(name: string) {
      const r = await call('GET', `${DOCKER_API}/containers/${enc(name)}/json`, undefined, [200, 404]);
      return r.status === 404 ? undefined : r.json as ContainerInspect;
    },
    async listContainers(label: string) {
      const filters = enc(JSON.stringify({ label: [label] }));
      return (await call('GET', `${DOCKER_API}/containers/json?all=true&filters=${filters}`, undefined, [200])).json as ContainerSummary[];
    },
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/warden-docker.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/warden/protocol.ts src/warden/docker.ts tests/support/docker-stub.ts tests/warden-docker.spec.ts
git commit -m "feat(warden): API contract, Docker Engine client (containers + networks only), stub Engine for tests"
```

---

### Task 12: The fixed container template (spec §7) and the per-instance network

**Files:**
- Create: `src/warden/template.ts`
- Test: `tests/warden-template.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/warden-template.spec.ts`:

```ts
// THE container configuration of every range instance (src/warden/template.ts, spec range §7), pinned field by field:
// a change here is a security change. And the instance's own network: internal, isolated gateway, labelled.
import { describe, it, expect } from 'vitest';
import { parseRegistry } from '../src/lab-registry.js';
import { containerSpec, LAB_USER, networkSpec } from '../src/warden/template.js';
import { labEntry, testRegistry } from './support/range.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const SETTINGS = { domain: 'hvwa.my.id', runtime: 'runc' as const };
const MIB = 1024 * 1024;

describe('containerSpec', () => {
  it('is exactly spec §7 for a lab with the default limits', () => {
    const lab = testRegistry().get('r01')!;
    const { name, body } = containerSpec({ lab, level: 'templar', instanceId: ID, flag: FLAG, userId: 7, expiresAt: 1_800_000_000_000 }, SETTINGS);
    expect(name).toBe(`hvwa-i-${ID}`);
    expect(body).toEqual({
      Image: lab.image,
      User: '10001:10001',
      Env: ['HVWA_LEVEL=templar', 'HVWA_PORT=8080', `HVWA_INSTANCE_HOST=i-${ID}.hvwa.my.id`, 'HOME=/tmp', `HVWA_FLAG=${FLAG}`],
      Labels: {
        'hvwa.range': '1', 'hvwa.instance': ID, 'hvwa.user': '7', 'hvwa.lab': 'r01', 'hvwa.level': 'templar', 'hvwa.expires': '1800000000000',
        'traefik.enable': 'true',
        'traefik.docker.network': `hvwa-i-${ID}`,
        [`traefik.http.routers.i-${ID}.rule`]: `Host(\`i-${ID}.hvwa.my.id\`)`,
        [`traefik.http.routers.i-${ID}.priority`]: '10',
        [`traefik.http.routers.i-${ID}.middlewares`]: 'hvwa-instance@file',
        [`traefik.http.routers.i-${ID}.service`]: `i-${ID}`,
        [`traefik.http.services.i-${ID}.loadbalancer.server.port`]: '8080',
        [`traefik.http.routers.g-${ID}.rule`]: `Host(\`i-${ID}.hvwa.my.id\`) && PathPrefix(\`/__hvwa/\`)`,
        [`traefik.http.routers.g-${ID}.priority`]: '1000',
        [`traefik.http.routers.g-${ID}.service`]: 'hvwa-portal@file',
      },
      Healthcheck: { Test: [], Interval: 2_000_000_000, Timeout: 2_000_000_000, Retries: 3, StartPeriod: 60_000_000_000, StartInterval: 500_000_000 },
      StopTimeout: 2,
      HostConfig: {
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=64m' },
        CapDrop: ['ALL'],
        CapAdd: [],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PidsLimit: 128,
        Memory: 256 * MIB,
        MemorySwap: 256 * MIB,
        NanoCpus: 500_000_000,
        NetworkMode: `hvwa-i-${ID}`,
        PortBindings: {},
        PublishAllPorts: false,
        Binds: [],
        Mounts: [],
        VolumesFrom: [],
        Devices: [],
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Runtime: 'runc',
        IpcMode: 'private',
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
      NetworkingConfig: { EndpointsConfig: { [`hvwa-i-${ID}`]: {} } },
    });
  });

  it('spec §7 row by row: non-root, read-only, no capabilities, no new privileges, default seccomp, no swap, no mounts, no ports', () => {
    const { body } = containerSpec({ lab: testRegistry().get('r01')!, level: 'acolyte', instanceId: ID, flag: FLAG, userId: 1, expiresAt: 1 }, SETTINGS);
    const hc = body.HostConfig as Record<string, unknown>;
    expect(Number(LAB_USER.split(':')[0])).toBeGreaterThanOrEqual(1000);
    expect(hc.ReadonlyRootfs).toBe(true);
    expect(hc.CapDrop).toEqual(['ALL']);
    expect(hc.CapAdd).toEqual([]);
    expect(hc.SecurityOpt).toEqual(['no-new-privileges:true']); // nothing like seccomp=unconfined: Docker's default profile applies
    expect(hc.MemorySwap).toBe(hc.Memory);
    expect([hc.Binds, hc.Mounts, hc.Devices, hc.VolumesFrom]).toEqual([[], [], [], []]);
    expect([hc.PortBindings, hc.PublishAllPorts]).toEqual([{}, false]);
    expect(hc.RestartPolicy).toEqual({ Name: 'no', MaximumRetryCount: 0 });
  });

  it('a manifest may only lower the limits; its tmpfs list is used; Divine gets no HVWA_FLAG; runsc when asked', () => {
    const lab = parseRegistry({ schema: 1, labs: [labEntry('r05', 'beacon', {
      port: 3000, resources: { memoryMiB: 128, pids: 64, cpus: 0.25 }, tmpfs: [{ path: '/tmp', sizeMiB: 16 }, { path: '/var/run/beacon', sizeMiB: 8 }],
    })] }).get('r05')!;
    const { body } = containerSpec({ lab, level: 'divine', instanceId: ID, userId: 2, expiresAt: 3 }, { domain: 'localhost', runtime: 'runsc' });
    const hc = body.HostConfig as Record<string, unknown>;
    expect([hc.Memory, hc.MemorySwap, hc.PidsLimit, hc.NanoCpus, hc.Runtime]).toEqual([128 * MIB, 128 * MIB, 64, 250_000_000, 'runsc']);
    expect(hc.Tmpfs).toEqual({ '/tmp': 'rw,noexec,nosuid,nodev,size=16m', '/var/run/beacon': 'rw,noexec,nosuid,nodev,size=8m' });
    expect(body.Env).toEqual(['HVWA_LEVEL=divine', 'HVWA_PORT=3000', `HVWA_INSTANCE_HOST=i-${ID}.localhost`, 'HOME=/tmp']);
    expect((body.Labels as Record<string, string>)[`traefik.http.services.i-${ID}.loadbalancer.server.port`]).toBe('3000');
  });
});

describe('networkSpec', () => {
  it('one internal bridge per instance, no host address on it, labelled for reconcile', () => {
    expect(networkSpec(ID)).toEqual({
      Name: `hvwa-i-${ID}`, Driver: 'bridge', Internal: true, Attachable: false, EnableIPv6: false,
      Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Labels: { 'hvwa.range': '1', 'hvwa.instance': ID },
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/warden-template.spec.ts`
Expected: FAIL — `src/warden/template.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/warden/template.ts`:

```ts
// src/warden/template.ts — THE configuration of every range instance container (spec range §7) and of its network.
// Fixed here: the portal passes only identifiers (protocol.ts); the image comes from the registry, pinned by digest;
// a manifest may only lower the limits (src/lab-registry.ts caps them). tests/warden-template.spec.ts pins every field.
//
// Network: its own `internal` bridge (no default route: no egress, no other instance, no portal), with an isolated
// gateway (the host gets no address on it), shared only with Traefik, which the warden connects after creating it.
// Traefik's only entrypoint listens on its hvwa-edge address (the tunnel's side) only, so the instance finds nothing
// listening on its side either.
import type { Level } from '../core/levels.js';
import { LAB_LIMITS, type LabEntry } from '../lab-registry.js';

/** Every lab process runs as this uid:gid (spec §7: non-root, uid >= 1000). HOME is /tmp (the rootfs is read-only). */
export const LAB_USER = '10001:10001';
export const RANGE_LABEL = 'hvwa.range';
export const RUNTIMES = Object.freeze(['runc', 'runsc'] as const);
export type Runtime = (typeof RUNTIMES)[number];
export interface TemplateSettings {
  /** HVWA_RANGE_DOMAIN: the lab answers at i-<instanceId>.<domain>. */
  readonly domain: string;
  /** HVWA_RANGE_RUNTIME: runc, or runsc (gVisor) where installed; the POC host requires runsc (always written as HostConfig.Runtime). */
  readonly runtime: Runtime;
}

const MIB = 1024 * 1024;
/** The container and its network share one name. */
export const instanceResourceName = (instanceId: string) => `hvwa-i-${instanceId}`;

export function networkSpec(instanceId: string) {
  return {
    Name: instanceResourceName(instanceId),
    Driver: 'bridge',
    Internal: true,
    Attachable: false,
    EnableIPv6: false,
    Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
    Labels: { [RANGE_LABEL]: '1', 'hvwa.instance': instanceId },
  };
}

export interface InstanceSpecInput {
  readonly lab: LabEntry;
  readonly level: Level;
  readonly instanceId: string;
  /** Absent at Divine. */
  readonly flag?: string;
  readonly userId: number;
  readonly expiresAt: number;
}

export function containerSpec(input: InstanceSpecInput, settings: TemplateSettings): { name: string; body: Record<string, unknown> } {
  const { lab, level, instanceId, flag, userId, expiresAt } = input;
  const name = instanceResourceName(instanceId);
  const host = `i-${instanceId}.${settings.domain}`;
  const memory = Math.min(lab.resources.memoryMiB ?? LAB_LIMITS.memoryMiB, LAB_LIMITS.memoryMiB) * MIB;
  const pids = Math.min(lab.resources.pids ?? LAB_LIMITS.pids, LAB_LIMITS.pids);
  const nanoCpus = Math.round(Math.min(lab.resources.cpus ?? LAB_LIMITS.cpus, LAB_LIMITS.cpus) * 1e9);
  const router = `i-${instanceId}`;
  const gate = `g-${instanceId}`;
  return {
    name,
    body: {
      Image: lab.image,
      User: LAB_USER,
      // The flag only below Divine; the lab's start hook plants it and removes it from its environment (spec §6).
      Env: [`HVWA_LEVEL=${level}`, `HVWA_PORT=${lab.port}`, `HVWA_INSTANCE_HOST=${host}`, 'HOME=/tmp',
        ...(flag === undefined ? [] : [`HVWA_FLAG=${flag}`])],
      Labels: {
        [RANGE_LABEL]: '1', 'hvwa.instance': instanceId, 'hvwa.user': String(userId), 'hvwa.lab': lab.id, 'hvwa.level': level,
        'hvwa.expires': String(expiresAt),
        'traefik.enable': 'true',
        'traefik.docker.network': name,
        // The lab, behind forward-auth (docker/range/traefik/range.yml: hvwa-instance = secret header + forwardAuth + strip).
        [`traefik.http.routers.${router}.rule`]: `Host(\`${host}\`)`,
        [`traefik.http.routers.${router}.priority`]: '10',
        [`traefik.http.routers.${router}.middlewares`]: 'hvwa-instance@file',
        [`traefik.http.routers.${router}.service`]: router,
        [`traefik.http.services.${router}.loadbalancer.server.port`]: String(lab.port),
        // /__hvwa/* on this host goes to the portal (the gate-ticket exchange), WITHOUT forward-auth, ahead of the lab.
        [`traefik.http.routers.${gate}.rule`]: `Host(\`${host}\`) && PathPrefix(\`/__hvwa/\`)`,
        [`traefik.http.routers.${gate}.priority`]: '1000',
        [`traefik.http.routers.${gate}.service`]: 'hvwa-portal@file',
      },
      // Test [] = the image's own HEALTHCHECK (it requests the manifest's health path); the timings are ours (plan D2).
      Healthcheck: { Test: [], Interval: 2_000_000_000, Timeout: 2_000_000_000, Retries: 3, StartPeriod: 60_000_000_000, StartInterval: 500_000_000 },
      StopTimeout: 2,
      HostConfig: {
        ReadonlyRootfs: true,
        Tmpfs: Object.fromEntries(lab.tmpfs.map((t) => [t.path, `rw,noexec,nosuid,nodev,size=${t.sizeMiB}m`])),
        CapDrop: ['ALL'],
        CapAdd: [],
        SecurityOpt: ['no-new-privileges:true'],
        Privileged: false,
        PidsLimit: pids,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: nanoCpus,
        NetworkMode: name,
        PortBindings: {},
        PublishAllPorts: false,
        Binds: [],
        Mounts: [],
        VolumesFrom: [],
        Devices: [],
        RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
        Runtime: settings.runtime,
        IpcMode: 'private',
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } },
      },
      NetworkingConfig: { EndpointsConfig: { [name]: {} } },
    },
  };
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/warden-template.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/warden/template.ts tests/warden-template.spec.ts
git commit -m "feat(warden): the fixed hardened container template and the per-instance internal network"
```

---

### Task 13: Warden operations: launch / stop / list / health, with the image allowlist

**Files:**
- Create: `src/warden/warden.ts`
- Test: `tests/warden-ops.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/warden-ops.spec.ts`:

```ts
// The warden's operations (src/warden/warden.ts) against the stub Engine: launch builds the network, the container from
// the registry's digest-pinned image with the fixed template, connects Traefik and starts it, and cleans up after any
// failure; stop is idempotent; list and health read labels and State.Health. Only container and network endpoints.
import { describe, it, expect, afterEach } from 'vitest';
import { createDockerClient, DOCKER_API } from '../src/warden/docker.js';
import { containerSpec, networkSpec } from '../src/warden/template.js';
import { createWarden } from '../src/warden/warden.js';
import { WardenError, type LaunchRequest } from '../src/warden/protocol.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const ID2 = 'zyxwvutsrqponmlkjihgfedcba';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const SETTINGS = { domain: 'hvwa.my.id', runtime: 'runc' as const, traefikContainer: 'hvwa-range-traefik' };
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });

async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: SETTINGS });
  return { stub, warden, registry };
}
const req = (over: Partial<LaunchRequest> = {}): LaunchRequest =>
  ({ labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 7, expiresAt: 1_800_000_000_000, ...over });

describe('launch', () => {
  it('network, container (template, registry image), Traefik connected, started: in that order', async () => {
    const { stub, warden, registry } = await setup();
    await warden.launch(req());
    const writes = stub.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.split('?')[0]}`);
    expect(writes).toEqual([
      `POST ${DOCKER_API}/networks/create`,
      `POST ${DOCKER_API}/containers/create`,
      `POST ${DOCKER_API}/networks/hvwa-i-${ID}/connect`,
      `POST ${DOCKER_API}/containers/hvwa-i-${ID}/start`,
    ]);
    expect(stub.calls.find((c) => c.path.startsWith(`${DOCKER_API}/networks/create`))?.body).toEqual(networkSpec(ID));
    const lab = registry.get('r01')!;
    const { body } = containerSpec({ lab, level: 'acolyte', instanceId: ID, flag: FLAG, userId: 7, expiresAt: 1_800_000_000_000 }, SETTINGS);
    expect(stub.container(`hvwa-i-${ID}`)?.body).toEqual(body);
    expect([...stub.network(`hvwa-i-${ID}`)!.containers].sort()).toEqual(['hvwa-range-traefik', `hvwa-i-${ID}`].sort());
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
  });

  it('refuses what the registry does not allow, before touching Docker: unknown lab, level, flag rules, extra keys', async () => {
    const { stub, warden } = await setup();
    const cases: [unknown, string][] = [
      [req({ labId: 'r42' }), 'unknown_lab'],
      [req({ labId: 'r02', level: 'templar' }), 'bad_level'],
      [req({ level: 'divine' }), 'bad_request'],                 // a flag at Divine
      [{ ...req(), flag: undefined }, 'bad_request'],             // no flag below Divine
      [{ ...req(), image: 'alpine:latest' }, 'bad_request'],
      [{ ...req(), HostConfig: { Privileged: true } }, 'bad_request'],
      [req({ instanceId: '../../etc' }), 'bad_request'],
    ];
    for (const [body, code] of cases) {
      await expect(warden.launch(body as LaunchRequest), code).rejects.toMatchObject({ code });
    }
    expect(stub.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('an existing instance is 409 "exists"; a Docker failure midway is "docker" and leaves nothing behind', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await expect(warden.launch(req())).rejects.toMatchObject({ code: 'exists', status: 409 });
    stub.failNext('POST', /\/containers\/[^/]+\/start$/, 500);
    await expect(warden.launch(req({ instanceId: ID2 }))).rejects.toMatchObject({ code: 'docker', status: 502 });
    expect(stub.container(`hvwa-i-${ID2}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID2}`)).toBeUndefined();
    expect([...stub.container('hvwa-range-traefik')!.networks]).toEqual([`hvwa-i-${ID}`]);
  });

  it('a lab whose image is not on the host fails as "docker" and cleans up', async () => {
    const { stub, warden } = await setup();
    stub.images.clear();
    await expect(warden.launch(req())).rejects.toBeInstanceOf(WardenError);
    expect(stub.networks()).toEqual([]);
  });
});

describe('stop, list, health', () => {
  it('stop removes the container, disconnects Traefik, removes the network; twice is fine; a bad id is refused', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await warden.stop(ID);
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
    expect(stub.network(`hvwa-i-${ID}`)).toBeUndefined();
    expect([...stub.container('hvwa-range-traefik')!.networks]).toEqual([]);
    await warden.stop(ID);
    await expect(warden.stop('nope')).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('list reads only hvwa.range=1 containers, from their labels', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    stub.addContainer('unrelated', { 'other.label': 'x' });
    expect(await warden.list()).toEqual([{ instanceId: ID, labId: 'r01', level: 'acolyte', userId: 7, expiresAt: 1_800_000_000_000, state: 'running' }]);
  });

  it('health: starting, then ready once the image\'s health check passes; failed (unhealthy, exited, oom, no_healthcheck); missing', async () => {
    const { stub, warden, registry } = await setup();
    await warden.launch(req());
    expect(await warden.health(ID)).toEqual({ status: 'starting' });
    stub.setHealth(`hvwa-i-${ID}`, 'healthy');
    expect(await warden.health(ID)).toEqual({ status: 'ready' });
    stub.setHealth(`hvwa-i-${ID}`, 'unhealthy');
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'unhealthy' });
    stub.exit(`hvwa-i-${ID}`, 137, true);
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'oom' });
    stub.exit(`hvwa-i-${ID}`, 1);
    expect(await warden.health(ID)).toEqual({ status: 'failed', reason: 'exited' });
    stub.images.set(registry.get('r02')!.image, { healthcheck: false });
    await warden.launch(req({ instanceId: ID2, labId: 'r02', level: 'acolyte' }));
    expect(await warden.health(ID2)).toEqual({ status: 'failed', reason: 'no_healthcheck' });
    expect(await warden.health('a'.repeat(26))).toEqual({ status: 'missing' });
  });

  it('never calls anything but containers, networks and _ping', async () => {
    const { stub, warden } = await setup();
    await warden.launch(req());
    await warden.health(ID);
    await warden.list();
    await warden.stop(ID);
    expect(stub.unexpected).toEqual([]);
    for (const c of stub.calls) expect(c.path).toMatch(/^(\/_ping|\/v1\.44\/(containers|networks)[/?])/);
    expect(stub.calls.some((c) => /\/(images|exec|volumes|swarm|system|build|plugins|secrets|configs)\b/.test(c.path))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/warden-ops.spec.ts`
Expected: FAIL — `src/warden/warden.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/warden/warden.ts`:

```ts
// src/warden/warden.ts — the warden's operations (spec range §3, §5.2): the only code that creates or removes lab
// containers. The image allowlist is the registry: a lab id selects its digest-pinned image; anything else is refused
// before Docker is touched. A failed launch leaves nothing behind.
import { INSTANCE_ID_RE } from '../range/ids.js';
import type { LabRegistry } from '../lab-registry.js';
import { DockerError, type ContainerInspect, type ContainerSummary, type DockerClient } from './docker.js';
import { launchRequestSchema, WardenError, type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi } from './protocol.js';
import { containerSpec, instanceResourceName, networkSpec, RANGE_LABEL, type TemplateSettings } from './template.js';

export interface WardenSettings extends TemplateSettings {
  /** The Traefik container the warden connects to every instance network (compose: container_name). */
  readonly traefikContainer: string;
}

export interface WardenDeps {
  readonly docker: DockerClient;
  readonly registry: LabRegistry;
  readonly settings: WardenSettings;
  /** One line per launch / stop (never a flag). Default: silent. */
  readonly log?: (line: string) => void;
}

export function createWarden(deps: WardenDeps): WardenApi {
  const { docker, registry, settings } = deps;
  const log = deps.log ?? (() => {});

  /** Container, then Traefik's endpoint, then the network (Docker refuses to remove a network with endpoints). */
  async function cleanup(instanceId: string): Promise<void> {
    const name = instanceResourceName(instanceId);
    await docker.removeContainer(name);
    try { await docker.disconnectNetwork(name, settings.traefikContainer); } catch (err) { if (!(err instanceof DockerError)) throw err; }
    await docker.removeNetwork(name);
  }

  return Object.freeze({
    async launch(raw: LaunchRequest): Promise<void> {
      const parsed = launchRequestSchema.safeParse(raw);
      if (!parsed.success) throw new WardenError('bad_request', 400);
      const r = parsed.data;
      const lab = registry.get(r.labId);
      if (!lab) throw new WardenError('unknown_lab', 404);
      if (!lab.levels.includes(r.level)) throw new WardenError('bad_level', 400);
      const name = instanceResourceName(r.instanceId);
      try {
        if (await docker.inspectContainer(name)) throw new WardenError('exists', 409);
        const spec = containerSpec({ lab, level: r.level, instanceId: r.instanceId, flag: r.flag, userId: r.userId, expiresAt: r.expiresAt }, settings);
        await docker.createNetwork(networkSpec(r.instanceId));
        await docker.createContainer(spec.name, spec.body);
        await docker.connectNetwork(name, settings.traefikContainer);
        await docker.startContainer(name);
        log(`warden: launched ${r.instanceId} ${r.labId}/${r.level} for user ${r.userId}`);
      } catch (err) {
        if (err instanceof WardenError) throw err;
        await cleanup(r.instanceId).catch(() => { /* the portal's reaper removes leftovers */ });
        log(`warden: launch of ${r.instanceId} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw new WardenError('docker', 502);
      }
    },

    async stop(instanceId: string): Promise<void> {
      if (!INSTANCE_ID_RE.test(instanceId)) throw new WardenError('bad_request', 400);
      try {
        await cleanup(instanceId);
      } catch (err) {
        if (err instanceof DockerError) throw new WardenError('docker', 502);
        throw err;
      }
      log(`warden: stopped ${instanceId}`);
    },

    async list(): Promise<ListedInstance[]> {
      let found: ContainerSummary[];
      try { found = await docker.listContainers(`${RANGE_LABEL}=1`); } catch { throw new WardenError('docker', 502); }
      return found.flatMap((c) => {
        const l = c.Labels ?? {};
        const instanceId = l['hvwa.instance'] ?? '';
        if (!INSTANCE_ID_RE.test(instanceId)) return [];
        return [{
          instanceId, labId: String(l['hvwa.lab'] ?? '').slice(0, 10), level: String(l['hvwa.level'] ?? '').slice(0, 20),
          userId: Number.parseInt(l['hvwa.user'] ?? '0', 10) || 0, expiresAt: Number.parseInt(l['hvwa.expires'] ?? '0', 10) || 0,
          state: String(c.State).slice(0, 20),
        }];
      });
    },

    async health(instanceId: string): Promise<InstanceHealth> {
      if (!INSTANCE_ID_RE.test(instanceId)) throw new WardenError('bad_request', 400);
      let c: ContainerInspect | undefined;
      try { c = await docker.inspectContainer(instanceResourceName(instanceId)); } catch { throw new WardenError('docker', 502); }
      if (!c) return { status: 'missing' };
      const s = c.State;
      if (s.Status === 'running') {
        const h = s.Health?.Status;
        if (h === 'healthy') return { status: 'ready' };
        if (h === 'starting') return { status: 'starting' };
        if (h === 'unhealthy') return { status: 'failed', reason: 'unhealthy' };
        return { status: 'failed', reason: 'no_healthcheck' }; // the image declares no HEALTHCHECK (plan D2)
      }
      if (s.Status === 'created' || s.Status === 'restarting') return { status: 'starting' };
      return { status: 'failed', reason: s.OOMKilled ? 'oom' : 'exited' };
    },
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/warden-ops.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/warden/warden.ts tests/warden-ops.spec.ts
git commit -m "feat(warden): launch/stop/list/health with the registry image allowlist and cleanup on failure"
```

---

### Task 14: The warden API server (shared secret), its configuration and entry point

**Files:**
- Create: `src/warden/server.ts`, `src/warden/config.ts`, `src/warden/main.ts`
- Test: `tests/warden-server.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/warden-server.spec.ts`:

```ts
// The warden's HTTP API (src/warden/server.ts) and environment (src/warden/config.ts): a bearer shared secret on every
// /v1 route (constant-time), strict small bodies, error codes the portal understands; the secret is never echoed.
import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { loadWardenConfig } from '../src/warden/config.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';

const SECRET = 's'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });

async function setup() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'hvwa.my.id', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
  return { stub, app: createWardenServer({ warden, secret: SECRET }) };
}
const auth = { authorization: `Bearer ${SECRET}` };
const body = { labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 3, expiresAt: 1_800_000_000_000 };

describe('createWardenServer', () => {
  it('/healthz is open; every /v1 route needs the exact bearer secret (401 otherwise, same body)', async () => {
    const { app } = await setup();
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    for (const headers of [{}, { authorization: SECRET }, { authorization: `Bearer ${SECRET}x` }, { authorization: 'Bearer ' }, { authorization: `bearer ${SECRET}` }]) {
      const res = await request(app).get('/v1/instances').set(headers);
      expect(res.status, JSON.stringify(headers)).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
    expect((await request(app).post('/v1/instances').send(body)).status).toBe(401);
  });

  it('launch -> 201, list, health, stop -> 204; the container exists in between', async () => {
    const { app, stub } = await setup();
    const launched = await request(app).post('/v1/instances').set(auth).send(body);
    expect(launched.status).toBe(201);
    expect(launched.body).toEqual({ instanceId: ID });
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    expect((await request(app).get('/v1/instances').set(auth)).body.instances).toHaveLength(1);
    expect((await request(app).get(`/v1/instances/${ID}/health`).set(auth)).body).toEqual({ status: 'starting' });
    expect((await request(app).delete(`/v1/instances/${ID}`).set(auth)).status).toBe(204);
    expect(stub.container(`hvwa-i-${ID}`)).toBeUndefined();
  });

  it('refuses extra keys and unknown labs with the closed error codes; a big body is 413; nothing is created', async () => {
    const { app, stub } = await setup();
    const extra = await request(app).post('/v1/instances').set(auth).send({ ...body, HostConfig: { Privileged: true } });
    expect([extra.status, extra.body]).toEqual([400, { error: 'bad_request' }]);
    const unknown = await request(app).post('/v1/instances').set(auth).send({ ...body, labId: 'r77' });
    expect([unknown.status, unknown.body]).toEqual([404, { error: 'unknown_lab' }]);
    expect((await request(app).post('/v1/instances').set(auth).send({ ...body, pad: 'x'.repeat(5000) })).status).toBe(413);
    expect((await request(app).delete('/v1/instances/..%2F..%2Fetc').set(auth)).status).toBe(400);
    expect((await request(app).get('/v1/nope').set(auth)).status).toBe(404);
    expect(stub.containers().map((c) => c.name)).toEqual(['hvwa-range-traefik']);
  });

  it('Docker down is 502 "docker"', async () => {
    const { app, stub } = await setup();
    await stub.close();
    stubs.length = 0;
    const res = await request(app).get('/v1/instances').set(auth);
    expect([res.status, res.body]).toEqual([502, { error: 'docker' }]);
  });
});

describe('loadWardenConfig', () => {
  it('defaults, and the two requirements: the secret (32+) and the domain; the secret is never echoed', () => {
    const r = loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'hvwa.my.id' });
    expect(r).toEqual({ ok: true, config: {
      host: '127.0.0.1', port: 8080, secret: SECRET, dockerUrl: 'http://socket-proxy:2375', registryPath: '/etc/hvwa/registry.json',
      domain: 'hvwa.my.id', traefikContainer: 'hvwa-range-traefik', runtime: 'runc',
    } });
    const bad = loadWardenConfig({ HVWA_WARDEN_SECRET: 'Short-Secret-Value', HVWA_RANGE_DOMAIN: 'hvwa.my.id' });
    expect(bad).toEqual({ ok: false, errors: ['HVWA_WARDEN_SECRET: must be at least 32 characters'] });
    expect(loadWardenConfig({})).toEqual({ ok: false, errors: ['HVWA_WARDEN_SECRET: is required', 'HVWA_RANGE_DOMAIN: is required'] });
    expect(loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'x', HVWA_RANGE_RUNTIME: 'kata' }).ok).toBe(false);
    expect(loadWardenConfig({ HVWA_WARDEN_SECRET: SECRET, HVWA_RANGE_DOMAIN: 'x', HVWA_DOCKER_URL: 'unix:///var/run/docker.sock' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/warden-server.spec.ts`
Expected: FAIL — `src/warden/server.ts` and `src/warden/config.ts` do not exist.

- [ ] **Step 3: Implement**

Create `src/warden/server.ts`:

```ts
// src/warden/server.ts — the warden's HTTP API (spec range §3): reachable on the internal `control` network only, and
// every /v1 route needs `Authorization: Bearer <HVWA_WARDEN_SECRET>` (compared in constant time through SHA-256). The
// JSON parser runs only after the secret and takes 4 KiB at most; the launch schema refuses every key but six ids.
//   POST   /v1/instances               { labId, level, instanceId, flag?, userId, expiresAt } -> 201 { instanceId }
//   DELETE /v1/instances/:id            -> 204 (idempotent)
//   GET    /v1/instances                -> 200 { instances: ListedInstance[] }
//   GET    /v1/instances/:id/health     -> 200 { status, reason? }
//   GET    /healthz                     -> 200 { status: 'ok' } (no secret: compose's health check)
import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { INSTANCE_ID_RE } from '../range/ids.js';
import { DockerError } from './docker.js';
import { WardenError, type LaunchRequest, type WardenApi } from './protocol.js';

export function createWardenServer(opts: { readonly warden: WardenApi; readonly secret: string }): Express {
  const want = createHash('sha256').update(opts.secret, 'utf8').digest();
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });

  const requireSecret: RequestHandler = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : `\u0000${header}`;
    if (timingSafeEqual(createHash('sha256').update(presented, 'utf8').digest(), want)) { next(); return; }
    res.status(401).json({ error: 'unauthorized' });
  };
  app.use(requireSecret);
  app.use(express.json({ limit: '4kb' }));

  const fail = (res: Response, err: unknown) => {
    if (err instanceof WardenError) { res.status(err.status).json({ error: err.code }); return; }
    if (err instanceof DockerError) { res.status(502).json({ error: 'docker' }); return; }
    res.status(500).json({ error: 'internal' });
  };
  const badId = (id: string, res: Response) => {
    if (INSTANCE_ID_RE.test(id)) return false;
    res.status(400).json({ error: 'bad_request' });
    return true;
  };

  app.post('/v1/instances', async (req, res) => {
    try {
      await opts.warden.launch(req.body as LaunchRequest);
      res.status(201).json({ instanceId: (req.body as LaunchRequest).instanceId });
    } catch (err) { fail(res, err); }
  });
  app.delete('/v1/instances/:id', async (req, res) => {
    if (badId(req.params.id, res)) return;
    try { await opts.warden.stop(req.params.id); res.status(204).end(); } catch (err) { fail(res, err); }
  });
  app.get('/v1/instances', async (_req, res) => {
    try { res.json({ instances: await opts.warden.list() }); } catch (err) { fail(res, err); }
  });
  app.get('/v1/instances/:id/health', async (req, res) => {
    if (badId(req.params.id, res)) return;
    try { res.json(await opts.warden.health(req.params.id)); } catch (err) { fail(res, err); }
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    if (status === 413) { res.status(413).json({ error: 'too_large' }); return; }
    res.status(status >= 400 && status < 500 ? 400 : 500).json({ error: status >= 400 && status < 500 ? 'bad_request' : 'internal' });
  };
  app.use(onError);
  return app;
}
```

Create `src/warden/config.ts`:

```ts
// src/warden/config.ts — the warden's environment. The secret is never echoed.
import { z } from 'zod';
import { DOMAIN_RE } from '../range/config.js';
import { WARDEN_SECRET_MIN } from './protocol.js';
import { RUNTIMES } from './template.js';

const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const unset = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blank, s);

const schema = z.object({
  HOST: unset(z.string().trim().min(1).default('127.0.0.1')),
  PORT: unset(z.coerce.number().int().min(1).max(65535).default(8080)),
  HVWA_WARDEN_SECRET: unset(z.string().min(WARDEN_SECRET_MIN, `must be at least ${WARDEN_SECRET_MIN} characters`).optional()),
  HVWA_DOCKER_URL: unset(z.string().trim().regex(/^http:\/\/[a-z0-9.-]+(?::\d{1,5})?$/, 'must be http://host[:port] (the socket proxy)')
    .default('http://socket-proxy:2375')),
  HVWA_LAB_REGISTRY: unset(z.string().trim().min(1).default('/etc/hvwa/registry.json')),
  HVWA_RANGE_DOMAIN: unset(z.string().trim().toLowerCase().regex(DOMAIN_RE, 'must be a bare domain such as hvwa.my.id or localhost').optional()),
  HVWA_TRAEFIK_CONTAINER: unset(z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'must be a container name').default('hvwa-range-traefik')),
  HVWA_RANGE_RUNTIME: unset(z.enum(RUNTIMES).default('runc')),
}).superRefine((c, ctx) => {
  if (c.HVWA_WARDEN_SECRET === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HVWA_WARDEN_SECRET'], message: 'is required' });
  if (c.HVWA_RANGE_DOMAIN === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['HVWA_RANGE_DOMAIN'], message: 'is required' });
}).transform((c) => ({
  host: c.HOST, port: c.PORT, secret: c.HVWA_WARDEN_SECRET as string, dockerUrl: c.HVWA_DOCKER_URL, registryPath: c.HVWA_LAB_REGISTRY,
  domain: c.HVWA_RANGE_DOMAIN as string, traefikContainer: c.HVWA_TRAEFIK_CONTAINER, runtime: c.HVWA_RANGE_RUNTIME,
}));

export type WardenConfig = z.output<typeof schema>;

export function loadWardenConfig(env: Record<string, string | undefined> = process.env):
  { ok: true; config: WardenConfig } | { ok: false; errors: string[] } {
  const r = schema.safeParse(env);
  if (r.success) return { ok: true, config: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message.replace(/\s+/g, ' ')}`) };
}
```

Create `src/warden/main.ts`:

```ts
// src/warden/main.ts — the warden process (image sigmajo/hvwa:range-warden-<version>, docker-compose.range.yml). Reads
// its environment, loads the lab registry (the image allowlist), talks to Docker only through the socket proxy, and
// serves its API on the control network. Logs one line per launch and stop; never a flag, never the secret.
import { loadRegistry } from '../lab-registry.js';
import { loadWardenConfig } from './config.js';
import { createDockerClient } from './docker.js';
import { createWardenServer } from './server.js';
import { createWarden } from './warden.js';

const loaded = loadWardenConfig(process.env);
if (!loaded.ok) {
  console.error('warden: invalid configuration:');
  for (const line of loaded.errors) console.error(`  ${line}`);
  process.exit(1);
}
const { config } = loaded;
delete process.env.HVWA_WARDEN_SECRET; // the config holds it now

const registry = loadRegistry(config.registryPath);
const docker = createDockerClient(config.dockerUrl);
try {
  await docker.ping();
} catch (err) {
  console.warn(`warden: the Docker API at ${config.dockerUrl} does not answer yet (${err instanceof Error ? err.message : String(err)})`);
}
const warden = createWarden({
  docker, registry, log: (line) => console.log(line),
  settings: { domain: config.domain, runtime: config.runtime, traefikContainer: config.traefikContainer },
});
const server = createWardenServer({ warden, secret: config.secret }).listen(config.port, config.host, () => {
  console.log(`warden on http://${config.host}:${config.port}: ${registry.labs.length} lab image(s), runtime ${config.runtime}, instances at i-<id>.${config.domain}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/warden-server.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`, then `npm run build` once to see `dist/warden/main.js` emitted. Expected: all green.

```bash
git add src/warden/server.ts src/warden/config.ts src/warden/main.ts tests/warden-server.spec.ts
git commit -m "feat(warden): API server with bearer shared secret, strict bodies, config and entry point"
```

---

## Part 3 — Range lifecycle in the portal (spec §13 step 3)

### Task 15: Range flags (spec §6) and the range key

**Files:**
- Create: `src/range/flags.ts`
- Modify: `src/core/secrets.ts` (`resolveRangeKey`, `MIN_RANGE_KEY_LENGTH`)
- Test: `tests/range-flags.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-flags.spec.ts`:

```ts
// Instance ids and range flags (src/range/ids.ts, src/range/flags.ts, spec range §5.2 and §6), and the range key
// (src/core/secrets.ts resolveRangeKey): the flag is a MAC of (instance, lab, level) under a key only the portal holds.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32, INSTANCE_ID_RE, newInstanceId } from '../src/range/ids.js';
import { flagHash, RANGE_FLAG_RE, rangeFlag } from '../src/range/flags.js';
import { MIN_RANGE_KEY_LENGTH, resolveRangeKey } from '../src/core/secrets.js';

const KEY = 'k'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('instance ids', () => {
  it('base32 follows RFC 4648 section 10 (lower case, no padding)', () => {
    expect(['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar'].map((s) => base32(Buffer.from(s))))
      .toEqual(['', 'my', 'mzxq', 'mzxw6', 'mzxw6yq', 'mzxw6ytb', 'mzxw6ytboi']);
  });

  it('newInstanceId: 26 characters of [a-z2-7] (128 bits); 1000 draws never repeat', () => {
    const ids = Array.from({ length: 1000 }, newInstanceId);
    for (const id of ids) expect(id).toMatch(INSTANCE_ID_RE);
    expect(new Set(ids).size).toBe(1000);
  });
});

describe('rangeFlag', () => {
  it('is HVWA{ + base32(HMAC-SHA256(rangeKey, "flag|" + id + "|" + lab + "|" + level))[:26] + }', () => {
    const mac = createHmac('sha256', KEY).update(`flag|${ID}|r01|templar`).digest();
    expect(rangeFlag(KEY, ID, 'r01', 'templar')).toBe(`HVWA{${base32(mac).slice(0, 26)}}`);
    expect(rangeFlag(KEY, ID, 'r01', 'templar')).toMatch(RANGE_FLAG_RE);
  });

  it('differs per instance, lab, level and key; Divine has none', () => {
    const flags = new Set([
      rangeFlag(KEY, ID, 'r01', 'acolyte'), rangeFlag(KEY, 'z'.repeat(26), 'r01', 'acolyte'),
      rangeFlag(KEY, ID, 'r02', 'acolyte'), rangeFlag(KEY, ID, 'r01', 'templar'), rangeFlag('q'.repeat(40), ID, 'r01', 'acolyte'),
    ]);
    expect(flags.size).toBe(5);
    expect(() => rangeFlag(KEY, ID, 'r01', 'divine')).toThrow(/Divine/);
  });

  it('flagHash is the hex SHA-256 (what an instance record keeps)', () => {
    const flag = rangeFlag(KEY, ID, 'r01', 'acolyte');
    expect(flagHash(flag)).toBe(createHash('sha256').update(flag).digest('hex'));
  });
});

describe('resolveRangeKey', () => {
  const temp = () => { const d = mkdtempSync(join(tmpdir(), 'hvwa-rk-')); dirs.push(d); return d; };

  it('HVWA_RANGE_KEY wins; a short one is an error', () => {
    expect(resolveRangeKey(temp(), ` ${KEY} `)).toBe(KEY);
    expect(() => resolveRangeKey(temp(), 'short')).toThrow(new RegExp(`${MIN_RANGE_KEY_LENGTH} characters`));
  });

  it('otherwise creates <data>/range-key once (64 hex) and reuses it; a short stored key is regenerated with a warning', () => {
    const dir = temp();
    const first = resolveRangeKey(dir, undefined);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'range-key'), 'utf8').trim()).toBe(first);
    expect(resolveRangeKey(dir, '')).toBe(first);
    writeFileSync(join(dir, 'range-key'), 'tiny\n');
    const warnings: string[] = [];
    const again = resolveRangeKey(dir, undefined, (m) => warnings.push(m));
    expect(again).not.toBe('tiny');
    expect(warnings).toHaveLength(1);
    expect(existsSync(join(dir, 'range-key'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-flags.spec.ts`
Expected: FAIL — `src/range/flags.ts` and `resolveRangeKey` do not exist.

- [ ] **Step 3: Implement**

Create `src/range/flags.ts`:

```ts
// src/range/flags.ts — range flags (spec range §6): HVWA{<base32 of HMAC-SHA256(rangeKey, "flag|id|lab|level")>[:26]}.
// Derived per instance, so a flag copied from someone else never matches the submitter's own instances. The key lives
// only in the portal; an instance record keeps flagHash(flag), never the flag.
import { createHash, createHmac } from 'node:crypto';
import type { Level } from '../core/levels.js';
import { RANGE_FLAG_RE } from '../warden/protocol.js';
import { base32 } from './ids.js';

export { RANGE_FLAG_RE };

export function rangeFlag(rangeKey: string, instanceId: string, labId: string, level: Level): string {
  if (level === 'divine') throw new Error('rangeFlag: Divine has no flag (the secure reference)');
  const mac = createHmac('sha256', rangeKey).update(`flag|${instanceId}|${labId}|${level}`).digest();
  return `HVWA{${base32(mac).slice(0, 26)}}`;
}

/** Hex SHA-256 of a flag: what range_instances.flag_hash holds and a submission is compared by. */
export function flagHash(flag: string): string {
  return createHash('sha256').update(flag, 'utf8').digest('hex');
}
```

In `src/core/secrets.ts`, append:

```ts
/** Shortest range key (portal mode: the flag MAC key and the gate-cookie key's root). */
export const MIN_RANGE_KEY_LENGTH = 32;

/**
 * The range key (portal mode, spec range §6): HVWA_RANGE_KEY if set, else a random 32-byte hex key created once and
 * persisted at <dataDir>/range-key (mode 0600), like the flag secret. A stored key that is too short is regenerated
 * with a warning: flags of live instances then stop verifying (records keep only hashes) and every gate cookie expires.
 */
export function resolveRangeKey(dataDir: string, configured: string | undefined, warn: (message: string) => void = console.warn): string {
  const fromConfig = configured?.trim();
  if (fromConfig) {
    if (fromConfig.length < MIN_RANGE_KEY_LENGTH) throw new Error(`HVWA_RANGE_KEY must be at least ${MIN_RANGE_KEY_LENGTH} characters`);
    return fromConfig;
  }
  const file = join(dataDir, 'range-key');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored.length >= MIN_RANGE_KEY_LENGTH) return stored;
    warn(`${file}: stored range key is shorter than ${MIN_RANGE_KEY_LENGTH} characters; regenerating it`);
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-flags.spec.ts tests/secrets.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/flags.ts src/core/secrets.ts tests/range-flags.spec.ts
git commit -m "feat(range): per-instance flags (HMAC under the range key) and the persisted range key"
```

---

### Task 16: The instance store

**Files:**
- Create: `src/range/store.ts`
- Test: `tests/range-store.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-store.spec.ts`:

```ts
// The range_instances table behind the lifecycle (src/range/store.ts): records, one active per user (the database
// enforces it too), the live count, the FIFO queue and the 24-hour flag lookup by hash.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createInstanceStore, type NewInstance } from '../src/range/store.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function store() {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  return createInstanceStore(db);
}
const id = (c: string) => c.repeat(26);
const rec = (over: Partial<NewInstance> = {}): NewInstance => ({
  id: id('a'), userId: 1, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: 'h1', createdAt: 100, startedAt: 100, expiresAt: 1000, ...over,
});

describe('createInstanceStore', () => {
  it('inserts, reads back and patches a record; unknown ids are undefined', () => {
    const s = store();
    s.insert(rec());
    expect(s.get(id('a'))).toEqual({
      id: id('a'), userId: 1, labId: 'r01', level: 'acolyte', state: 'starting', reason: null, flagHash: 'h1',
      createdAt: 100, startedAt: 100, readyAt: null, expiresAt: 1000, lastSeenAt: null, endedAt: null,
    });
    s.update(id('a'), { state: 'running', readyAt: 150 });
    expect(s.get(id('a'))).toMatchObject({ state: 'running', readyAt: 150 });
    s.update(id('a'), {});
    expect(s.get(id('b'))).toBeUndefined();
  });

  it('one active instance per user, in the database too; stopped and failed ones do not count', () => {
    const s = store();
    s.insert(rec());
    expect(() => s.insert(rec({ id: id('b') }))).toThrow(/UNIQUE/);
    s.update(id('a'), { state: 'stopped', endedAt: 200 });
    s.insert(rec({ id: id('b') }));
    expect(s.activeFor(1)?.id).toBe(id('b'));
    expect(s.activeFor(2)).toBeUndefined();
  });

  it('counts live instances (starting + running), lists the queue oldest first, gives 1-based positions', () => {
    const s = store();
    s.insert(rec({ id: id('a'), userId: 1 }));
    s.insert(rec({ id: id('b'), userId: 2, state: 'queued', startedAt: null, expiresAt: null, createdAt: 300 }));
    s.insert(rec({ id: id('c'), userId: 3, state: 'queued', startedAt: null, expiresAt: null, createdAt: 200 }));
    expect(s.countLive()).toBe(1);
    expect(s.queued().map((r) => r.id)).toEqual([id('c'), id('b')]);
    expect([s.queuePosition(id('c')), s.queuePosition(id('b')), s.queuePosition(id('a'))]).toEqual([1, 2, 0]);
    expect(s.listActive().map((r) => r.id)).toEqual([id('a'), id('c'), id('b')]);
    expect(s.listByState('queued')).toHaveLength(2);
  });

  it('levelForFlag: only this user\'s instances of this lab, created inside the window', () => {
    const s = store();
    s.insert(rec({ id: id('a'), userId: 1, level: 'templar', flagHash: 'H', createdAt: 5000 }));
    expect(s.levelForFlag(1, 'r01', 'H', 1000)).toBe('templar');
    expect(s.levelForFlag(2, 'r01', 'H', 1000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r02', 'H', 1000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r01', 'H', 6000)).toBeUndefined();
    expect(s.levelForFlag(1, 'r01', 'other', 1000)).toBeUndefined();
  });

  it('latestFor: the newest record of a user for a lab and level (the panel shows a recent failure)', () => {
    const s = store();
    s.insert(rec({ id: id('a'), createdAt: 1 }));
    s.update(id('a'), { state: 'failed', reason: 'unhealthy', endedAt: 2 });
    s.insert(rec({ id: id('b'), createdAt: 3, level: 'templar' }));
    expect(s.latestFor(1, 'r01', 'acolyte')).toMatchObject({ id: id('a'), state: 'failed', reason: 'unhealthy' });
    expect(s.latestFor(1, 'r01', 'templar')?.id).toBe(id('b'));
    expect(s.latestFor(1, 'r02', 'acolyte')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-store.spec.ts`
Expected: FAIL — `src/range/store.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/range/store.ts`:

```ts
// src/range/store.ts — the range_instances table (migration 4): one row per instance, its flag kept as a SHA-256.
// Only the lifecycle (src/range/lifecycle.ts) writes it; the gate, forward-auth, flag submission and the panels read it.
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { isLevel, type Level } from '../core/levels.js';

export const INSTANCE_STATES = Object.freeze(['queued', 'starting', 'running', 'stopping', 'stopped', 'failed'] as const);
export type InstanceState = (typeof INSTANCE_STATES)[number];
/** States that hold the user's one slot (the unique index range_instances_one_active). */
export const ACTIVE_STATES: readonly InstanceState[] = Object.freeze(['queued', 'starting', 'running']);
export const isActiveState = (s: InstanceState) => ACTIVE_STATES.includes(s);

export interface InstanceRecord {
  readonly id: string;
  readonly userId: number;
  readonly labId: string;
  readonly level: Level;
  readonly state: InstanceState;
  readonly reason: string | null;
  readonly flagHash: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly readyAt: number | null;
  readonly expiresAt: number | null;
  readonly lastSeenAt: number | null;
  readonly endedAt: number | null;
}

export interface NewInstance {
  readonly id: string;
  readonly userId: number;
  readonly labId: string;
  readonly level: Level;
  readonly state: 'queued' | 'starting';
  readonly flagHash: string | null;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly expiresAt: number | null;
}

export type InstancePatch = Partial<Pick<InstanceRecord, 'state' | 'reason' | 'startedAt' | 'readyAt' | 'expiresAt' | 'lastSeenAt' | 'endedAt'>>;

export interface InstanceStore {
  insert(rec: NewInstance): void;
  get(id: string): InstanceRecord | undefined;
  activeFor(userId: number): InstanceRecord | undefined;
  update(id: string, patch: InstancePatch): void;
  /** queued, starting and running, oldest first. */
  listActive(): InstanceRecord[];
  listByState(state: InstanceState): InstanceRecord[];
  /** starting + running: what counts against the capacity. */
  countLive(): number;
  /** The FIFO queue, oldest first. */
  queued(): InstanceRecord[];
  /** 1-based position in the queue; 0 when not queued. */
  queuePosition(id: string): number;
  /** The level of one of `userId`'s instances of `labId` created at or after `since` whose flag hashes to `hash`. */
  levelForFlag(userId: number, labId: string, hash: string, since: number): Level | undefined;
  /** The newest record of this user for this lab and level, any state. */
  latestFor(userId: number, labId: string, level: Level): InstanceRecord | undefined;
}

interface Row {
  id: string; user_id: number; lab_id: string; level: string; state: string; reason: string | null; flag_hash: string | null;
  created_at: number; started_at: number | null; ready_at: number | null; expires_at: number | null; last_seen_at: number | null;
  ended_at: number | null;
}

const COLUMNS: Readonly<Record<keyof InstancePatch, string>> = Object.freeze({
  state: 'state', reason: 'reason', startedAt: 'started_at', readyAt: 'ready_at', expiresAt: 'expires_at', lastSeenAt: 'last_seen_at', endedAt: 'ended_at',
});
const SELECT = `SELECT id, user_id, lab_id, level, state, reason, flag_hash, created_at, started_at, ready_at, expires_at, last_seen_at,
  ended_at FROM range_instances`;
const num = (v: number | null) => (v === null ? null : Number(v));

function toRecord(r: Row): InstanceRecord {
  if (!isLevel(r.level)) throw new Error(`range_instances ${r.id}: bad level ${r.level}`);
  return {
    id: r.id, userId: Number(r.user_id), labId: r.lab_id, level: r.level, state: r.state as InstanceState, reason: r.reason,
    flagHash: r.flag_hash, createdAt: Number(r.created_at), startedAt: num(r.started_at), readyAt: num(r.ready_at),
    expiresAt: num(r.expires_at), lastSeenAt: num(r.last_seen_at), endedAt: num(r.ended_at),
  };
}

export function createInstanceStore(db: DatabaseSync): InstanceStore {
  const insert = db.prepare(`INSERT INTO range_instances (id, user_id, lab_id, level, state, flag_hash, created_at, started_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = db.prepare(`${SELECT} WHERE id = ?`);
  const active = db.prepare(`${SELECT} WHERE user_id = ? AND state IN ('queued', 'starting', 'running')`);
  const allActive = db.prepare(`${SELECT} WHERE state IN ('queued', 'starting', 'running') ORDER BY created_at, rowid`);
  const byState = db.prepare(`${SELECT} WHERE state = ? ORDER BY created_at, rowid`);
  const live = db.prepare("SELECT COUNT(*) AS n FROM range_instances WHERE state IN ('starting', 'running')");
  const flag = db.prepare(`SELECT level FROM range_instances WHERE user_id = ? AND lab_id = ? AND flag_hash = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1`);
  const latest = db.prepare(`${SELECT} WHERE user_id = ? AND lab_id = ? AND level = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const rows = (stmt: StatementSync, ...args: (string | number)[]) => (stmt.all(...args) as unknown as Row[]).map(toRecord);
  const queued = () => rows(byState, 'queued');

  return Object.freeze({
    insert(r: NewInstance) {
      insert.run(r.id, r.userId, r.labId, r.level, r.state, r.flagHash, r.createdAt, r.startedAt, r.expiresAt);
    },
    get(id: string) { const r = byId.get(id) as Row | undefined; return r ? toRecord(r) : undefined; },
    activeFor(userId: number) { const r = active.get(userId) as Row | undefined; return r ? toRecord(r) : undefined; },
    update(id: string, patch: InstancePatch) {
      const keys = (Object.keys(patch) as (keyof InstancePatch)[]).filter((k) => Object.hasOwn(COLUMNS, k));
      if (keys.length === 0) return;
      db.prepare(`UPDATE range_instances SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`)
        .run(...keys.map((k) => patch[k] ?? null), id);
    },
    listActive: () => rows(allActive),
    listByState: (state: InstanceState) => rows(byState, state),
    countLive: () => Number((live.get() as { n: number }).n),
    queued,
    queuePosition: (id: string) => queued().findIndex((r) => r.id === id) + 1,
    levelForFlag(userId: number, labId: string, hash: string, since: number) {
      const r = flag.get(userId, labId, hash, since) as { level: string } | undefined;
      return r && isLevel(r.level) ? r.level : undefined;
    },
    latestFor(userId: number, labId: string, level: Level) {
      const r = latest.get(userId, labId, level) as Row | undefined;
      return r ? toRecord(r) : undefined;
    },
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-store.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/store.ts tests/range-store.spec.ts
git commit -m "feat(range): instance store (one active per user, queue, live count, flag lookup by hash)"
```

---

### Task 17: The portal's warden client, a fake warden, and the client/server contract

**Files:**
- Create: `src/range/warden-client.ts`, `tests/support/fake-warden.ts`
- Test: `tests/range-warden-client.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/support/fake-warden.ts`:

```ts
// tests/support/fake-warden.ts — an in-process WardenApi for portal specs: "containers" in a map, health as the spec
// sets it, a failing next launch, a warden that is down, a crashed instance, an orphan container.
import { WardenError, type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi, type WardenErrorCode } from '../../src/warden/protocol.js';

interface Box { readonly req: LaunchRequest; health: InstanceHealth; state: 'running' | 'exited' }

export interface FakeWarden extends WardenApi {
  readonly launched: LaunchRequest[];
  readonly stopped: string[];
  readonly boxes: Map<string, Box>;
  /** Every call throws WardenError('unavailable') while true. */
  down: boolean;
  setHealth(instanceId: string, health: InstanceHealth): void;
  failNextLaunch(code: WardenErrorCode): void;
  /** A container no record owns (left over from a crash, or made by hand). */
  addOrphan(instanceId: string): void;
  /** The container exited (restart policy none): still listed, health failed. */
  crash(instanceId: string): void;
}

export function fakeWarden(opts: { autoReady?: boolean } = {}): FakeWarden {
  const launched: LaunchRequest[] = [];
  const stopped: string[] = [];
  const boxes = new Map<string, Box>();
  let failNext: WardenErrorCode | undefined;
  const guard = () => { if (w.down) throw new WardenError('unavailable', 0); };
  const w: FakeWarden = {
    launched, stopped, boxes, down: false,
    setHealth(id, health) { const b = boxes.get(id); if (b) b.health = health; },
    failNextLaunch(code) { failNext = code; },
    addOrphan(id) {
      boxes.set(id, { req: { labId: 'r01', level: 'acolyte', instanceId: id, flag: `HVWA{${'a'.repeat(26)}}`, userId: 999, expiresAt: 1 },
        health: { status: 'ready' }, state: 'running' });
    },
    crash(id) { const b = boxes.get(id); if (b) { b.state = 'exited'; b.health = { status: 'failed', reason: 'exited' }; } },
    async launch(req) {
      guard();
      if (failNext) { const code = failNext; failNext = undefined; throw new WardenError(code, code === 'docker' ? 502 : 400); }
      if (boxes.has(req.instanceId)) throw new WardenError('exists', 409);
      launched.push(req);
      boxes.set(req.instanceId, { req, health: { status: opts.autoReady ? 'ready' : 'starting' }, state: 'running' });
    },
    async stop(id) { guard(); stopped.push(id); boxes.delete(id); },
    async list(): Promise<ListedInstance[]> {
      guard();
      return [...boxes.values()].map((b) => ({
        instanceId: b.req.instanceId, labId: b.req.labId, level: b.req.level, userId: b.req.userId, expiresAt: b.req.expiresAt, state: b.state,
      }));
    },
    async health(id) { guard(); return boxes.get(id)?.health ?? { status: 'missing' }; },
  };
  return w;
}
```

Create `tests/range-warden-client.spec.ts`:

```ts
// The portal's warden client (src/range/warden-client.ts) against the REAL warden server (src/warden/server.ts) on the
// stub Engine: the contract both sides share (src/warden/protocol.ts), the bearer secret, and the error codes.
import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { createWardenClient } from '../src/range/warden-client.js';
import { WardenError } from '../src/warden/protocol.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { testRegistry } from './support/range.js';
import { serve } from './helpers.js';

const SECRET = 'w'.repeat(40);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const stubs: DockerStub[] = [];
afterEach(async () => { for (const s of stubs.splice(0)) await s.close(); });
const urlOf = (app: express.Express) => `http://127.0.0.1:${(serve(app).address() as AddressInfo).port}`;

async function wardenUrl() {
  const stub = await startDockerStub();
  stubs.push(stub);
  const registry = testRegistry();
  for (const lab of registry.labs) stub.images.set(lab.image, { healthcheck: true });
  stub.addContainer('hvwa-range-traefik');
  const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'range.test', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
  return { stub, url: urlOf(createWardenServer({ warden, secret: SECRET })) };
}

describe('createWardenClient', () => {
  it('launch, list, health, stop through the real server', async () => {
    const { stub, url } = await wardenUrl();
    const client = createWardenClient({ baseUrl: url, secret: SECRET });
    await client.launch({ labId: 'r01', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 4, expiresAt: 1_800_000_000_000 });
    expect(stub.container(`hvwa-i-${ID}`)?.status).toBe('running');
    expect(await client.list()).toEqual([{ instanceId: ID, labId: 'r01', level: 'acolyte', userId: 4, expiresAt: 1_800_000_000_000, state: 'running' }]);
    expect(await client.health(ID)).toEqual({ status: 'starting' });
    stub.setHealth(`hvwa-i-${ID}`, 'healthy');
    expect(await client.health(ID)).toEqual({ status: 'ready' });
    await client.stop(ID);
    expect(await client.health(ID)).toEqual({ status: 'missing' });
  });

  it('maps failures to WardenError codes: unauthorized, unknown_lab, unavailable (down or a malformed answer)', async () => {
    const { url } = await wardenUrl();
    const wrong = createWardenClient({ baseUrl: url, secret: 'x'.repeat(40) });
    await expect(wrong.list()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    const client = createWardenClient({ baseUrl: url, secret: SECRET });
    await expect(client.launch({ labId: 'r09', level: 'acolyte', instanceId: ID, flag: FLAG, userId: 4, expiresAt: 1 }))
      .rejects.toMatchObject({ code: 'unknown_lab', status: 404 });
    const nowhere = createWardenClient({ baseUrl: 'http://127.0.0.1:9', secret: SECRET, timeoutMs: 1000 });
    await expect(nowhere.list()).rejects.toBeInstanceOf(WardenError);
    await expect(nowhere.list()).rejects.toMatchObject({ code: 'unavailable' });
    const junk = express();
    junk.get('/v1/instances', (_req, res) => { res.json({ instances: 'not a list' }); });
    junk.get('/v1/instances/:id/health', (_req, res) => { res.json({ status: 'fine' }); });
    const bad = createWardenClient({ baseUrl: urlOf(junk), secret: SECRET });
    await expect(bad.list()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(bad.health(ID)).rejects.toMatchObject({ code: 'unavailable' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-warden-client.spec.ts`
Expected: FAIL — `src/range/warden-client.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/range/warden-client.ts`:

```ts
// src/range/warden-client.ts — the portal's client for the warden API (src/warden/server.ts): HTTP on the internal
// control network, `Authorization: Bearer <HVWA_WARDEN_SECRET>`. Every failure is a WardenError with a closed code;
// answers are validated (src/warden/protocol.ts), so a confused warden can never put odd data into the records.
import {
  instanceHealthSchema, listResponseSchema, WARDEN_ERROR_CODES, WardenError,
  type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi, type WardenErrorCode,
} from '../warden/protocol.js';

export interface WardenClientOptions {
  /** HVWA_WARDEN_URL, e.g. http://warden:8080. */
  readonly baseUrl: string;
  /** HVWA_WARDEN_SECRET. */
  readonly secret: string;
  readonly timeoutMs?: number;
}

const isCode = (x: unknown): x is WardenErrorCode => typeof x === 'string' && (WARDEN_ERROR_CODES as readonly string[]).includes(x);

export function createWardenClient(opts: WardenClientOptions): WardenApi {
  const root = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${opts.secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new WardenError('unavailable', 0);
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
    if (res.ok) return json;
    const code = (json as { error?: unknown } | undefined)?.error;
    throw new WardenError(isCode(code) ? code : res.status === 401 ? 'unauthorized' : 'unavailable', res.status);
  }

  return Object.freeze({
    async launch(req: LaunchRequest) { await call('POST', '/v1/instances', req); },
    async stop(instanceId: string) { await call('DELETE', `/v1/instances/${enc(instanceId)}`); },
    async list(): Promise<ListedInstance[]> {
      const r = listResponseSchema.safeParse(await call('GET', '/v1/instances'));
      if (!r.success) throw new WardenError('unavailable', 200);
      return r.data.instances;
    },
    async health(instanceId: string): Promise<InstanceHealth> {
      const r = instanceHealthSchema.safeParse(await call('GET', `/v1/instances/${enc(instanceId)}/health`));
      if (!r.success) throw new WardenError('unavailable', 200);
      return r.data;
    },
  });
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-warden-client.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/warden-client.ts tests/support/fake-warden.ts tests/range-warden-client.spec.ts
git commit -m "feat(range): warden HTTP client with validated answers; fake warden for portal specs"
```

---

### Task 18: The instance lifecycle: launch, one active per user, capacity and FIFO queue, extend, reset, stop

**Files:**
- Create: `src/range/lifecycle.ts`
- Modify: `src/range/types.ts`, `src/range/index.ts`, `tests/support/range.ts`
- Test: `tests/range-lifecycle.spec.ts`

- [ ] **Step 1: Write the failing test**

In `tests/support/range.ts`, add the import `import { fakeWarden, type FakeWarden } from './fake-warden.js';`, add the constant

```ts
export const RANGE_KEY = 'r'.repeat(40);
```

make `Kit` carry the warden:

```ts
export interface Kit { readonly app: HvwaApp; readonly clock: Clock; readonly registry: LabRegistry; readonly warden: FakeWarden }
```

and in `portalApp`, create the fake warden and pass it with the key (the signature gains `warden?: FakeWarden`):

```ts
export function portalApp(o: { range?: Partial<RangePortalOptions>; registration?: RegistrationOptions; warden?: FakeWarden } = {}): Kit {
  let t = T0;
  const clock: Clock = { now: () => t, advance: (ms) => { t += ms; } };
  const registry = o.range?.registry ?? testRegistry();
  const warden = o.warden ?? fakeWarden({ autoReady: true });
  const app = createApp({
    flagSecret: TEST_SECRET, mode: 'portal',
    auth: {
      initialPassword: ADMIN_PASSWORD, hasher: FAST_HASHER, now: clock.now, passwordMinLength: 10,
      registration: { perIp: 1000, now: clock.now, ...o.registration },
    },
    range: {
      domain: DOMAIN, portalHost: DOMAIN, internalHost: 'portal', registry, limits: DEFAULT_LIMITS, now: clock.now,
      warden, rangeKey: RANGE_KEY, log: () => {}, ...o.range,
    },
  });
  onTestFinished(() => { try { app.locals.db.close(); } catch { /* closed by the test */ } });
  return { app, clock, registry, warden };
}
```

Create `tests/range-lifecycle.spec.ts`:

```ts
// The instance lifecycle (src/range/lifecycle.ts, spec range §5): launch with the derived flag, one active instance per
// user, global capacity with a FIFO queue, readiness from the warden's health, extend up to the ceiling, reset with a new
// flag, stop; and failures with a reason. Unit level: the store and a fake warden, on a fake clock.
import { describe, it, expect, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createLifecycle } from '../src/range/lifecycle.js';
import { flagHash, rangeFlag } from '../src/range/flags.js';
import { DEFAULT_LIMITS, type RangeLimits } from '../src/range/types.js';
import { fakeWarden, type FakeWarden } from './support/fake-warden.js';
import { RANGE_KEY, testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); });
function make(limits: Partial<RangeLimits> = {}, warden: FakeWarden = fakeWarden()) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = 1_000_000;
  const lc = createLifecycle({
    db, warden, registry: testRegistry(), rangeKey: RANGE_KEY, limits: { ...DEFAULT_LIMITS, ...limits }, now: () => t, log: () => {},
  });
  return { lc, warden, advance: (ms: number) => { t += ms; }, now: () => t };
}

describe('launch', () => {
  it('starts an instance: the warden gets the derived flag and the expiry; the record keeps only the flag\'s hash', async () => {
    const { lc, warden, now } = make();
    const r = await lc.launch(7, 'r01', 'templar');
    expect(r.ok).toBe(true);
    const rec = (r as { ok: true; instance: { id: string } }).instance;
    const flag = rangeFlag(RANGE_KEY, rec.id, 'r01', 'templar');
    expect(warden.launched).toEqual([{ labId: 'r01', level: 'templar', instanceId: rec.id, flag, userId: 7, expiresAt: now() + DEFAULT_LIMITS.maxMs }]);
    expect(lc.store.get(rec.id)).toMatchObject({ state: 'starting', flagHash: flagHash(flag), startedAt: now(), expiresAt: now() + DEFAULT_LIMITS.maxMs });
    expect(JSON.stringify(lc.store.get(rec.id))).not.toContain(flag);
  });

  it('Divine is launched without a flag and records no hash', async () => {
    const { lc, warden } = make();
    const r = await lc.launch(7, 'r01', 'divine');
    expect(warden.launched[0]).not.toHaveProperty('flag');
    expect(lc.store.get((r as { ok: true; instance: { id: string } }).instance.id)?.flagHash).toBeNull();
  });

  it('refuses an unknown lab or a level the lab does not have, launching nothing', async () => {
    const { lc, warden } = make();
    expect(await lc.launch(7, 'r99', 'acolyte')).toEqual({ ok: false, error: 'unknown_lab' });
    expect(await lc.launch(7, 'r02', 'templar')).toEqual({ ok: false, error: 'bad_level' });
    expect(warden.launched).toEqual([]);
  });

  it('one active per user: a second launch stops the first (reason "replaced"); concurrent launches still leave one', async () => {
    const { lc, warden } = make();
    const first = await lc.launch(7, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    const second = await lc.launch(7, 'r02', 'acolyte') as { ok: true; instance: { id: string } };
    expect(warden.stopped).toEqual([first.instance.id]);
    expect(lc.store.get(first.instance.id)).toMatchObject({ state: 'stopped', reason: 'replaced' });
    expect(lc.current(7)?.id).toBe(second.instance.id);
    await Promise.all([lc.launch(8, 'r01', 'acolyte'), lc.launch(8, 'r01', 'templar'), lc.launch(8, 'r02', 'acolyte')]);
    expect(lc.store.listActive().filter((r) => r.userId === 8)).toHaveLength(1);
  });

  it('a warden failure is "failed" with its code, and the slot is free again', async () => {
    const { lc, warden } = make({ capacity: 1 });
    warden.failNextLaunch('docker');
    const r = await lc.launch(7, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    expect(lc.store.get(r.instance.id)).toMatchObject({ state: 'failed', reason: 'docker' });
    expect(lc.current(7)).toBeUndefined();
    expect((await lc.launch(8, 'r01', 'acolyte') as { ok: true; instance: { state: string } }).instance.state).toBe('starting');
  });
});

describe('capacity and the FIFO queue', () => {
  it('beyond capacity a launch queues; positions are FIFO; a freed slot starts the queue head; leaving the queue calls no warden', async () => {
    const { lc, warden } = make({ capacity: 2 });
    await lc.launch(1, 'r01', 'acolyte');
    await lc.launch(2, 'r01', 'acolyte');
    const q3 = (await lc.launch(3, 'r01', 'acolyte') as { ok: true; instance: { id: string; state: string } }).instance;
    const q4 = (await lc.launch(4, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    expect(q3.state).toBe('queued');
    expect([lc.queuePosition(q3.id), lc.queuePosition(q4.id)]).toEqual([1, 2]);
    expect(warden.launched).toHaveLength(2);
    await lc.stop(1);
    expect(lc.store.get(q3.id)?.state).toBe('starting');
    expect(warden.launched.at(-1)?.instanceId).toBe(q3.id);
    expect(lc.queuePosition(q4.id)).toBe(1);
    const stopsBefore = warden.stopped.length;
    await lc.stop(4);
    expect(lc.store.get(q4.id)).toMatchObject({ state: 'stopped', reason: 'user' });
    expect(warden.stopped.length).toBe(stopsBefore);
  });

  it('is fair: a user who relaunches while others wait goes to the back of the queue', async () => {
    const { lc } = make({ capacity: 1 });
    await lc.launch(1, 'r01', 'acolyte');
    const waiting = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    const again = (await lc.launch(1, 'r01', 'templar') as { ok: true; instance: { id: string } }).instance;
    expect(lc.store.get(waiting.id)?.state).toBe('starting');
    expect(lc.store.get(again.id)?.state).toBe('queued');
  });
});

describe('readiness (refresh)', () => {
  it('starting -> running when the warden says ready; failed with the health reason otherwise (and the container removed)', async () => {
    const { lc, warden } = make();
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    expect((await lc.refresh(a.id))?.state).toBe('starting');
    warden.setHealth(a.id, { status: 'ready' });
    expect(await lc.refresh(a.id)).toMatchObject({ state: 'running' });
    const b = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.setHealth(b.id, { status: 'failed', reason: 'unhealthy' });
    expect(await lc.refresh(b.id)).toMatchObject({ state: 'failed', reason: 'unhealthy' });
    expect(warden.stopped).toContain(b.id);
  });

  it('a start slower than startTimeoutMs fails as start_timeout; a vanished container as missing; warden errors change nothing', async () => {
    const { lc, warden, advance } = make({ startTimeoutMs: 5000 });
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.down = true;
    expect((await lc.refresh(a.id))?.state).toBe('starting');
    warden.down = false;
    advance(5001);
    expect(await lc.refresh(a.id)).toMatchObject({ state: 'failed', reason: 'start_timeout' });
    const b = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    warden.boxes.delete(b.id);
    expect(await lc.refresh(b.id)).toMatchObject({ state: 'failed', reason: 'missing' });
  });
});

describe('extend, reset, stop', () => {
  it('extend adds extendMs up to startedAt + ceilingMs, then "ceiling"; only a running instance extends', async () => {
    const { lc, warden, now } = make({ maxMs: 100, extendMs: 60, ceilingMs: 200 });
    expect(lc.extend(1)).toEqual({ ok: false, error: 'none' });
    const a = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    expect(lc.extend(1)).toEqual({ ok: false, error: 'none' }); // still starting
    warden.setHealth(a.id, { status: 'ready' });
    await lc.refresh(a.id);
    const start = now();
    expect(lc.extend(1)).toEqual({ ok: true, expiresAt: start + 160 });
    expect(lc.extend(1)).toEqual({ ok: true, expiresAt: start + 200 });
    expect(lc.extend(1)).toEqual({ ok: false, error: 'ceiling' });
  });

  it('reset: a new instance of the same lab and level with a new flag; the old one is stopped', async () => {
    const { lc, warden } = make();
    expect(await lc.reset(1)).toEqual({ ok: false, error: 'none' });
    const a = (await lc.launch(1, 'r01', 'templar') as { ok: true; instance: { id: string } }).instance;
    const b = (await lc.reset(1) as { ok: true; instance: { id: string; labId: string; level: string } }).instance;
    expect(b.id).not.toBe(a.id);
    expect([b.labId, b.level]).toEqual(['r01', 'templar']);
    expect(warden.launched[1].flag).not.toBe(warden.launched[0].flag);
    expect(lc.store.get(a.id)).toMatchObject({ state: 'stopped', reason: 'replaced' });
  });

  it('stopInstance (reaper, admin) stops whoever owns it; touch + flushLastSeen write last_seen_at', async () => {
    const { lc, now } = make();
    const a = (await lc.launch(5, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance;
    lc.touch(a.id);
    expect(lc.store.get(a.id)?.lastSeenAt).toBeNull();
    lc.flushLastSeen();
    expect(lc.store.get(a.id)?.lastSeenAt).toBe(now());
    await lc.stopInstance(a.id, 'admin');
    expect(lc.store.get(a.id)).toMatchObject({ state: 'stopped', reason: 'admin' });
    await lc.stopInstance(a.id, 'admin'); // already stopped: nothing happens
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-lifecycle.spec.ts`
Expected: FAIL — `src/range/lifecycle.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/range/lifecycle.ts`:

```ts
// src/range/lifecycle.ts — the life of a range instance (spec range §5): launch (one active per user, global capacity,
// a FIFO queue), readiness, extend, reset, stop and failure. The warden does the Docker work; this module owns the
// records (src/range/store.ts) and their states: queued → starting → running → stopping → stopped, or failed (reason).
// One user's operations never interleave (a per-user promise chain), so "one active instance" holds under double clicks.
import type { DatabaseSync } from 'node:sqlite';
import type { Level } from '../core/levels.js';
import type { LabRegistry } from '../lab-registry.js';
import { WardenError, type InstanceHealth, type WardenApi } from '../warden/protocol.js';
import { flagHash, rangeFlag } from './flags.js';
import { newInstanceId } from './ids.js';
import { createInstanceStore, isActiveState, type InstanceRecord, type InstanceStore } from './store.js';
import type { RangeLimits } from './types.js';

/** Why an instance stopped (stored in `reason`); a failure stores the warden's or the health check's code instead. */
export const STOP_REASONS = Object.freeze(['user', 'replaced', 'idle', 'expired', 'admin', 'lost', 'interrupted'] as const);
export type StopReason = (typeof STOP_REASONS)[number];

export interface LifecycleDeps {
  readonly db: DatabaseSync;
  readonly warden: WardenApi;
  readonly registry: LabRegistry;
  readonly rangeKey: string;
  readonly limits: RangeLimits;
  readonly now?: () => number;
  /** One line per problem (never a flag). Default console.warn. */
  readonly log?: (line: string) => void;
}

export type LaunchOutcome = { ok: true; instance: InstanceRecord } | { ok: false; error: 'unknown_lab' | 'bad_level' };
export type ExtendOutcome = { ok: true; expiresAt: number } | { ok: false; error: 'none' | 'ceiling' };

export interface Lifecycle {
  readonly store: InstanceStore;
  /** The user's active instance (queued, starting or running), if any. */
  current(userId: number): InstanceRecord | undefined;
  /** 1-based position in the FIFO queue; 0 when not queued. */
  queuePosition(instanceId: string): number;
  /** Stop the user's current instance, then start (or queue) a new one of lab / level. */
  launch(userId: number, labId: string, level: Level): Promise<LaunchOutcome>;
  /** Stop the user's active instance (leaving the queue included). */
  stop(userId: number, reason?: StopReason): Promise<void>;
  /** Stop one instance whoever owns it (the reaper, the admin). */
  stopInstance(instanceId: string, reason: StopReason): Promise<void>;
  /** Mark an active instance failed and remove its container (best effort). */
  fail(instanceId: string, reason: string): Promise<void>;
  extend(userId: number): ExtendOutcome;
  /** A new instance of the same lab and level: a clean state and a new flag. */
  reset(userId: number): Promise<LaunchOutcome | { ok: false; error: 'none' }>;
  /** Ask the warden whether a starting instance is ready (or failed, or too slow to start). */
  refresh(instanceId: string): Promise<InstanceRecord | undefined>;
  /** Start queued instances, oldest first, while there is capacity. */
  promote(): Promise<void>;
  /** A request reached the instance (forward-auth): kept in memory until flushLastSeen. */
  touch(instanceId: string): void;
  /** Write the remembered last-seen times (the reaper does it every 30 s). */
  flushLastSeen(): void;
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { warden, registry, rangeKey, limits } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const store = createInstanceStore(deps.db);
  const lastSeen = new Map<string, number>();
  const chains = new Map<number, Promise<unknown>>();
  let promoting: Promise<void> | undefined;

  /** Run `job` after every earlier job of this user. */
  function serial<T>(userId: number, job: () => Promise<T>): Promise<T> {
    const prev = chains.get(userId) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(userId, tail);
    void tail.then(() => { if (chains.get(userId) === tail) chains.delete(userId); });
    return run;
  }

  const codeOf = (err: unknown) => (err instanceof WardenError ? err.code : 'unavailable');

  async function start(rec: InstanceRecord): Promise<void> {
    const flag = rec.level === 'divine' ? undefined : rangeFlag(rangeKey, rec.id, rec.labId, rec.level);
    try {
      await warden.launch({
        labId: rec.labId, level: rec.level, instanceId: rec.id, ...(flag === undefined ? {} : { flag }),
        userId: rec.userId, expiresAt: rec.expiresAt ?? now() + limits.maxMs,
      });
    } catch (err) {
      store.update(rec.id, { state: 'failed', reason: codeOf(err), endedAt: now() });
      log(`range: launch of ${rec.id} failed (${codeOf(err)})`);
    }
  }

  function promote(): Promise<void> {
    if (promoting) return promoting;
    promoting = (async () => {
      try {
        while (store.countLive() < limits.capacity) {
          const next = store.queued()[0];
          if (!next) break;
          const t = now();
          store.update(next.id, { state: 'starting', startedAt: t, expiresAt: t + limits.maxMs });
          await start({ ...next, state: 'starting', startedAt: t, expiresAt: t + limits.maxMs });
        }
      } finally {
        promoting = undefined;
      }
    })();
    return promoting;
  }

  async function stopRecord(rec: InstanceRecord, reason: StopReason): Promise<void> {
    store.update(rec.id, { state: 'stopping', reason });
    if (rec.state !== 'queued') {
      try { await warden.stop(rec.id); } catch (err) { log(`range: stop of ${rec.id} failed (${codeOf(err)}); the reaper retries`); }
    }
    store.update(rec.id, { state: 'stopped', endedAt: now() });
    lastSeen.delete(rec.id);
  }

  const lc: Lifecycle = {
    store,
    current: (userId) => store.activeFor(userId),
    queuePosition: (id) => store.queuePosition(id),

    launch: (userId, labId, level) => serial(userId, async (): Promise<LaunchOutcome> => {
      const lab = registry.get(labId);
      if (!lab) return { ok: false, error: 'unknown_lab' };
      if (!lab.levels.includes(level)) return { ok: false, error: 'bad_level' };
      const prev = store.activeFor(userId);
      if (prev) await stopRecord(prev, 'replaced');
      const id = newInstanceId();
      const t = now();
      const hash = level === 'divine' ? null : flagHash(rangeFlag(rangeKey, id, labId, level));
      if (store.countLive() < limits.capacity && store.queued().length === 0) {
        store.insert({ id, userId, labId, level, state: 'starting', flagHash: hash, createdAt: t, startedAt: t, expiresAt: t + limits.maxMs });
        await start(store.get(id) as InstanceRecord);
      } else {
        store.insert({ id, userId, labId, level, state: 'queued', flagHash: hash, createdAt: t, startedAt: null, expiresAt: null });
      }
      await promote(); // a slot freed by the replaced instance goes to the queue's head (which may be this one)
      return { ok: true, instance: store.get(id) as InstanceRecord };
    }),

    async stop(userId, reason = 'user') {
      await serial(userId, async () => {
        const rec = store.activeFor(userId);
        if (rec) await stopRecord(rec, reason);
      });
      await promote();
    },

    async stopInstance(id, reason) {
      const rec = store.get(id);
      if (!rec || !isActiveState(rec.state)) return;
      await serial(rec.userId, async () => {
        const again = store.get(id);
        if (again && isActiveState(again.state)) await stopRecord(again, reason);
      });
      await promote();
    },

    async fail(id, reason) {
      const rec = store.get(id);
      if (!rec || !isActiveState(rec.state)) return;
      store.update(id, { state: 'failed', reason, endedAt: now() });
      lastSeen.delete(id);
      try { await warden.stop(id); } catch (err) { log(`range: removing failed ${id} failed (${codeOf(err)}); the reaper retries`); }
      await promote();
    },

    extend(userId) {
      const rec = store.activeFor(userId);
      if (!rec || rec.state !== 'running' || rec.startedAt === null || rec.expiresAt === null) return { ok: false, error: 'none' };
      const next = Math.min(rec.expiresAt + limits.extendMs, rec.startedAt + limits.ceilingMs);
      if (next <= rec.expiresAt) return { ok: false, error: 'ceiling' };
      store.update(rec.id, { expiresAt: next });
      return { ok: true, expiresAt: next };
    },

    async reset(userId) {
      const rec = store.activeFor(userId);
      if (!rec) return { ok: false, error: 'none' };
      return lc.launch(userId, rec.labId, rec.level);
    },

    async refresh(id) {
      const rec = store.get(id);
      if (!rec || rec.state !== 'starting') return rec;
      let health: InstanceHealth;
      try { health = await warden.health(id); } catch { return rec; }
      const timedOut = now() - (rec.startedAt ?? rec.createdAt) > limits.startTimeoutMs;
      if (health.status === 'ready') store.update(id, { state: 'running', readyAt: now() });
      else if (health.status !== 'starting') await lc.fail(id, health.reason ?? health.status);
      else if (timedOut) await lc.fail(id, 'start_timeout');
      return store.get(id);
    },

    promote,
    touch(id) { lastSeen.set(id, now()); },
    flushLastSeen() {
      for (const [id, t] of lastSeen) store.update(id, { lastSeenAt: t });
      lastSeen.clear();
    },
  };
  return lc;
}
```

In `src/range/types.ts`, add the imports `import type { WardenApi } from '../warden/protocol.js';` and `import type { Lifecycle } from './lifecycle.js';`; `RangePortalOptions` gains:

```ts
  /** The warden (src/range/warden-client.ts in production, tests/support/fake-warden.ts in specs). */
  readonly warden: WardenApi;
  /** The range key (src/core/secrets.ts resolveRangeKey): flags and gate cookies. */
  readonly rangeKey: string;
  /** Problem lines (never a flag). Default console.warn. */
  readonly log?: (line: string) => void;
```

and `RangeContext` gains:

```ts
  readonly lifecycle: Lifecycle;
```

In `src/range/index.ts`, add `import { createLifecycle, type Lifecycle } from './lifecycle.js';`, add to `RangePortal`:

```ts
  /** The instance lifecycle (server.ts starts its reaper; the admin and the panels use it). */
  readonly lifecycle: Lifecycle;
```

build the context with it:

```ts
  const now = opts.now ?? Date.now;
  const lifecycle = createLifecycle({
    db, warden: opts.warden, registry: opts.registry, rangeKey: opts.rangeKey, limits: opts.limits, now, log: opts.log,
  });
  const ctx: RangeContext = { db, auth, opts, registry: opts.registry, now, lifecycle };
```

and return it: `return Object.freeze({ isInstanceHost, edge, locals, router, lifecycle });`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-lifecycle.spec.ts tests/portal-mode.spec.ts tests/auth-admin.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/lifecycle.ts src/range/types.ts src/range/index.ts tests/support/range.ts tests/range-lifecycle.spec.ts
git commit -m "feat(range): instance lifecycle: one active per user, capacity + FIFO queue, extend, reset, readiness"
```

---

### Task 19: The reaper and the startup reconcile

**Files:**
- Create: `src/range/reaper.ts`
- Modify: `src/range/index.ts` (`start()`)
- Test: `tests/range-reaper.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-reaper.spec.ts`:

```ts
// The reaper (src/range/reaper.ts, spec range §5.7): every pass flushes last-seen, stops expired and idle instances,
// refreshes starting ones, fails crashed ones, removes containers no record owns, and fills freed slots from the queue.
// On portal start, reconcile closes records without a container and removes unknown containers.
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from '../src/db/index.js';
import { createLifecycle } from '../src/range/lifecycle.js';
import { reapOnce, reconcile, startReaper } from '../src/range/reaper.js';
import { DEFAULT_LIMITS, type RangeLimits } from '../src/range/types.js';
import { fakeWarden } from './support/fake-warden.js';
import { portalApp, RANGE_KEY, testRegistry } from './support/range.js';

const dbs: DatabaseSync[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); vi.useRealTimers(); });
function make(limits: Partial<RangeLimits> = {}) {
  const db = openDb(':memory:');
  migrate(db);
  dbs.push(db);
  let t = 1_000_000;
  const warden = fakeWarden({ autoReady: true });
  const all = { ...DEFAULT_LIMITS, ...limits };
  const lc = createLifecycle({ db, warden, registry: testRegistry(), rangeKey: RANGE_KEY, limits: all, now: () => t, log: () => {} });
  const running = async (userId: number) => {
    const r = await lc.launch(userId, 'r01', 'acolyte') as { ok: true; instance: { id: string } };
    await lc.refresh(r.instance.id);
    return r.instance.id;
  };
  return { lc, warden, limits: all, now: () => t, advance: (ms: number) => { t += ms; }, running, pass: () => reapOnce(lc, warden, all, () => t) };
}

describe('reapOnce', () => {
  it('stops an expired instance (reason expired) and an idle one (reason idle); activity keeps one alive', async () => {
    const { lc, advance, running, pass } = make({ maxMs: 10_000, idleMs: 4_000 });
    const busy = await running(1);
    const idle = await running(2);
    advance(3_000);
    lc.touch(busy);
    advance(3_000);
    await pass();
    expect(lc.store.get(idle)).toMatchObject({ state: 'stopped', reason: 'idle' });
    expect(lc.store.get(busy)?.state).toBe('running');
    expect(lc.store.get(busy)?.lastSeenAt).not.toBeNull(); // flushed by the pass
    advance(5_000);
    lc.touch(busy);
    await pass();
    expect(lc.store.get(busy)).toMatchObject({ state: 'stopped', reason: 'expired' });
  });

  it('a crashed container (exited or gone) is failed "crashed"; a container no record owns is removed', async () => {
    const { lc, warden, running, pass } = make();
    const a = await running(1);
    const b = await running(2);
    warden.crash(a);
    warden.boxes.delete(b);
    warden.addOrphan('o'.repeat(26));
    await pass();
    expect(lc.store.get(a)).toMatchObject({ state: 'failed', reason: 'crashed' });
    expect(lc.store.get(b)).toMatchObject({ state: 'failed', reason: 'crashed' });
    expect(warden.stopped).toEqual(expect.arrayContaining([a, 'o'.repeat(26)]));
    expect(warden.boxes.size).toBe(0);
  });

  it('refreshes starting instances and fills freed slots from the queue', async () => {
    const { lc, warden, pass, advance } = make({ capacity: 1, idleMs: 1 });
    const first = (await lc.launch(1, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance.id;
    const waiting = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance.id;
    await pass(); // refresh: first -> running (autoReady)
    expect(lc.store.get(first)?.state).toBe('running');
    advance(10);
    await pass(); // first has been idle longer than idleMs (1 ms): stopped; the queue head starts
    expect(lc.store.get(first)?.reason).toBe('idle');
    expect(lc.store.get(waiting)?.state).toBe('starting');
    expect(warden.launched.at(-1)?.instanceId).toBe(waiting);
  });

  it('with the warden down a pass changes nothing and does not throw; the next pass works', async () => {
    const { lc, warden, running, pass } = make();
    const a = await running(1);
    warden.down = true;
    await expect(pass()).resolves.toBeUndefined();
    expect(lc.store.get(a)?.state).toBe('running');
    warden.down = false;
    warden.crash(a);
    await pass();
    expect(lc.store.get(a)?.state).toBe('failed');
  });
});

describe('reconcile (portal start)', () => {
  it('closes records without a container (lost) and leftover stopping ones; keeps the queue; removes unknown containers', async () => {
    const { lc, warden, running, now } = make({ capacity: 1 });
    const kept = await running(1);
    const queued = (await lc.launch(2, 'r01', 'acolyte') as { ok: true; instance: { id: string } }).instance.id;
    lc.store.insert({ id: 'l'.repeat(26), userId: 3, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: null, createdAt: now(), startedAt: now(), expiresAt: now() + 1 });
    lc.store.insert({ id: 's'.repeat(26), userId: 4, labId: 'r01', level: 'acolyte', state: 'starting', flagHash: null, createdAt: now(), startedAt: now(), expiresAt: now() + 1 });
    lc.store.update('s'.repeat(26), { state: 'stopping', reason: 'user' });
    warden.addOrphan('o'.repeat(26));
    await reconcile(lc, warden, now);
    expect(lc.store.get('l'.repeat(26))).toMatchObject({ state: 'stopped', reason: 'lost' });
    expect(lc.store.get('s'.repeat(26))).toMatchObject({ state: 'stopped', reason: 'user' });
    expect(lc.store.get(kept)?.state).toBe('running');
    expect(lc.store.get(queued)?.state).toBe('queued'); // capacity 1 is taken by `kept`
    expect(warden.stopped).toContain('o'.repeat(26));
  });
});

describe('startReaper', () => {
  it('runs the pass every interval, never two at once, until stopped', async () => {
    vi.useFakeTimers();
    let runs = 0;
    let release: () => void = () => {};
    const reaper = startReaper(() => { runs += 1; return new Promise<void>((r) => { release = r; }); }, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000); // the first pass is still running: skipped
    expect(runs).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toBe(2);
    reaper.stop();
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toBe(2);
  });

  it('RangePortal.start(): reconciles at once (an orphan is removed) and returns a stoppable reaper', async () => {
    const warden = fakeWarden({ autoReady: true });
    warden.addOrphan('o'.repeat(26));
    const { app } = portalApp({ warden });
    const reaper = app.locals.range!.start();
    await vi.waitFor(() => expect(warden.stopped).toContain('o'.repeat(26)));
    reaper.stop();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-reaper.spec.ts`
Expected: FAIL — `src/range/reaper.ts` and `RangePortal.start` do not exist.

- [ ] **Step 3: Implement**

Create `src/range/reaper.ts`:

```ts
// src/range/reaper.ts — the range's housekeeping (spec range §5.7). Every 30 s one pass: flush last-seen, stop expired and
// idle instances, refresh the starting ones, fail the crashed ones (restart policy none: a dead container stays dead),
// remove containers no record owns, and start queued instances in freed slots. On portal start, reconcile the records
// with the warden's list (hvwa.range=1): records without a container are closed, unknown containers removed.
import type { ListedInstance, WardenApi } from '../warden/protocol.js';
import type { Lifecycle } from './lifecycle.js';
import type { RangeLimits } from './types.js';

export const REAPER_INTERVAL_MS = 30_000;

/** Ids of the records that own a container: starting, running (queued ones have none yet). */
const owners = (lc: Lifecycle) => new Set(lc.store.listActive().filter((r) => r.state !== 'queued').map((r) => r.id));

export async function reapOnce(lc: Lifecycle, warden: WardenApi, limits: RangeLimits, now: () => number): Promise<void> {
  lc.flushLastSeen();
  for (const rec of lc.store.listActive()) {
    if (rec.state === 'starting') { await lc.refresh(rec.id); continue; }
    if (rec.state !== 'running') continue;
    const t = now();
    if (rec.expiresAt !== null && t >= rec.expiresAt) { await lc.stopInstance(rec.id, 'expired'); continue; }
    const seen = Math.max(rec.lastSeenAt ?? 0, rec.readyAt ?? rec.startedAt ?? rec.createdAt);
    if (t - seen >= limits.idleMs) await lc.stopInstance(rec.id, 'idle');
  }
  let listed: ListedInstance[];
  try {
    listed = await warden.list();
  } catch {
    await lc.promote();
    return; // the warden is down: nothing is decided from a missing list
  }
  const containers = new Map(listed.map((c) => [c.instanceId, c]));
  for (const rec of lc.store.listByState('running')) {
    const c = containers.get(rec.id);
    if (c === undefined || c.state !== 'running') await lc.fail(rec.id, 'crashed');
  }
  const owned = owners(lc);
  for (const c of listed) {
    if (!owned.has(c.instanceId)) {
      try { await warden.stop(c.instanceId); } catch { /* the next pass retries */ }
    }
  }
  await lc.promote();
}

export async function reconcile(lc: Lifecycle, warden: WardenApi, now: () => number): Promise<void> {
  const listed = await warden.list(); // throws while the warden is down: server.ts logs it; the reaper's passes catch up
  const present = new Set(listed.map((c) => c.instanceId));
  for (const rec of lc.store.listByState('stopping')) {
    lc.store.update(rec.id, { state: 'stopped', reason: rec.reason ?? 'interrupted', endedAt: now() });
  }
  for (const rec of lc.store.listActive()) {
    if (rec.state !== 'queued' && !present.has(rec.id)) lc.store.update(rec.id, { state: 'stopped', reason: 'lost', endedAt: now() });
  }
  const owned = owners(lc);
  for (const c of listed) if (!owned.has(c.instanceId)) await warden.stop(c.instanceId);
  await lc.promote();
}

export interface Reaper { stop(): void }

/** Run `tick` every `intervalMs` (unref'd), skipping a beat while the previous pass still runs. */
export function startReaper(tick: () => Promise<void>, opts: { intervalMs?: number; onError?: (err: unknown) => void } = {}): Reaper {
  const onError = opts.onError ?? ((err: unknown) => console.error('HVWA range: reaper pass failed:', err));
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch(onError).finally(() => { busy = false; });
  }, opts.intervalMs ?? REAPER_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
```

In `src/range/index.ts`, add `import { reapOnce, reconcile, startReaper, type Reaper } from './reaper.js';`, add to `RangePortal`:

```ts
  /** Reconcile with the warden now (logged on failure), then reap every 30 s. server.ts calls it once listening. */
  start(): Reaper;
```

and before the final `return`:

```ts
  const log = opts.log ?? ((line: string) => console.warn(line));
  const start = (): Reaper => {
    reconcile(lifecycle, opts.warden, now).catch((err: unknown) => {
      log(`HVWA range: startup reconcile failed (${err instanceof Error ? err.message : String(err)}); the reaper catches up`);
    });
    return startReaper(() => reapOnce(lifecycle, opts.warden, opts.limits, now));
  };
  return Object.freeze({ isInstanceHost, edge, locals, router, lifecycle, start });
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-reaper.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/reaper.ts src/range/index.ts tests/range-reaper.spec.ts
git commit -m "feat(range): reaper (expiry, idle, crashed, orphans, queue) and startup reconcile"
```

---

### Task 20: Gate tickets, the `hvwa_gate` cookie and `/__hvwa/gate`

**Files:**
- Create: `src/range/tickets.ts`, `src/range/gate.ts`
- Modify: `src/range/types.ts`, `src/range/index.ts`
- Test: `tests/range-gate.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-gate.spec.ts`:

```ts
// The gate (src/range/tickets.ts, src/range/gate.ts, spec range §5.4): "Open lab" mints a single-use 60 s ticket bound to
// (user, instance); /__hvwa/gate on that instance's host trades it for a HOST-ONLY hvwa_gate cookie (HMAC over instance,
// user and expiry) and redirects to the lab. Anything else on an instance host is 404, and no portal cookie lands there.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { GATE_COOKIE, gateKeyOf, mintGateCookie, verifyGateCookie } from '../src/range/gate.js';
import { createTicketStore, TICKET_TTL_MS } from '../src/range/tickets.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { setCookieHeader, setCookieValue } from './helpers.js';
import { createUser, DOMAIN, portalApp, RANGE_KEY, T0, type Kit } from './support/range.js';

const KEY = gateKeyOf(RANGE_KEY);
const ID = 'abcdefghijklmnopqrstuvwxyz';
const host = (id: string) => `i-${id}.${DOMAIN}`;
async function running(kit: Kit, userId: number, labId = 'r01'): Promise<string> {
  const lc = kit.app.locals.range!.lifecycle;
  const r = await lc.launch(userId, labId, 'acolyte');
  if (!r.ok) throw new Error(r.error);
  await lc.refresh(r.instance.id);
  return r.instance.id;
}
const gate = (kit: Kit, id: string, t: string) => request(kit.app).get(`/__hvwa/gate?t=${encodeURIComponent(t)}`).set('Host', host(id));

describe('tickets', () => {
  it('single use, valid 60 s, bound to user and instance, refused when malformed; the store is bounded', () => {
    let t = 0;
    const s = createTicketStore({ now: () => t });
    const a = s.mint(1, ID);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.consume(a)).toEqual({ userId: 1, instanceId: ID });
    expect(s.consume(a)).toBeUndefined();
    const b = s.mint(1, ID);
    t += TICKET_TTL_MS;
    expect(s.consume(b)).toBeUndefined();
    for (const junk of ['x', undefined, ['a'], 'A'.repeat(44)]) expect(s.consume(junk)).toBeUndefined();
    const small = createTicketStore({ max: 2 });
    small.mint(1, ID); small.mint(2, ID); small.mint(3, ID);
    expect(small.size()).toBe(2);
  });
});

describe('the hvwa_gate cookie', () => {
  it('v1.<instance>.<user>.<expiry>.<mac>: verifies only untouched, unexpired, under the right key', () => {
    const c = mintGateCookie(KEY, ID, 42, T0 + 1000);
    expect(c).toMatch(/^v1\.[a-z2-7]{26}\.42\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyGateCookie(KEY, c, T0)).toEqual({ instanceId: ID, userId: 42, expMs: T0 + 1000 });
    expect(verifyGateCookie(KEY, c, T0 + 1000)).toBeUndefined();
    expect(verifyGateCookie(gateKeyOf('o'.repeat(40)), c, T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, c.replace('.42.', '.43.'), T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, c.replace(ID, 'z'.repeat(26)), T0)).toBeUndefined();
    expect(verifyGateCookie(KEY, `${c.slice(0, -1)}${c.endsWith('A') ? 'B' : 'A'}`, T0)).toBeUndefined();
    for (const junk of [undefined, '', 'v2.x', `${c}.x`, 42]) expect(verifyGateCookie(KEY, junk, T0)).toBeUndefined();
  });
});

describe('/__hvwa/gate', () => {
  it('a valid ticket sets hvwa_gate host-only (HttpOnly, SameSite=Lax, Path=/, no Domain, Max-Age to the ceiling) and redirects to /', async () => {
    const kit = portalApp();
    const userId = await createUser(kit.app, 'alice');
    const id = await running(kit, userId);
    const res = await gate(kit, id, kit.app.locals.range!.tickets.mint(userId, id));
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const line = setCookieHeader(res, GATE_COOKIE) ?? '';
    for (const part of [/; HttpOnly/, /; SameSite=Lax/i, /; Path=\//, new RegExp(`Max-Age=${DEFAULT_LIMITS.ceilingMs / 1000};`)]) expect(line).toMatch(part);
    expect(line).not.toMatch(/domain=/i);
    expect(line).not.toMatch(/Secure/);
    expect(setCookieHeader(res, 'hvwa_sid')).toBeUndefined();
    expect(verifyGateCookie(KEY, setCookieValue(res, GATE_COOKIE), T0)).toEqual({ instanceId: id, userId, expMs: T0 + DEFAULT_LIMITS.ceilingMs });
  });

  it('Secure when the range runs behind HTTPS (secureCookies)', async () => {
    const kit = portalApp({ range: { secureCookies: true } });
    const userId = await createUser(kit.app, 'alice');
    const id = await running(kit, userId);
    expect(setCookieHeader(await gate(kit, id, kit.app.locals.range!.tickets.mint(userId, id)), GATE_COOKIE)).toMatch(/; Secure/);
  });

  it('refuses with the 401 page (a link back to the portal, no cookie): replay, expiry, another instance\'s host, stopped, disabled, junk', async () => {
    const kit = portalApp();
    const range = kit.app.locals.range!;
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    const once = range.tickets.mint(alice, a);
    expect((await gate(kit, a, once)).status).toBe(303);
    const refused = async (id: string, ticket: string) => {
      const res = await gate(kit, id, ticket);
      expect(res.status).toBe(401);
      expect(res.text).toContain(`href="https://${DOMAIN}/"`);
      expect(setCookieHeader(res, GATE_COOKIE)).toBeUndefined();
    };
    await refused(a, once);                                       // single use
    const late = range.tickets.mint(alice, a);
    kit.clock.advance(TICKET_TTL_MS + 1);
    await refused(a, late);                                       // 60 s
    await refused(b, range.tickets.mint(alice, a));               // bound to the instance
    await refused(b, range.tickets.mint(alice, b));               // bound to the owner
    await refused(a, 'not-a-ticket');
    kit.app.locals.auth!.setDisabled(1, alice, true);
    await refused(a, range.tickets.mint(alice, a));               // account disabled
    await range.lifecycle.stop(bob);
    await refused(b, range.tickets.mint(bob, b));                 // instance stopped
  });

  it('everything else on an instance host is 404 (POST to the gate too), without any portal cookie', async () => {
    const kit = portalApp();
    for (const [method, path] of [['get', '/'], ['get', '/__hvwa/auth'], ['post', '/__hvwa/gate'], ['get', '/login']] as const) {
      const res = await request(kit.app)[method](path).set('Host', host(ID));
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.headers['set-cookie'], `${method} ${path}`).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-gate.spec.ts`
Expected: FAIL — `src/range/tickets.ts` and `src/range/gate.ts` do not exist.

- [ ] **Step 3: Implement**

Create `src/range/tickets.ts`:

```ts
// src/range/tickets.ts — gate tickets (spec range §5.4): the one-time hop from the portal to an instance host. A ticket
// is 32 random bytes (base64url, 43 characters), valid ONCE and for 60 s, bound to (user, instance). Kept in the
// portal's memory under its SHA-256 only; deleted at its first presentation whatever happens next; a portal restart
// voids open tickets (the player clicks Open lab again). Bounded: at most `max` live tickets, the oldest dropped first.
import { createHash, randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 60_000;
export const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
export interface TicketClaims { readonly userId: number; readonly instanceId: string }

export interface TicketStore {
  mint(userId: number, instanceId: string): string;
  /** The claims of a live ticket, which is spent by this call; undefined for anything else. */
  consume(ticket: unknown): TicketClaims | undefined;
  size(): number;
}

export function createTicketStore(opts: { now?: () => number; ttlMs?: number; max?: number } = {}): TicketStore {
  const now = opts.now ?? Date.now;
  const ttlMs = opts.ttlMs ?? TICKET_TTL_MS;
  const max = opts.max ?? 10_000;
  const tickets = new Map<string, TicketClaims & { readonly expiresAt: number }>();
  const digest = (ticket: string) => createHash('sha256').update(ticket).digest('hex');
  return Object.freeze({
    mint(userId: number, instanceId: string): string {
      const t = now();
      for (const [k, v] of tickets) if (v.expiresAt <= t) tickets.delete(k);
      while (tickets.size >= max) {
        const oldest = tickets.keys().next().value;
        if (oldest === undefined) break;
        tickets.delete(oldest);
      }
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(digest(ticket), { userId, instanceId, expiresAt: t + ttlMs });
      return ticket;
    },
    consume(ticket: unknown): TicketClaims | undefined {
      if (typeof ticket !== 'string' || !TICKET_RE.test(ticket)) return undefined;
      const key = digest(ticket);
      const claims = tickets.get(key);
      tickets.delete(key);
      if (!claims || claims.expiresAt <= now()) return undefined;
      return { userId: claims.userId, instanceId: claims.instanceId };
    },
    size: () => tickets.size,
  });
}
```

Create `src/range/gate.ts`:

```ts
// src/range/gate.ts — the gate between a portal sign-in and an instance host (spec range §5.4-§5.5). PLATFORM code.
//
// GET /__hvwa/gate?t=<ticket> on i-<id>.<domain>: Traefik routes /__hvwa/* of an instance host to the portal (router
// g-<id>, priority 1000, no forward-auth). The single-use ticket must name THIS instance; its user must own it, it must be
// running, the account active. Then `hvwa_gate` is set HOST-ONLY on that instance host and the browser goes to the lab's /.
//
//   hvwa_gate = v1.<instanceId>.<userId>.<expMs>.<mac>
//   mac       = base64url(HMAC-SHA256(gateKey, "gate|v1|" + instanceId + "|" + userId + "|" + expMs))
//   gateKey   = HMAC-SHA256(rangeKey, "hvwa-gate-key|v1")   (domain-separated from the flag MAC)
//   attributes: HttpOnly, SameSite=Lax, Path=/, no Domain, Secure behind HTTPS, Max-Age until expMs, where
//   expMs = started_at + HVWA_RANGE_CEILING_MIN (the instance's longest possible life; forward-auth still requires it to
//   be running, so a stopped instance is closed at once).
//
// Every other request on an instance host, on the internal host, or for /__hvwa/* elsewhere ends here with 404, before
// the session middleware: no portal cookie is ever set on a lab host.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { escapeHtml } from '../core/render.js';
import { hostnameOf } from '../core/host-guard.js';
import { instanceIdOfHost, portalOrigin } from './hosts.js';
import type { InstanceRecord } from './store.js';
import type { RangeContext } from './types.js';

export const GATE_COOKIE = 'hvwa_gate';
export interface GateClaims { readonly instanceId: string; readonly userId: number; readonly expMs: number }

export function gateKeyOf(rangeKey: string): Buffer {
  return createHmac('sha256', rangeKey).update('hvwa-gate-key|v1').digest();
}
const macOf = (key: Buffer, instanceId: string, userId: number, expMs: number) =>
  createHmac('sha256', key).update(`gate|v1|${instanceId}|${userId}|${expMs}`).digest('base64url');

export function mintGateCookie(key: Buffer, instanceId: string, userId: number, expMs: number): string {
  return `v1.${instanceId}.${userId}.${expMs}.${macOf(key, instanceId, userId, expMs)}`;
}

const COOKIE_RE = /^v1\.([a-z2-7]{26})\.([1-9]\d{0,15})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/;

/** Stateless check: format, MAC (constant time), expiry. Ownership and state are the caller's (the DB). */
export function verifyGateCookie(key: Buffer, raw: unknown, now: number): GateClaims | undefined {
  if (typeof raw !== 'string' || raw.length > 160) return undefined;
  const m = COOKIE_RE.exec(raw);
  if (!m) return undefined;
  const [, instanceId, uid, exp, mac] = m;
  const userId = Number(uid);
  const expMs = Number(exp);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(expMs) || expMs <= now) return undefined;
  const want = Buffer.from(macOf(key, instanceId, userId, expMs));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? { instanceId, userId, expMs } : undefined;
}

/** The 401 of the gate and of forward-auth: self-contained (a lab host has no /static), one link back to the portal. */
export function deniedPage(portalUrl: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>401 Lab not open here</title></head><body><main>'
    + '<h1>This lab is not open in this browser</h1>'
    + '<p>Labs open only from your account on the HVWA portal, and only while they run. Open it again from the portal.</p>'
    + `<p><a href="${escapeHtml(portalUrl)}">Back to the HVWA portal</a></p>`
    + '</main></body></html>';
}

const notFound = (res: Response) => { res.set('Cache-Control', 'no-store'); res.status(404).type('text/plain').send('Not found\n'); };

/** What `edge` answers: the gate on instance hosts, 404 for the rest of them, the internal host and /__hvwa/* anywhere. */
export function edgeHandler(ctx: RangeContext): RequestHandler {
  const { opts, lifecycle, tickets, auth } = ctx;
  const gateKey = gateKeyOf(opts.rangeKey);
  const portalUrl = `${portalOrigin(opts.portalHost, opts.publicScheme ?? 'https', opts.publicPort)}/`;

  const deny = (res: Response) => {
    res.status(401).set({
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    }).type('html').send(deniedPage(portalUrl));
  };
  /** The record when the instance is running, owned by `userId`, and that account is active. */
  const owned = (instanceId: string, userId: number): InstanceRecord | undefined => {
    const rec = lifecycle.store.get(instanceId);
    return rec !== undefined && rec.state === 'running' && rec.userId === userId && auth.service.isActive(userId) ? rec : undefined;
  };

  function gate(req: Request, res: Response, instanceId: string): void {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer'); // the ticket never travels on in a Referer
    const claims = tickets.consume(req.query.t);
    const rec = claims !== undefined && claims.instanceId === instanceId ? owned(instanceId, claims.userId) : undefined;
    if (!claims || !rec || rec.startedAt === null) { deny(res); return; }
    const expMs = rec.startedAt + opts.limits.ceilingMs;
    res.cookie(GATE_COOKIE, mintGateCookie(gateKey, instanceId, claims.userId, expMs), {
      httpOnly: true, sameSite: 'lax', path: '/', secure: opts.secureCookies === true, maxAge: Math.max(0, expMs - ctx.now()),
    });
    lifecycle.touch(instanceId);
    res.redirect(303, '/');
  }

  return (req, res, next) => {
    const host = hostnameOf(req.headers.host);
    const instanceId = host === undefined ? undefined : instanceIdOfHost(host, opts.domain);
    if (instanceId !== undefined) {
      if (req.method === 'GET' && req.path === '/__hvwa/gate') { gate(req, res, instanceId); return; }
      notFound(res);
      return;
    }
    if (host === opts.internalHost || /^\/__hvwa(?:\/|$)/i.test(req.path)) { notFound(res); return; }
    next();
  };
}
```

In `src/range/types.ts`, add `import type { TicketStore } from './tickets.js';` and to `RangeContext`:

```ts
  readonly tickets: TicketStore;
```

In `src/range/index.ts`:

1. Add the imports `import { edgeHandler } from './gate.js';` and `import { createTicketStore, type TicketStore } from './tickets.js';`, and remove the now unused `hostnameOf` import.
2. `RangePortal` gains:

```ts
  /** The gate tickets ("Open lab" mints one; /__hvwa/gate spends it). */
  readonly tickets: TicketStore;
```

3. Build the tickets into the context and replace the whole inline `edge` handler with the gate's:

```ts
  const tickets = createTicketStore({ now });
  const ctx: RangeContext = { db, auth, opts, registry: opts.registry, now, lifecycle, tickets };
  const isInstanceHost = (hostname: string) => instanceIdOfHost(hostname, opts.domain) !== undefined;
  const edge = edgeHandler(ctx);
```

4. Return it: `return Object.freeze({ isInstanceHost, edge, locals, router, lifecycle, tickets, start });`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-gate.spec.ts tests/portal-mode.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/tickets.ts src/range/gate.ts src/range/types.ts src/range/index.ts tests/range-gate.spec.ts
git commit -m "feat(range): single-use gate tickets and the host-only hvwa_gate cookie via /__hvwa/gate"
```

---

### Task 21: Forward-auth: `/__hvwa/auth`

**Files:**
- Modify: `src/range/gate.ts`, `src/range/types.ts`, `tests/support/range.ts`
- Test: `tests/range-forward-auth.spec.ts`

What the endpoint trusts, and why:

- **Who can reach it.** Only Traefik. The portal is on the internal `edge` network (Traefik only) and the internal `control` network (warden, write socket proxy); instances have no route to it; Traefik itself is reached only by `cloudflared` (no published ports, its one entrypoint listens on its `hvwa-edge` address, plan D3). Traefik calls `http://portal:1337/__hvwa/auth`, so the request's `Host` is the internal name `portal`. The portal answers `/__hvwa/auth` **only** on that host (`internalHost`); through Traefik a player can never send `Host: portal` (no router matches it), and `/__hvwa/*` on an instance host is the gate router, where `/__hvwa/auth` is a 404.
- **The shared header secret.** Traefik's `hvwa-auth-secret` middleware sets `X-Hvwa-Auth-Secret: <HVWA_FORWARD_AUTH_SECRET>`; `forwardAuth` copies it (`authRequestHeaders: [Cookie, X-Hvwa-Auth-Secret]`); `hvwa-strip-secret` removes it before the instance sees the request (plan D4). The portal compares it in constant time (SHA-256 of both). Missing or wrong: `403` (a misconfiguration, not a player error).
- **The headers Traefik sends.** With `trustForwardHeader: false` Traefik discards client-sent `X-Forwarded-*` and sets them itself: `X-Forwarded-Host` (the instance host, maybe with a port), `X-Forwarded-Uri` (path + query), `X-Forwarded-Method`, `X-Forwarded-Proto`, `X-Forwarded-For`, plus the copied `Cookie`. Absent `X-Forwarded-Host`/`-Uri`/`-Method` means the caller is not Traefik: `403`.
- **The decision.** Instance id from `X-Forwarded-Host` (must be `i-<26 base32>.<domain>`); `X-Forwarded-Uri` must not be `/__hvwa/*` (that router never uses forward-auth); `hvwa_gate` verified statelessly (format, MAC, expiry) and bound to that same instance; then one primary-key read: the instance is `running`, owned by the cookie's user, whose account is active. Pass: `200`, empty body, last-seen recorded in memory (flushed every 30 s by the reaper). Anything else: `401` with the page linking back to the portal (Traefik relays it to the browser).

- [ ] **Step 1: Write the failing test**

In `tests/support/range.ts`, add

```ts
export const FORWARD_SECRET = 'f'.repeat(40);
```

and add `forwardAuthSecret: FORWARD_SECRET,` to the `range` options in `portalApp` (next to `rangeKey: RANGE_KEY,`).

Create `tests/range-forward-auth.spec.ts`:

```ts
// Forward-auth (src/range/gate.ts, spec range §5.5): Traefik asks GET http://portal:1337/__hvwa/auth before every request
// to an instance host. Pass = the internal host, the shared secret, Traefik's X-Forwarded-* and a valid hvwa_gate for
// THAT instance, which must be running, owned by the cookie's user, whose account is active. Fail = 401 + a link home.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { GATE_COOKIE, gateKeyOf, mintGateCookie } from '../src/range/gate.js';
import { DEFAULT_LIMITS } from '../src/range/types.js';
import { createUser, DOMAIN, FORWARD_SECRET, portalApp, RANGE_KEY, T0, type Kit } from './support/range.js';

const KEY = gateKeyOf(RANGE_KEY);
async function running(kit: Kit, userId: number): Promise<string> {
  const lc = kit.app.locals.range!.lifecycle;
  const r = await lc.launch(userId, 'r01', 'acolyte');
  if (!r.ok) throw new Error(r.error);
  await lc.refresh(r.instance.id);
  return r.instance.id;
}
const cookieFor = (id: string, userId: number, exp = T0 + DEFAULT_LIMITS.ceilingMs) => mintGateCookie(KEY, id, userId, exp);
function ask(kit: Kit, h: { host?: string; secret?: string | null; fhost?: string | null; uri?: string | null; method?: string | null; cookie?: string }) {
  let r = request(kit.app).get('/__hvwa/auth').set('Host', h.host ?? 'portal');
  if (h.secret !== null) r = r.set('X-Hvwa-Auth-Secret', h.secret ?? FORWARD_SECRET);
  if (h.fhost !== null && h.fhost !== undefined) r = r.set('X-Forwarded-Host', h.fhost);
  if (h.uri !== null) r = r.set('X-Forwarded-Uri', h.uri ?? '/');
  if (h.method !== null) r = r.set('X-Forwarded-Method', h.method ?? 'GET');
  if (h.cookie !== undefined) r = r.set('Cookie', `${GATE_COOKIE}=${h.cookie}`);
  return r;
}

describe('/__hvwa/auth', () => {
  it('passes the owner\'s cookie for its running instance: 200, empty, no-store, no cookie set, last-seen recorded', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    const res = await ask(kit, { fhost: `i-${id}.${DOMAIN}:8080`, uri: '/patients?id=1', cookie: cookieFor(id, alice) });
    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['set-cookie']).toBeUndefined();
    const lc = kit.app.locals.range!.lifecycle;
    lc.flushLastSeen();
    expect(lc.store.get(id)?.lastSeenAt).toBe(T0);
  });

  it('answers only on the internal host (404 elsewhere) and only to GET', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    for (const host of [DOMAIN, `i-${id}.${DOMAIN}`]) {
      expect((await ask(kit, { host, fhost: `i-${id}.${DOMAIN}`, cookie: cookieFor(id, alice) })).status, host).toBe(404);
    }
    expect((await request(kit.app).post('/__hvwa/auth').set('Host', 'portal').set('X-Hvwa-Auth-Secret', FORWARD_SECRET)).status).toBe(404);
  });

  it('403 without the shared secret or without Traefik\'s X-Forwarded-* headers', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const id = await running(kit, alice);
    const fhost = `i-${id}.${DOMAIN}`;
    const cookie = cookieFor(id, alice);
    for (const h of [{ secret: null }, { secret: 'f'.repeat(39) }, { secret: `${FORWARD_SECRET}x` }, { fhost: null }, { uri: null }, { method: null }]) {
      const res = await ask(kit, { fhost, cookie, ...h });
      expect(res.status, JSON.stringify(h)).toBe(403);
      expect(res.text).toBe('forward-auth: refused\n');
    }
  });

  it('401 with the page home: no cookie, a forged or expired one, another instance\'s, the gate path, a foreign host', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    const fa = `i-${a}.${DOMAIN}`;
    const cases: Parameters<typeof ask>[1][] = [
      { fhost: fa },
      { fhost: fa, cookie: 'v1.junk' },
      { fhost: fa, cookie: cookieFor(a, bob) },              // bob forging alice's instance: MAC is fine (we mint it) but bob does not own it
      { fhost: fa, cookie: cookieFor(b, bob) },              // bob's own cookie, alice's host
      { fhost: fa, cookie: mintGateCookie(gateKeyOf('x'.repeat(40)), a, alice, T0 + 1000) },
      { fhost: fa, cookie: cookieFor(a, alice, T0) },        // expired
      { fhost: fa, cookie: cookieFor(a, alice), uri: '/__hvwa/gate?t=x' },
      { fhost: `i-${a}.evil.example`, cookie: cookieFor(a, alice) },
      { fhost: `${fa},evil.example`, cookie: cookieFor(a, alice) },
    ];
    for (const h of cases) {
      const res = await ask(kit, h);
      expect(res.status, JSON.stringify(h)).toBe(401);
      expect(res.text).toContain(`href="https://${DOMAIN}/"`);
      expect(res.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });

  it('401 once the instance stops or the account is disabled, whatever the cookie says', async () => {
    const kit = portalApp();
    const alice = await createUser(kit.app, 'alice');
    const bob = await createUser(kit.app, 'bob');
    const a = await running(kit, alice);
    const b = await running(kit, bob);
    expect((await ask(kit, { fhost: `i-${a}.${DOMAIN}`, cookie: cookieFor(a, alice) })).status).toBe(200);
    await kit.app.locals.range!.lifecycle.stop(alice);
    expect((await ask(kit, { fhost: `i-${a}.${DOMAIN}`, cookie: cookieFor(a, alice) })).status).toBe(401);
    kit.app.locals.auth!.setDisabled(1, bob, true);
    expect((await ask(kit, { fhost: `i-${b}.${DOMAIN}`, cookie: cookieFor(b, bob) })).status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-forward-auth.spec.ts`
Expected: FAIL — `/__hvwa/auth` is a 404 on the internal host, and `forwardAuthSecret` is not an option yet (typecheck).

- [ ] **Step 3: Implement**

In `src/range/types.ts`, `RangePortalOptions` gains:

```ts
  /** HVWA_FORWARD_AUTH_SECRET: Traefik sends it as X-Hvwa-Auth-Secret on every forward-auth call. */
  readonly forwardAuthSecret: string;
```

In `src/range/gate.ts`:

1. The crypto import becomes `import { createHash, createHmac, timingSafeEqual } from 'node:crypto';`.
2. Inside `edgeHandler`, after `owned`, add:

```ts
  const secretDigest = createHash('sha256').update(opts.forwardAuthSecret, 'utf8').digest();
  const secretOk = (v: string | undefined) =>
    v !== undefined && timingSafeEqual(createHash('sha256').update(v, 'utf8').digest(), secretDigest);
  const refused = (res: Response) => { res.status(403).type('text/plain').send('forward-auth: refused\n'); };

  /** Traefik's forwardAuth call for one request to an instance host (see the task notes: what it trusts and why). */
  function forwardAuth(req: Request, res: Response): void {
    res.set('Cache-Control', 'no-store');
    if (!secretOk(req.get('x-hvwa-auth-secret'))) { refused(res); return; }
    const method = req.get('x-forwarded-method');
    const uri = req.get('x-forwarded-uri');
    const forwardedHost = hostnameOf(req.get('x-forwarded-host'));
    if (!method || uri === undefined || forwardedHost === undefined) { refused(res); return; }
    const instanceId = instanceIdOfHost(forwardedHost, opts.domain);
    if (instanceId === undefined || /^\/__hvwa(?:\/|$)/i.test(uri)) { deny(res); return; }
    const claims = verifyGateCookie(gateKey, req.cookies?.[GATE_COOKIE], ctx.now());
    if (!claims || claims.instanceId !== instanceId || !owned(instanceId, claims.userId)) { deny(res); return; }
    lifecycle.touch(instanceId);
    res.status(200).end();
  }
```

3. In the returned handler, the internal-host branch answers forward-auth:

```ts
    if (host === opts.internalHost) {
      if (req.method === 'GET' && req.path === '/__hvwa/auth') { forwardAuth(req, res); return; }
      notFound(res);
      return;
    }
    if (/^\/__hvwa(?:\/|$)/i.test(req.path)) { notFound(res); return; }
    next();
```

(replacing the line `if (host === opts.internalHost || /^\/__hvwa(?:\/|$)/i.test(req.path)) { notFound(res); return; }`).

4. Extend the file's header comment with:

```ts
// GET /__hvwa/auth on the internal host (Traefik's forwardAuth, http://portal:1337): the shared secret header, Traefik's
// X-Forwarded-Host/-Uri/-Method, then hvwa_gate verified statelessly and bound to the X-Forwarded-Host's instance, which
// must be running, owned by the cookie's user, whose account is active. 200 = pass (last-seen kept in memory); 401 = the
// page home; 403 = not Traefik (no secret, no X-Forwarded-*).
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-forward-auth.spec.ts tests/range-gate.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/gate.ts src/range/types.ts tests/support/range.ts tests/range-forward-auth.spec.ts
git commit -m "feat(range): forward-auth /__hvwa/auth: shared secret, stateless gate cookie, ownership, last-seen"
```

---

### Task 22: Flag submission against the submitter's own instances

**Files:**
- Create: `src/range/submit.ts`, `src/range/lab-routes.ts`
- Modify: `src/range/catalog.ts` (the page's one-shot result), `src/range/views/lab.ejs` (the flag form), `src/range/index.ts`, `src/core/i18n.ts`
- Test: `tests/range-submit.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-submit.spec.ts`:

```ts
// Flag submission (src/range/submit.ts, spec range §6): a flag counts only when it equals the flag of one of the
// SUBMITTING user's instances of that lab, created within the last 24 h; the level comes from that record. A flag
// copied from another user never matches. htmx gets the result fragment; a plain form a 303 back to the lab page.
import { describe, it, expect } from 'vitest';
import { FLAG_WINDOW_MS } from '../src/range/submit.js';
import { csrfOf } from './helpers.js';
import { player, portalApp, type Agent, type Kit } from './support/range.js';

async function launched(kit: Kit, userId: number, labId: string, level: 'acolyte' | 'templar' | 'inquisitor' | 'divine') {
  const r = await kit.app.locals.range!.lifecycle.launch(userId, labId, level);
  if (!r.ok) throw new Error(r.error);
  return kit.warden.launched.at(-1)!.flag; // what the lab container received as HVWA_FLAG
}
async function submit(agent: Agent, labId: string, flag: string, htmx = true) {
  const csrf = csrfOf((await agent.get(`/labs/${labId}`)).text);
  const req = agent.post(`/labs/${labId}/submit`).type('form');
  return (htmx ? req.set('HX-Request', 'true') : req).send({ _csrf: csrf, submission: flag });
}
const result = (html: string) => /data-result="([a-z_]+)"/.exec(html)?.[1];

describe('POST /labs/:id/submit', () => {
  it('the flag of my own instance scores its level (Templar of an Easy lab: 150) and lands on the leaderboard', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const flag = await launched(kit, alice.userId, 'r01', 'templar');
    const res = await submit(alice.agent, 'r01', `  ${flag}  `);
    expect(result(res.text)).toBe('new_best');
    expect(res.text).toContain('+150');
    expect((await alice.agent.get('/')).text).toContain('data-testid="range-score">150<');
    expect((await alice.agent.get('/leaderboard')).text).toContain('data-user="alice"');
  });

  it('another user\'s flag never counts, either way; nor a flag of another lab; nor a made-up one', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const bob = await player(kit.app, 'bob');
    const aliceFlag = await launched(kit, alice.userId, 'r01', 'acolyte');
    const bobFlag = await launched(kit, bob.userId, 'r01', 'acolyte');
    expect(result((await submit(bob.agent, 'r01', aliceFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', bobFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r02', aliceFlag!)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', `HVWA{${'a'.repeat(26)}}`)).text)).toBe('wrong');
    expect(result((await submit(alice.agent, 'r01', '')).text)).toBe('wrong');
  });

  it('already / lower; a stopped instance\'s flag still counts within 24 h, not after', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    const templar = await launched(kit, alice.userId, 'r01', 'templar');
    const acolyte = await launched(kit, alice.userId, 'r01', 'acolyte'); // replaces the Templar instance
    expect(result((await submit(alice.agent, 'r01', templar!)).text)).toBe('new_best');
    expect(result((await submit(alice.agent, 'r01', templar!)).text)).toBe('already');
    expect(result((await submit(alice.agent, 'r01', acolyte!)).text)).toBe('lower');
    const late = await launched(kit, alice.userId, 'r01', 'inquisitor');
    await kit.app.locals.range!.lifecycle.stop(alice.userId);
    kit.clock.advance(FLAG_WINDOW_MS + 1);
    expect(result((await submit(alice.agent, 'r01', late!)).text)).toBe('wrong');
  });

  it('Divine issues no flag; a plain form gets a 303 and the page shows the result; the account CSRF token is required', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    expect(await launched(kit, alice.userId, 'r01', 'divine')).toBeUndefined();
    const flag = await launched(kit, alice.userId, 'r01', 'acolyte');
    const plain = await submit(alice.agent, 'r01', flag!, false);
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe('/labs/r01?r=solved');
    expect((await alice.agent.get('/labs/r01?r=solved')).text).toContain('data-result="solved"');
    expect((await submit(alice.agent, 'r01', 'nope', false)).headers.location).toBe('/labs/r01?r=wrong');
    expect((await alice.agent.post('/labs/r01/submit').type('form').send({ submission: flag })).status).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-submit.spec.ts`
Expected: FAIL — `src/range/submit.ts` does not exist and `/labs/:id/submit` is a 404.

- [ ] **Step 3: Implement**

Create `src/range/submit.ts`:

```ts
// src/range/submit.ts — flag submission (spec range §6): a flag counts when it equals the flag of one of the SUBMITTING
// user's instances of this lab, created within the last 24 h. Records keep the flag's SHA-256, so the lookup is by hash;
// the level comes from that record, never from the client. A flag from another user's instance never matches.
import type { DatabaseSync } from 'node:sqlite';
import { escapeHtml } from '../core/render.js';
import type { Level } from '../core/levels.js';
import { labPoints, type LabEntry } from '../lab-registry.js';
import { flagHash, RANGE_FLAG_RE } from './flags.js';
import { recordRangeSolve, type Best } from './progress.js';
import type { InstanceStore } from './store.js';

export const FLAG_WINDOW_MS = 24 * 60 * 60_000;

export type RangeSubmitResult =
  | { readonly status: 'wrong' }
  | { readonly status: 'new_best' | 'same_or_lower'; readonly level: Level; readonly points: number; readonly gained: number; readonly best: Best };

export function submitRangeFlag(db: DatabaseSync, store: InstanceStore, lab: LabEntry, userId: number, submission: string, now: number): RangeSubmitResult {
  const flag = submission.trim();
  if (!RANGE_FLAG_RE.test(flag)) return { status: 'wrong' };
  const level = store.levelForFlag(userId, lab.id, flagHash(flag), now - FLAG_WINDOW_MS);
  if (level === undefined || level === 'divine') return { status: 'wrong' };
  const points = labPoints(lab, level);
  const r = recordRangeSolve(db, userId, lab.id, level, points, now);
  return { status: r.status, level, points, gained: r.gained, best: r.best };
}

/** The htmx fragment (escaped): the same wording and hooks as the standalone portal's result. */
export function submitResultHtml(r: RangeSubmitResult, t: (key: string) => string): string {
  if (r.status === 'wrong') {
    return `<p class="result result-bad" data-solved="false" data-result="wrong" role="status">${escapeHtml(t('challenge.result_bad'))}</p>`;
  }
  const key = r.status === 'new_best' ? 'new_best' : r.level === r.best.level ? 'already' : 'lower';
  const level = t(`level.${r.level}`);
  const msg = key === 'new_best'
    ? `${t('challenge.result_new_best')} ${level} (+${r.gained} ${t('challenge.points')})`
    : key === 'lower' ? `${t('challenge.result_lower')} ${t(`level.${r.best.level}`)}` : `${t('challenge.result_already')} ${level}`;
  return `<p class="result result-ok" data-solved="true" data-result="${key}" role="status">${escapeHtml(msg)}</p>`;
}
```

Create `src/range/lab-routes.ts`:

```ts
// src/range/lab-routes.ts — the range's lab actions (portal mode). Every POST is an account form (formOk: Origin,
// Sec-Fetch-Site, the token bound to hvwa_sid and hvwa_auth); htmx gets a fragment, a plain form a 303.
import type { Router } from 'express';
import { field } from '../core/lab.js';
import { isHtmx, userOf } from './catalog.js';
import { submitRangeFlag, submitResultHtml } from './submit.js';
import type { RangeContext } from './types.js';

export function labRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth, lifecycle } = ctx;

  router.post('/labs/:id/submit', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const result = submitRangeFlag(db, lifecycle.store, lab, userOf(res).userId, field(req, 'submission'), ctx.now());
    if (isHtmx(req)) { res.type('html').send(submitResultHtml(result, res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}?r=${result.status === 'wrong' ? 'wrong' : 'solved'}`);
  });
}
```

In `src/range/index.ts`, add `import { labRoutes } from './lab-routes.js';` and after `catalogRoutes(router, ctx);` add `labRoutes(router, ctx);`.

In `src/range/catalog.ts`, the `GET /labs/:id` handler passes the one-shot result (a closed set; `solved` is shown only when a best solve exists, and its text comes from the DB):

```ts
      flash: req.query.r === 'wrong' ? 'wrong' : req.query.r === 'solved' && best ? 'solved' : '',
```

(added to the `sendPage` data object, after `best, currentLevel, csrf: auth.csrfFor(req),`).

In `src/range/views/lab.ejs`, after the hints `</section>` (still inside `player-main`) add:

```ejs
    <section class="card panel" aria-labelledby="submit-title">
      <h2 id="submit-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flag"></use></svg><%= t('challenge.submit_heading') %></h2>
      <form method="post" action="/labs/<%= lab.id %>/submit" hx-post="/labs/<%= lab.id %>/submit" hx-target="#submit-result" hx-swap="innerHTML" class="submit-form">
        <input type="hidden" name="_csrf" value="<%= csrf %>">
        <label class="label" for="flag-input"><%= t('challenge.submit_label') %></label>
        <div class="form-row">
          <div class="field"><input id="flag-input" class="input input-mono" type="text" name="submission" autocomplete="off" spellcheck="false" placeholder="HVWA{…}" aria-describedby="flag-help" required></div>
          <button type="submit" class="btn btn-primary"><%= t('challenge.submit_button') %></button>
        </div>
        <p class="help" id="flag-help"><%= t('range.submit_help') %></p>
      </form>
      <div id="submit-result" aria-live="polite">
<% if (flash === 'wrong') { -%>
        <p class="result result-bad" data-solved="false" data-result="wrong" role="status"><%= t('challenge.result_bad') %></p>
<% } else if (flash === 'solved') { -%>
        <p class="result result-ok" data-solved="true" data-result="solved" role="status"><%= t('challenge.solved_at').replace('{level}', t('level.' + best.level)) %></p>
<% } -%>
      </div>
    </section>
```

In `src/core/i18n.ts`, add after `'range.howto3'`:

```ts
  'range.submit_help': {
    id: 'Flag hanya berlaku untuk instans milik Anda sendiri dari lab ini, selama 24 jam setelah dijalankan.',
    en: 'A flag counts only from your own instance of this lab, for 24 hours after it was launched.',
  },
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-submit.spec.ts tests/portal-mode.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/submit.ts src/range/lab-routes.ts src/range/catalog.ts src/range/views/lab.ejs src/range/index.ts src/core/i18n.ts tests/range-submit.spec.ts
git commit -m "feat(range): flag submission bound to the submitter's own instances within 24 h"
```

---

### Task 23: The Lab panel (htmx), "My Lab" in the header, and the admin's instance page

**Files:**
- Create: `src/range/panel.ts`, `src/range/admin.ts`, `src/range/views/panel.ejs`, `src/range/views/admin-range.ejs`, `src/core/views/my-lab.ejs`
- Modify: `src/range/lab-routes.ts`, `src/range/catalog.ts`, `src/range/views/lab.ejs`, `src/range/index.ts`, `src/core/render.ts` (`MY_LAB_VIEW`), `src/core/views/layout.ejs`, `src/auth/views/admin-nav.ejs`, `src/core/i18n.ts`, `src/public/app.css`, `docs/UI.md`
- Test: `tests/range-panel.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-panel.spec.ts`:

```ts
// The Lab panel (src/range/panel.ts, lab-routes.ts, spec range §10): state, time left, Launch / Open lab / Extend / Reset /
// Stop, the queue position, htmx polling (1 s starting, 2 s queued, 30 s running); "My Lab" in the header on every page;
// and the admin's instance page (capacity, queue, stop).
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { csrfOf } from './helpers.js';
import { fakeWarden } from './support/fake-warden.js';
import { DOMAIN, player, portalApp, signInAdmin, type Agent } from './support/range.js';

const panelOf = (html: string) => /<section id="lab-panel"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const stateOf = (html: string) => /data-testid="lab-panel" data-state="([a-z]+)"/.exec(html)?.[1];
async function act(agent: Agent, labId: string, action: string, level = 'acolyte', htmx = true) {
  const csrf = csrfOf((await agent.get(`/labs/${labId}?level=${level}`)).text);
  const req = agent.post(`/labs/${labId}/${action}`).type('form');
  return (htmx ? req.set('HX-Request', 'true') : req).send({ _csrf: csrf, level });
}

describe('the Lab panel', () => {
  it('none -> Launch -> starting (polls every 1 s) -> running (polls every 30 s): time left, Open, Extend, Reset, Stop', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    const page = panelOf((await agent.get('/labs/r01?level=acolyte')).text);
    expect(stateOf(page)).toBe('none');
    expect(page).toContain('data-testid="lab-launch"');
    expect(page).not.toContain('hx-trigger');
    const started = await act(agent, 'r01', 'launch');
    expect(started.status).toBe(200);
    expect(stateOf(started.text)).toBe('starting');
    expect(started.text).toContain('hx-trigger="every 1s"');
    const polled = (await agent.get('/labs/r01/panel?level=acolyte').set('HX-Request', 'true')).text; // refresh: fake warden is ready
    expect(stateOf(polled)).toBe('running');
    expect(polled).toContain('hx-trigger="every 30s"');
    expect(polled).toContain('data-testid="time-left">120 min left<');
    for (const hook of ['lab-open', 'lab-extend', 'lab-reset', 'lab-stop']) expect(polled).toContain(`data-testid="${hook}"`);
  });

  it('Launch needs the account CSRF token; a plain form gets a 303 to the lab page at that level', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    expect((await agent.post('/labs/r01/launch').type('form').send({ level: 'acolyte' })).status).toBe(403);
    expect(kit.warden.launched).toEqual([]);
    const plain = await act(agent, 'r01', 'launch', 'templar', false);
    expect(plain.status).toBe(303);
    expect(plain.headers.location).toBe('/labs/r01?level=templar');
    expect((await act(agent, 'r01', 'launch', 'nope')).status).toBe(400);
  });

  it('Open lab: a 303 to the instance host\'s gate with a fresh ticket, which the gate accepts (the full hop)', async () => {
    const kit = portalApp({ range: { publicPort: 18443 } });
    const { agent } = await player(kit.app, 'alice');
    await act(agent, 'r01', 'launch');
    await agent.get('/labs/r01/panel?level=acolyte');
    const open = await act(agent, 'r01', 'open', 'acolyte', false);
    expect(open.status).toBe(303);
    expect(open.headers['cache-control']).toBe('no-store');
    const location = new URL(open.headers.location as string);
    expect(location.origin).toMatch(new RegExp(`^https://i-[a-z2-7]{26}\\.${DOMAIN.replace('.', '\\.')}:18443$`));
    expect(location.pathname).toBe('/__hvwa/gate');
    const hop = await request(kit.app).get(`${location.pathname}${location.search}`).set('Host', location.host);
    expect(hop.status).toBe(303);
    expect(hop.headers['set-cookie']?.[0]).toMatch(/^hvwa_gate=v1\./);
  });

  it('Open lab without a running instance of this lab goes back to the lab page', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    const open = await act(agent, 'r01', 'open', 'acolyte', false);
    expect(open.headers.location).toBe('/labs/r01');
  });

  it('Extend adds 30 min; Reset is a new instance; Stop removes it; actions on another lab\'s panel change nothing', async () => {
    const kit = portalApp();
    const { agent, userId } = await player(kit.app, 'alice');
    await act(agent, 'r01', 'launch');
    await agent.get('/labs/r01/panel?level=acolyte');
    expect((await act(agent, 'r01', 'extend')).text).toContain('data-testid="time-left">150 min left<');
    const before = kit.app.locals.range!.lifecycle.current(userId)!.id;
    await act(agent, 'r02', 'stop');
    expect(kit.app.locals.range!.lifecycle.current(userId)?.id).toBe(before);
    await act(agent, 'r01', 'reset');
    expect(kit.app.locals.range!.lifecycle.current(userId)?.id).not.toBe(before);
    const stopped = await act(agent, 'r01', 'stop');
    expect(stateOf(stopped.text)).toBe('none');
    expect(kit.warden.boxes.size).toBe(0);
  });

  it('a full range queues: position shown, polls every 2 s, Leave the queue', async () => {
    const kit = portalApp({ range: { limits: { capacity: 1, idleMs: 30 * 60_000, maxMs: 120 * 60_000, extendMs: 30 * 60_000, ceilingMs: 240 * 60_000, startTimeoutMs: 90_000 } } });
    const alice = await player(kit.app, 'alice');
    const bob = await player(kit.app, 'bob');
    await act(alice.agent, 'r01', 'launch');
    const queued = await act(bob.agent, 'r01', 'launch');
    expect(stateOf(queued.text)).toBe('queued');
    expect(queued.text).toContain('data-testid="queue-position"');
    expect(queued.text).toMatch(/Position 1 in the queue/);
    expect(queued.text).toContain('hx-trigger="every 2s"');
    expect(queued.text).toContain('data-testid="lab-stop"');
  });

  it('a failed launch shows its reason and Launch again; another lab running is named before replacing it', async () => {
    const warden = fakeWarden({ autoReady: true });
    const kit = portalApp({ warden });
    const { agent } = await player(kit.app, 'alice');
    warden.failNextLaunch('docker');
    const failed = await act(agent, 'r01', 'launch');
    expect(stateOf(failed.text)).toBe('failed');
    expect(failed.text).toContain('data-reason="docker"');
    expect(failed.text).toContain('data-testid="lab-launch"');
    await act(agent, 'r01', 'launch');
    const other = panelOf((await agent.get('/labs/r02')).text);
    expect(stateOf(other)).toBe('none');
    expect(other).toContain('data-testid="lab-replaces"');
    expect(other).toContain('App clinic');
  });
});

describe('My Lab in the header', () => {
  it('says "none" without an instance; names the app and the time left while running; /my-lab goes to it', async () => {
    const kit = portalApp();
    const { agent } = await player(kit.app, 'alice');
    expect((await agent.get('/leaderboard')).text).toMatch(/data-testid="my-lab" data-state="none"/);
    expect((await agent.get('/my-lab')).headers.location).toBe('/');
    await act(agent, 'r01', 'launch', 'templar');
    await agent.get('/labs/r01/panel?level=templar');
    const html = (await agent.get('/leaderboard')).text;
    expect(html).toMatch(/data-testid="my-lab" data-state="running"/);
    expect(html).toContain('App clinic · 120 min left');
    expect((await agent.get('/my-lab')).headers.location).toBe('/labs/r01?level=templar');
    const chip = await agent.get('/my-lab/chip').set('HX-Request', 'true');
    expect(chip.text.trim()).toMatch(/^<a class="my-lab"/);
    expect(chip.text).not.toContain('<!doctype html>');
  });
});

describe('/admin/range', () => {
  it('lists active instances with capacity and queue; Stop ends one (reason admin); players get 404', async () => {
    const kit = portalApp();
    const alice = await player(kit.app, 'alice');
    await act(alice.agent, 'r01', 'launch');
    const admin = await signInAdmin(kit.app);
    const page = await admin.get('/admin/range');
    expect(page.status).toBe(200);
    expect(page.text).toContain('data-testid="range-capacity" data-live="1" data-capacity="140" data-queued="0"');
    const id = kit.app.locals.range!.lifecycle.current(alice.userId)!.id;
    expect(page.text).toContain(`data-instance="${id}"`);
    const res = await admin.post(`/admin/range/${id}/stop`).type('form').send({ _csrf: csrfOf(page.text) });
    expect(res.status).toBe(303);
    expect(kit.app.locals.range!.lifecycle.store.get(id)).toMatchObject({ state: 'stopped', reason: 'admin' });
    expect((await alice.agent.get('/admin/range')).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-panel.spec.ts`
Expected: FAIL — no panel, no launch/open/extend/reset/stop routes, no My Lab chip, no `/admin/range`.

- [ ] **Step 3: Implement**

Create `src/range/panel.ts`:

```ts
// src/range/panel.ts — view models of the Lab panel (one lab and level, on its page) and of the My Lab chip (every page).
// Polling (spec §5.3): every 1 s while starting, 2 s while queued, 30 s while running (the time left); never otherwise.
import type { Request, Response } from 'express';
import type { Level } from '../core/levels.js';
import type { LabEntry, LabRegistry } from '../lab-registry.js';
import type { InstanceRecord, InstanceState } from './store.js';
import type { RangeContext } from './types.js';

/** Failure reasons the panel can name (range.reason.<code>); anything else shows as 'unknown'. */
export const PANEL_REASONS = Object.freeze(['start_timeout', 'unhealthy', 'no_healthcheck', 'missing', 'crashed', 'exited', 'oom',
  'bad_request', 'unknown_lab', 'bad_level', 'exists', 'docker', 'unauthorized', 'unavailable'] as const);
/** A failure older than this no longer shows on the panel. */
export const FAILURE_SHOWN_MS = 15 * 60_000;

export interface PanelModel {
  readonly labId: string;
  readonly level: Level;
  readonly levelLabel: string;
  readonly state: 'none' | InstanceState;
  readonly queuePosition: number;
  readonly minutesLeft: number;
  readonly canExtend: boolean;
  readonly extendMinutes: number;
  /** A PANEL_REASONS code or 'unknown' when failed; '' otherwise. */
  readonly reason: string;
  /** The user's instance elsewhere, which Launch would stop. */
  readonly replaces?: { readonly app: string; readonly levelLabel: string };
  /** 0: no polling. */
  readonly pollSeconds: number;
  readonly csrf: string;
}

const minutesUntil = (at: number | null, now: number) => (at === null ? 0 : Math.max(0, Math.ceil((at - now) / 60_000)));

/** The panel for `lab` at `level`, as the signed-in user sees it now. */
export function panelFor(ctx: RangeContext, req: Request, res: Response, lab: LabEntry, level: Level): PanelModel {
  const t: (key: string) => string = res.locals.t;
  const userId = res.locals.platformAuth?.userId ?? 0;
  const { lifecycle, opts } = ctx;
  const now = ctx.now();
  const current = lifecycle.current(userId);
  const label = (l: Level) => t(l === 'divine' ? 'challenge.divine_tab' : `level.${l}`);
  const base = {
    labId: lab.id, level, levelLabel: label(level), queuePosition: 0, minutesLeft: 0, canExtend: false,
    extendMinutes: Math.round(opts.limits.extendMs / 60_000), reason: '', pollSeconds: 0, csrf: ctx.auth.csrfFor(req),
  };
  if (current && current.labId === lab.id && current.level === level) {
    const ceiling = current.startedAt === null ? 0 : current.startedAt + opts.limits.ceilingMs;
    return {
      ...base, state: current.state,
      queuePosition: current.state === 'queued' ? lifecycle.queuePosition(current.id) : 0,
      minutesLeft: current.state === 'running' ? minutesUntil(current.expiresAt, now) : 0,
      canExtend: current.state === 'running' && current.expiresAt !== null && current.expiresAt < ceiling,
      pollSeconds: current.state === 'starting' ? 1 : current.state === 'queued' ? 2 : 30,
    };
  }
  if (current) {
    return { ...base, state: 'none', replaces: { app: ctx.registry.get(current.labId)?.app ?? current.labId, levelLabel: label(current.level) } };
  }
  const latest = lifecycle.store.latestFor(userId, lab.id, level);
  if (latest?.state === 'failed' && latest.endedAt !== null && now - latest.endedAt < FAILURE_SHOWN_MS) {
    const reason = (PANEL_REASONS as readonly string[]).includes(latest.reason ?? '') ? (latest.reason as string) : 'unknown';
    return { ...base, state: 'failed', reason };
  }
  return { ...base, state: 'none' };
}

export interface MyLabChip { readonly href: string; readonly state: string; readonly text: string }

/** The header's My Lab chip (res.locals.myLab). */
export function myLabChip(current: InstanceRecord | undefined, registry: LabRegistry, now: number, t: (key: string) => string): MyLabChip {
  if (!current) return { href: '/', state: 'none', text: t('range.my_lab_none') };
  const app = registry.get(current.labId)?.app ?? current.labId;
  const href = `/labs/${current.labId}?level=${current.level}`;
  if (current.state === 'running') {
    return { href, state: 'running', text: `${app} · ${t('range.time_left').replace('{n}', String(minutesUntil(current.expiresAt, now)))}` };
  }
  return { href, state: current.state, text: `${app} · ${t(`range.state.${current.state}`)}` };
}
```

Replace `src/range/lab-routes.ts` with:

```ts
// src/range/lab-routes.ts — the range's lab actions (portal mode): flag submission, the Lab panel (fragment), launch,
// open (a gate ticket), extend, reset, stop, and My Lab. Every POST is an account form (formOk: Origin, Sec-Fetch-Site,
// the token bound to hvwa_sid and hvwa_auth); htmx gets a fragment, a plain form a 303.
import type { Request, Response, Router } from 'express';
import { field } from '../core/lab.js';
import { clampLevel, isLevel, type Level } from '../core/levels.js';
import { MY_LAB_VIEW, sendFragment } from '../core/render.js';
import type { LabEntry } from '../lab-registry.js';
import { isHtmx, rangeView, userOf } from './catalog.js';
import { instanceOrigin } from './hosts.js';
import { panelFor } from './panel.js';
import { submitRangeFlag, submitResultHtml } from './submit.js';
import type { RangeContext } from './types.js';

export function labRoutes(router: Router, ctx: RangeContext): void {
  const { db, registry, auth, lifecycle, opts } = ctx;
  const levelOf = (raw: unknown, lab: LabEntry): Level | undefined => (isLevel(raw) && lab.levels.includes(raw) ? raw : undefined);
  const sendPanel = async (req: Request, res: Response, lab: LabEntry, level: Level) => {
    res.set('Cache-Control', 'no-store');
    await sendFragment(res, rangeView('panel'), { panel: panelFor(ctx, req, res, lab, level) });
  };

  router.post('/labs/:id/submit', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const result = submitRangeFlag(db, lifecycle.store, lab, userOf(res).userId, field(req, 'submission'), ctx.now());
    if (isHtmx(req)) { res.type('html').send(submitResultHtml(result, res.locals.t)); return; }
    res.redirect(303, `/labs/${lab.id}?r=${result.status === 'wrong' ? 'wrong' : 'solved'}`);
  });

  // The panel (htmx polling): a starting instance is asked about once per poll.
  router.get('/labs/:id/panel', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    const level = levelOf(req.query.level, lab) ?? clampLevel(req.level, lab.levels);
    const current = lifecycle.current(userOf(res).userId);
    if (current?.state === 'starting') await lifecycle.refresh(current.id);
    await sendPanel(req, res, lab, level);
  });

  for (const action of ['launch', 'extend', 'reset', 'stop'] as const) {
    router.post(`/labs/:id/${action}`, async (req, res, next) => {
      const lab = registry.get(req.params.id);
      if (!lab) { next(); return; }
      if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
      const level = levelOf(field(req, 'level'), lab);
      if (!level) { res.status(400).type('text/plain').send('Unknown level\n'); return; }
      const { userId } = userOf(res);
      const current = lifecycle.current(userId);
      if (action === 'launch') await lifecycle.launch(userId, lab.id, level);
      else if (current && current.labId === lab.id) { // only the instance this panel shows
        if (action === 'extend') lifecycle.extend(userId);
        else if (action === 'reset') await lifecycle.reset(userId);
        else await lifecycle.stop(userId, 'user');
      }
      if (isHtmx(req)) { await sendPanel(req, res, lab, level); return; }
      res.redirect(303, `/labs/${lab.id}?level=${level}`);
    });
  }

  // Open lab (spec §5.4): a single-use 60 s ticket for THIS user and instance, handed to the instance host's gate.
  router.post('/labs/:id/open', async (req, res, next) => {
    const lab = registry.get(req.params.id);
    if (!lab) { next(); return; }
    if (!auth.formOk(req)) { await auth.refuse(req, res, `/labs/${lab.id}`); return; }
    const { userId } = userOf(res);
    const current = lifecycle.current(userId);
    if (!current || current.labId !== lab.id || current.state !== 'running') { res.redirect(303, `/labs/${lab.id}`); return; }
    const ticket = ctx.tickets.mint(userId, current.id);
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.redirect(303, `${instanceOrigin(current.id, opts.domain, opts.publicScheme ?? 'https', opts.publicPort)}/__hvwa/gate?t=${ticket}`);
  });

  router.get('/my-lab', (_req, res) => {
    const current = lifecycle.current(userOf(res).userId);
    res.redirect(303, current ? `/labs/${current.labId}?level=${current.level}` : '/');
  });
  router.get('/my-lab/chip', async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    await sendFragment(res, MY_LAB_VIEW);
  });
}
```

Create `src/range/admin.ts`:

```ts
// src/range/admin.ts — the admin's view of the range (spec range §10): active instances, capacity and queue, Stop.
import { Router } from 'express';
import { requireAdmin } from '../auth/index.js';
import { sendPage } from '../core/render.js';
import { rangeView } from './catalog.js';
import { INSTANCE_ID_RE } from './ids.js';
import type { RangeContext } from './types.js';

export function adminRangeRoutes(router: Router, ctx: RangeContext): void {
  const { lifecycle, auth, registry, opts } = ctx;
  const admin = Router();
  admin.use(requireAdmin);
  admin.get('/admin/range', async (req, res) => {
    const store = lifecycle.store;
    const now = ctx.now();
    const names = new Map(auth.service.listUsers().map((u) => [u.id, u.username]));
    const rows = store.listActive().map((r) => ({
      id: r.id, user: names.get(r.userId) ?? String(r.userId), app: registry.get(r.labId)?.app ?? r.labId, level: r.level, state: r.state,
      minutesLeft: r.expiresAt === null ? null : Math.max(0, Math.ceil((r.expiresAt - now) / 60_000)),
      queue: r.state === 'queued' ? store.queuePosition(r.id) : 0,
    }));
    res.set('Cache-Control', 'no-store');
    await sendPage(res, rangeView('admin-range'), {
      pageTitle: res.locals.t('admin.range'), rows, live: store.countLive(), capacity: opts.limits.capacity,
      queued: store.queued().length, csrf: auth.csrfFor(req),
      crumbs: [{ label: res.locals.t('nav.labs'), href: '/' }, { label: res.locals.t('admin.title') }, { label: res.locals.t('admin.range') }],
    });
  });
  admin.post('/admin/range/:instanceId/stop', async (req, res) => {
    if (!auth.formOk(req)) { await auth.refuse(req, res, '/admin/range'); return; }
    if (INSTANCE_ID_RE.test(req.params.instanceId)) await lifecycle.stopInstance(req.params.instanceId, 'admin');
    res.redirect(303, '/admin/range');
  });
  router.use(admin);
}
```

Create `src/range/views/panel.ejs`:

```ejs
<%# The Lab panel (src/range/panel.ts): state, time left, Launch / Open lab / Extend / Reset / Stop, the queue position. htmx polls it while it starts (1 s), queues (2 s) or runs (30 s); every action swaps it. Open lab is a plain form into a new tab (the gate ticket is minted on click). Hooks: lab-panel (data-state), lab-state, time-left, queue-position, lab-failed (data-reason), lab-replaces, lab-launch, lab-open, lab-extend, lab-reset, lab-stop. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<section id="lab-panel" class="card panel lab-panel" data-testid="lab-panel" data-state="<%= panel.state %>" data-level="<%= panel.level %>" aria-labelledby="lab-panel-title"<% if (panel.pollSeconds > 0) { %> hx-get="/labs/<%= panel.labId %>/panel?level=<%= panel.level %>" hx-trigger="every <%= panel.pollSeconds %>s" hx-swap="outerHTML"<% } %>>
  <h2 id="lab-panel-title"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg><%= t('range.panel_title') %></h2>
  <p class="panel-state" aria-live="polite"><span class="badge" data-testid="lab-state"><%= t('range.state.' + panel.state) %></span> <span class="badge level-badge" data-level="<%= panel.level %>"><%= panel.levelLabel %></span></p>
<% if (panel.state === 'queued') { -%>
  <p data-testid="queue-position"><%= t('range.queue_position').replace('{n}', panel.queuePosition) %></p>
<% } else if (panel.state === 'starting') { -%>
  <p class="help"><%= t('range.starting_help') %></p>
<% } else if (panel.state === 'running') { -%>
  <p data-testid="time-left"><%= t('range.time_left').replace('{n}', panel.minutesLeft) %></p>
<% } else if (panel.state === 'failed') { -%>
  <p class="result result-bad" role="alert" data-testid="lab-failed" data-reason="<%= panel.reason %>"><%= t('range.reason.' + panel.reason) %></p>
<% } -%>
<% if (panel.replaces) { -%>
  <p class="help" data-testid="lab-replaces"><%= t('range.launch_replaces').replace('{app}', panel.replaces.app).replace('{level}', panel.replaces.levelLabel) %></p>
<% } -%>
  <div class="panel-actions">
<% if (panel.state === 'none' || panel.state === 'failed') { -%>
    <form method="post" action="/labs/<%= panel.labId %>/launch" hx-post="/labs/<%= panel.labId %>/launch" hx-target="#lab-panel" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="<%= panel.csrf %>"><input type="hidden" name="level" value="<%= panel.level %>">
      <button type="submit" class="btn btn-primary btn-block" data-testid="lab-launch"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg><%= t('range.launch_at').replace('{level}', panel.levelLabel) %></button>
    </form>
<% } -%>
<% if (panel.state === 'running') { -%>
    <form method="post" action="/labs/<%= panel.labId %>/open" target="_blank" rel="noopener">
      <input type="hidden" name="_csrf" value="<%= panel.csrf %>">
      <button type="submit" class="btn btn-primary btn-block" data-testid="lab-open"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-arrow-right"></use></svg><%= t('range.open') %></button>
    </form>
<% if (panel.canExtend) { -%>
    <form method="post" action="/labs/<%= panel.labId %>/extend" hx-post="/labs/<%= panel.labId %>/extend" hx-target="#lab-panel" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="<%= panel.csrf %>"><input type="hidden" name="level" value="<%= panel.level %>">
      <button type="submit" class="btn btn-secondary btn-sm" data-testid="lab-extend"><%= t('range.extend').replace('{n}', panel.extendMinutes) %></button>
    </form>
<% } -%>
    <form method="post" action="/labs/<%= panel.labId %>/reset" hx-post="/labs/<%= panel.labId %>/reset" hx-target="#lab-panel" hx-swap="outerHTML" hx-confirm="<%= t('range.reset_confirm') %>">
      <input type="hidden" name="_csrf" value="<%= panel.csrf %>"><input type="hidden" name="level" value="<%= panel.level %>">
      <button type="submit" class="btn btn-secondary btn-sm" data-testid="lab-reset"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-rotate"></use></svg><%= t('range.reset') %></button>
    </form>
<% } -%>
<% if (panel.state === 'running' || panel.state === 'starting' || panel.state === 'queued') { -%>
    <form method="post" action="/labs/<%= panel.labId %>/stop" hx-post="/labs/<%= panel.labId %>/stop" hx-target="#lab-panel" hx-swap="outerHTML">
      <input type="hidden" name="_csrf" value="<%= panel.csrf %>"><input type="hidden" name="level" value="<%= panel.level %>">
      <button type="submit" class="btn btn-danger btn-sm" data-testid="lab-stop"><%= panel.state === 'queued' ? t('range.leave_queue') : t('range.stop') %></button>
    </form>
<% } -%>
  </div>
</section>
```

Create `src/range/views/admin-range.ejs`:

```ejs
<%# Admin: the range's active instances (src/range/admin.ts): capacity, queue, one row per instance with Stop. Hooks: range-capacity (data-live, data-capacity, data-queued), data-instance. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. %>
<header class="page-head">
  <h1 class="page-title"><%= t('admin.title') %></h1>
</header>
<%- include('../../auth/views/admin-nav', { current: 'range' }) %>
<p class="panel-lead" data-testid="range-capacity" data-live="<%= live %>" data-capacity="<%= capacity %>" data-queued="<%= queued %>"><%= t('admin.capacity').replace('{live}', live).replace('{capacity}', capacity).replace('{queued}', queued) %></p>
<% if (rows.length === 0) { -%>
<div class="empty">
  <svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg>
  <p><%= t('admin.no_instances') %></p>
</div>
<% } else { -%>
<div class="table-wrap">
  <table class="table" data-testid="instances">
    <thead><tr><th scope="col"><%= t('admin.col_instance') %></th><th scope="col"><%= t('admin.col_user') %></th><th scope="col"><%= t('admin.col_lab') %></th><th scope="col"><%= t('admin.col_level') %></th><th scope="col"><%= t('admin.col_state') %></th><th scope="col" class="num"><%= t('admin.col_left') %></th><th scope="col"><%= t('admin.col_actions') %></th></tr></thead>
    <tbody>
<% rows.forEach(function (r) { -%>
      <tr data-instance="<%= r.id %>" data-state="<%= r.state %>">
        <th scope="row"><code><%= r.id.slice(0, 8) %></code></th>
        <td><%= r.user %></td>
        <td><%= r.app %></td>
        <td><span class="badge level-badge" data-level="<%= r.level %>"><%= t('level.' + r.level) %></span></td>
        <td><%= t('range.state.' + r.state) %><% if (r.queue > 0) { %> (#<%= r.queue %>)<% } %></td>
        <td class="num"><%= r.minutesLeft === null ? '' : r.minutesLeft %></td>
        <td><form method="post" action="/admin/range/<%= r.id %>/stop"><input type="hidden" name="_csrf" value="<%= csrf %>"><button type="submit" class="btn btn-danger btn-xs"><%= t('range.stop') %></button></form></td>
      </tr>
<% }); -%>
    </tbody>
  </table>
</div>
<% } -%>
```

Create `src/core/views/my-lab.ejs`:

```ejs
<%# My Lab (portal mode): the header chip of the signed-in user's active instance (src/range/panel.ts myLabChip). It refreshes itself every 30 s with htmx and links the lab's page. Every value goes through the escaped output tag. Never put an EJS tag inside an EJS comment: it breaks parsing. -%>
<a class="my-lab" href="<%= myLab.href %>" data-testid="my-lab" data-state="<%= myLab.state %>" hx-get="/my-lab/chip" hx-trigger="every 30s" hx-swap="outerHTML"><svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-flask"></use></svg><span class="my-lab-label"><%= t('range.my_lab') %></span><span class="my-lab-meta"><%= myLab.text %></span></a>
```

In `src/core/render.ts`, after `const layoutFile = ...;` add:

```ts
/** The My Lab chip (portal mode): included by the layout, and served alone as the htmx fragment /my-lab/chip. */
export const MY_LAB_VIEW = join(here, 'views', 'my-lab.ejs');
```

In `src/core/views/layout.ejs`, inside `<div class="topbar-tools">`, before the account menu (`<% if (platformAuth && platformAuth.signedIn) { -%>`), add:

```ejs
<% if (typeof myLab !== 'undefined' && myLab) { -%>
<%- include('my-lab') %>
<% } -%>
```

In `src/auth/views/admin-nav.ejs`, add the third link after the settings link:

```ejs
  <a class="seg-item" href="/admin/range"<% if (current === 'range') { %> aria-current="page"<% } %>><%= t('admin.range') %></a>
```

In `src/range/catalog.ts`, `GET /labs/:id` passes the panel (import `panelFor` from `./panel.js`), added to the `sendPage` data object:

```ts
      panel: panelFor(ctx, req, res, lab, currentLevel),
```

In `src/range/views/lab.ejs`, as the first child of `<aside class="player-side">` add:

```ejs
<%- include('panel', { panel: panel }) %>
```

In `src/range/index.ts`:

1. Add `import { adminRangeRoutes } from './admin.js';` and `import { myLabChip } from './panel.js';`.
2. `locals` also sets the chip:

```ts
  const locals: RequestHandler = (_req, res, next) => {
    res.locals.portalNav = { admin: res.locals.platformAuth?.role === 'admin' };
    const userId = res.locals.platformAuth?.userId;
    if (userId !== undefined) res.locals.myLab = myLabChip(lifecycle.current(userId), opts.registry, now(), res.locals.t);
    next();
  };
```

3. After `labRoutes(router, ctx);` add `adminRangeRoutes(router, ctx);`.

In `src/core/i18n.ts`, add after `'range.submit_help'`:

```ts
  // The Lab panel, My Lab and the admin's instance page.
  'range.panel_title': { id: 'Lab Anda', en: 'Your lab' },
  'range.state.none': { id: 'Tidak berjalan', en: 'Not running' },
  'range.state.queued': { id: 'Dalam antrean', en: 'Queued' },
  'range.state.starting': { id: 'Memulai…', en: 'Starting…' },
  'range.state.running': { id: 'Berjalan', en: 'Running' },
  'range.state.stopping': { id: 'Menghentikan…', en: 'Stopping…' },
  'range.state.stopped': { id: 'Berhenti', en: 'Stopped' },
  'range.state.failed': { id: 'Gagal', en: 'Failed' },
  'range.launch_at': { id: 'Jalankan di {level}', en: 'Launch at {level}' },
  'range.launch_replaces': {
    id: 'Menjalankan lab ini menghentikan lab Anda yang sedang berjalan ({app}, {level}).',
    en: 'Launching this stops your running lab ({app}, {level}).',
  },
  'range.starting_help': { id: 'Lab Anda sedang disiapkan. Biasanya beberapa detik.', en: 'Your lab is being prepared. This usually takes a few seconds.' },
  'range.queue_position': {
    id: 'Posisi {n} dalam antrean. Range sedang penuh; lab Anda mulai saat ada slot kosong.',
    en: 'Position {n} in the queue. The range is full; your lab starts when a slot frees up.',
  },
  'range.time_left': { id: 'sisa {n} menit', en: '{n} min left' },
  'range.open': { id: 'Buka lab', en: 'Open lab' },
  'range.extend': { id: 'Perpanjang +{n} menit', en: 'Extend +{n} min' },
  'range.reset': { id: 'Atur ulang', en: 'Reset' },
  'range.reset_confirm': {
    id: 'Atur ulang membuat instans baru dengan flag baru. Semua yang Anda ubah di lab ini hilang. Lanjutkan?',
    en: 'Reset creates a new instance with a new flag. Everything you changed in this lab is lost. Continue?',
  },
  'range.stop': { id: 'Hentikan', en: 'Stop' },
  'range.leave_queue': { id: 'Keluar dari antrean', en: 'Leave the queue' },
  'range.reason.start_timeout': { id: 'Lab tidak siap tepat waktu.', en: 'The lab did not become ready in time.' },
  'range.reason.unhealthy': { id: 'Pemeriksaan kesehatan lab gagal.', en: 'The lab failed its health check.' },
  'range.reason.no_healthcheck': { id: 'Image lab ini tidak punya pemeriksaan kesehatan.', en: 'This lab image has no health check.' },
  'range.reason.missing': { id: 'Kontainer lab hilang.', en: 'The lab container is gone.' },
  'range.reason.crashed': { id: 'Lab berhenti tiba-tiba.', en: 'The lab stopped unexpectedly.' },
  'range.reason.exited': { id: 'Proses lab keluar.', en: 'The lab process exited.' },
  'range.reason.oom': { id: 'Lab kehabisan memori.', en: 'The lab ran out of memory.' },
  'range.reason.bad_request': { id: 'Permintaan peluncuran ditolak.', en: 'The launch request was refused.' },
  'range.reason.unknown_lab': { id: 'Lab ini tidak dikenal oleh warden.', en: 'The warden does not know this lab.' },
  'range.reason.bad_level': { id: 'Level ini tidak tersedia untuk lab ini.', en: 'This level is not available for this lab.' },
  'range.reason.exists': { id: 'Instans ini sudah ada.', en: 'This instance already exists.' },
  'range.reason.docker': { id: 'Mesin kontainer gagal membuat lab.', en: 'The container engine could not create the lab.' },
  'range.reason.unauthorized': { id: 'Portal tidak diizinkan oleh warden.', en: 'The warden refused the portal.' },
  'range.reason.unavailable': { id: 'Warden tidak dapat dihubungi.', en: 'The warden cannot be reached.' },
  'range.reason.unknown': { id: 'Lab gagal.', en: 'The lab failed.' },
  'range.my_lab': { id: 'Lab Saya', en: 'My Lab' },
  'range.my_lab_none': { id: 'tidak ada', en: 'none' },
  'admin.range': { id: 'Range', en: 'Range' },
  'admin.capacity': {
    id: '{live} dari {capacity} instans berjalan, {queued} dalam antrean.',
    en: '{live} of {capacity} instances running, {queued} queued.',
  },
  'admin.no_instances': { id: 'Tidak ada instans aktif.', en: 'No active instances.' },
  'admin.col_instance': { id: 'Instans', en: 'Instance' },
  'admin.col_lab': { id: 'Lab', en: 'Lab' },
  'admin.col_level': { id: 'Level', en: 'Level' },
  'admin.col_state': { id: 'Status', en: 'State' },
  'admin.col_left': { id: 'Sisa (menit)', en: 'Left (min)' },
```

In `src/public/app.css`, append to the Range block:

```css
.lab-panel .panel-state { display: flex; flex-wrap: wrap; gap: var(--sp-2); align-items: center; margin: 0 0 var(--sp-3); }
.lab-panel .panel-actions { display: grid; gap: var(--sp-2); }
.lab-panel .panel-actions form { margin: 0; }
.lab-panel[data-state="starting"] .panel-state .badge, .lab-panel[data-state="queued"] .panel-state .badge { color: var(--info); background: var(--info-bg); border-color: var(--info-border); }
.lab-panel[data-state="running"] .panel-state .badge:first-child { color: var(--success); background: var(--success-bg); border-color: var(--success-border); }
.lab-panel[data-state="failed"] .panel-state .badge:first-child { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-border); }
.my-lab { display: inline-flex; align-items: center; gap: var(--sp-2); min-height: var(--tap); padding: 0 var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius); color: var(--text); text-decoration: none; font-size: var(--fs-sm); }
.my-lab:hover { border-color: var(--border-strong); }
.my-lab-label { font-weight: 650; }
.my-lab-meta { color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16rem; }
.my-lab[data-state="running"] .icon { color: var(--success); }
@media (max-width: 640px) { .my-lab-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); } .my-lab-meta { max-width: 9rem; } }
```

In `docs/UI.md`, add these two rows to the components table in section 4:

```md
| Lab panel (portal mode) | `<section id="lab-panel" class="card panel lab-panel" data-state>` (src/range/views/panel.ejs) | State badge, level badge, one primary action (Launch or Open lab), secondary Extend / Reset, danger Stop. htmx re-fetches the whole section (`hx-swap="outerHTML"`): every 1 s starting, 2 s queued, 30 s running. Open lab is a plain form with `target="_blank"`. |
| My Lab chip (portal mode) | `<a class="my-lab" data-state>` (core/views/my-lab.ejs) | In the top bar on every signed-in page; the app and the minutes left in text; refreshes itself every 30 s. |
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-panel.spec.ts tests/range-submit.spec.ts tests/portal-mode.spec.ts tests/ui-contrast.spec.ts tests/ui-shell.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/panel.ts src/range/admin.ts src/range/views/panel.ejs src/range/views/admin-range.ejs src/core/views/my-lab.ejs src/range/lab-routes.ts src/range/catalog.ts src/range/views/lab.ejs src/range/index.ts src/core/render.ts src/core/views/layout.ejs src/auth/views/admin-nav.ejs src/core/i18n.ts src/public/app.css docs/UI.md tests/range-panel.spec.ts
git commit -m "feat(range): Lab panel with htmx polling, Open lab via gate ticket, My Lab chip, admin instance page"
```

---

### Task 24: `server.ts` in portal mode: options from the environment, secrets scrubbed, reconcile and reaper

**Files:**
- Create: `src/range/options.ts`
- Modify: `src/server.ts`
- Test: `tests/range-server.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-server.spec.ts`:

```ts
// Portal mode from the environment (src/range/options.ts, src/server.ts): createApp's options, the range key persisted,
// and a real `src/server.ts` process with HVWA_MODE=portal against a real warden (stub Engine): it reconciles at start,
// serves the portal behind the login, and removes every secret from its environment.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { loadRangeConfig } from '../src/range/config.js';
import { portalAppOptions } from '../src/range/options.js';
import { createDockerClient } from '../src/warden/docker.js';
import { createWarden } from '../src/warden/warden.js';
import { createWardenServer } from '../src/warden/server.js';
import { parseRegistry } from '../src/lab-registry.js';
import { startDockerStub, type DockerStub } from './support/docker-stub.js';
import { labEntry } from './support/range.js';
import { serve, TEST_SECRET } from './helpers.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 'w'.repeat(40);
const F = 'f'.repeat(40);
const ADMIN = 'Admin-Pass-1234';
const dirs: string[] = [];
const stubs: DockerStub[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'hvwa-portal-')); dirs.push(d); return d; };
function registryFile(dir: string): string {
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify({ schema: 1, labs: [labEntry('r01', 'clinic')] }));
  return file;
}
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

describe('portalAppOptions', () => {
  it('portal mode behind the tunnel: https, Secure host-only cookies, 10-character passwords, the range from the environment', () => {
    const dir = temp();
    const r = loadRangeConfig({
      HVWA_RANGE_DOMAIN: 'hvwa.my.id', HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F,
      HVWA_LAB_REGISTRY: registryFile(dir), HVWA_RANGE_CAPACITY: '3',
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const opts = portalAppOptions(parseConfig({ HVWA_ADMIN_PASSWORD: ADMIN, HVWA_MODE: 'portal', FLAG_SECRET: TEST_SECRET }), r.config, dir);
    expect(opts).toMatchObject({
      mode: 'portal', dbPath: join(dir, 'hvwa.db'),
      auth: { initialPassword: ADMIN, secureCookies: true, publicScheme: 'https', passwordMinLength: 10 },
      range: {
        domain: 'hvwa.my.id', portalHost: 'hvwa.my.id', internalHost: 'portal', forwardAuthSecret: F, publicScheme: 'https', secureCookies: true,
        limits: { capacity: 3, idleMs: 30 * 60_000, maxMs: 120 * 60_000, extendMs: 30 * 60_000, ceilingMs: 240 * 60_000, startTimeoutMs: 90_000 },
      },
    });
    expect(opts.range?.registry.get('r01')?.app).toBe('App clinic');
    expect(readFileSync(join(dir, 'range-key'), 'utf8').trim()).toBe(opts.range?.rangeKey);
  });

  it('a local run (HVWA_RANGE_PUBLIC_SCHEME=http): no Secure attribute anywhere, the Origin check expects http', () => {
    const dir = temp();
    const r = loadRangeConfig({
      HVWA_RANGE_DOMAIN: 'localhost', HVWA_PORTAL_HOST: 'hvwa.localhost', HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: '18080',
      HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F, HVWA_LAB_REGISTRY: registryFile(dir),
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    const opts = portalAppOptions(parseConfig({ HVWA_ADMIN_PASSWORD: ADMIN, HVWA_MODE: 'portal', FLAG_SECRET: TEST_SECRET }), r.config, dir);
    expect(opts).toMatchObject({
      auth: { secureCookies: false, publicScheme: 'http' },
      range: { portalHost: 'hvwa.localhost', publicScheme: 'http', publicPort: 18080, secureCookies: false },
    });
  });
});

describe('src/server.ts with HVWA_MODE=portal (a real process)', () => {
  const PROBE = 'data:text/javascript,' + encodeURIComponent([
    "const names = ['HVWA_ADMIN_PASSWORD', 'HVWA_WARDEN_SECRET', 'HVWA_FORWARD_AUTH_SECRET'];",
    "console.log('PROBE preload: ' + names.filter((n) => n in process.env).length + ' present');",
    "const t = setInterval(() => { if (names.every((n) => !(n in process.env))) { console.log('PROBE: gone'); clearInterval(t); } }, 20);",
    't.unref();',
  ].join('\n'));

  function start(env: Record<string, string>) {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', PROBE, join(root, 'src', 'server.ts')], {
      cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
    return { child, exited, output: () => out };
  }

  it('reconciles with the warden, serves the portal behind the login, and scrubs the secrets', async () => {
    const stub = await startDockerStub();
    stubs.push(stub);
    stub.addContainer('hvwa-range-traefik');
    const registry = parseRegistry({ schema: 1, labs: [labEntry('r01', 'clinic')] });
    const warden = createWarden({ docker: createDockerClient(stub.url), registry, settings: { domain: 'range.test', runtime: 'runc', traefikContainer: 'hvwa-range-traefik' } });
    const wardenPort = (serve(createWardenServer({ warden, secret: W })).address() as AddressInfo).port;
    const dir = temp();
    const port = await freePort();
    const p = start({
      HVWA_MODE: 'portal', HOST: '127.0.0.1', PORT: String(port), HVWA_DATA_DIR: dir, FLAG_SECRET: TEST_SECRET,
      HVWA_RANGE_DOMAIN: 'range.test', HVWA_ADMIN_PASSWORD: ADMIN, HVWA_WARDEN_URL: `http://127.0.0.1:${wardenPort}`,
      HVWA_WARDEN_SECRET: W, HVWA_FORWARD_AUTH_SECRET: F, HVWA_LAB_REGISTRY: registryFile(dir),
    });
    try {
      const deadline = Date.now() + 45_000;
      while (!/HVWA: mode portal/.test(p.output()) || !p.output().includes('PROBE: gone')) {
        if (Date.now() > deadline || p.child.exitCode !== null) throw new Error(`portal did not start:\n${p.output()}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(p.output()).toContain('PROBE preload: 3 present');
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/`, { redirect: 'manual' })).status).toBe(303);
      const page = await fetch(`${base}/login`);
      const sid = /hvwa_sid=([^;]+)/.exec(page.headers.get('set-cookie') ?? '')?.[1] ?? '';
      const csrf = /name="_csrf" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual', headers: { cookie: `hvwa_sid=${sid}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ _csrf: csrf, username: 'admin', password: ADMIN }).toString(),
      });
      expect(login.status).toBe(303);
      const auth = /hvwa_auth=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1] ?? '';
      expect(login.headers.get('set-cookie')).toMatch(/; Secure/);
      const home = await fetch(`${base}/`, { headers: { cookie: `hvwa_sid=${sid}; hvwa_auth=${auth}` } });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('data-lab="r01"');
      await new Promise((r) => setTimeout(r, 300));
      expect(stub.calls.some((c) => c.path.startsWith('/v1.44/containers/json'))).toBe(true); // reconcile listed the range's containers
      expect(p.output()).not.toContain(W);
      expect(p.output()).not.toContain(ADMIN);
    } finally {
      p.child.kill();
      await p.exited;
    }
  }, 120_000);

  it('refuses to start with an incomplete portal configuration: exit 1, one line per problem, no value', async () => {
    const p = start({ HVWA_MODE: 'portal', HOST: '127.0.0.1', PORT: String(await freePort()), HVWA_DATA_DIR: temp(), HVWA_WARDEN_SECRET: 'Tiny-Secret-Value' });
    expect(await p.exited).toBe(1);
    expect(p.output()).toContain('HVWA: invalid range configuration (HVWA_MODE=portal):');
    expect(p.output()).toContain('HVWA_RANGE_DOMAIN: is required in portal mode');
    expect(p.output()).toContain('HVWA_WARDEN_SECRET: must be at least 32 characters');
    expect(p.output()).not.toContain('Tiny-Secret-Value');
  }, 60_000);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-server.spec.ts`
Expected: FAIL — `src/range/options.ts` does not exist and `server.ts` ignores `HVWA_MODE`.

- [ ] **Step 3: Implement**

Create `src/range/options.ts`:

```ts
// src/range/options.ts — createApp's options in portal mode, from the validated environment (server.ts): the platform DB
// and flag secret in the data dir, the login (Secure cookies, 10-character passwords, the first admin from
// HVWA_ADMIN_PASSWORD), and the range: registry file, warden client, range key (env or persisted), limits, proxies.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppOptions } from '../app.js';
import type { Config } from '../config.js';
import { resolveFlagSecret, resolveRangeKey } from '../core/secrets.js';
import { loadRegistry, type LabRegistry } from '../lab-registry.js';
import type { WardenApi } from '../warden/protocol.js';
import { RANGE_PASSWORD_MIN_LENGTH, type RangeConfig } from './config.js';
import { DEFAULT_LIMITS } from './types.js';
import { createWardenClient } from './warden-client.js';

/** labs/registry.json of the checkout (src/ or dist/ alike); the compose stack sets HVWA_LAB_REGISTRY instead. */
export const DEFAULT_REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'labs', 'registry.json');

export function portalAppOptions(
  config: Pick<Config, 'FLAG_SECRET' | 'HVWA_ALLOWED_HOSTS' | 'HVWA_EDITION' | 'HVWA_ADMIN_PASSWORD'>,
  range: RangeConfig,
  dataDir: string,
  deps: { readonly registry?: LabRegistry; readonly warden?: WardenApi } = {},
): AppOptions {
  return {
    dbPath: join(dataDir, 'hvwa.db'),
    flagSecret: resolveFlagSecret(dataDir, config.FLAG_SECRET),
    allowedHosts: config.HVWA_ALLOWED_HOSTS,
    edition: config.HVWA_EDITION,
    mode: 'portal',
    // Cookies are Secure exactly when the browser speaks https (behind the tunnel), and always host-only.
    auth: {
      initialPassword: config.HVWA_ADMIN_PASSWORD, secureCookies: range.publicScheme === 'https', publicScheme: range.publicScheme,
      passwordMinLength: RANGE_PASSWORD_MIN_LENGTH,
    },
    range: {
      domain: range.domain,
      portalHost: range.portalHost,
      publicScheme: range.publicScheme,
      publicPort: range.publicPort,
      internalHost: range.internalHost,
      registry: deps.registry ?? loadRegistry(range.registryPath ?? DEFAULT_REGISTRY_PATH),
      warden: deps.warden ?? createWardenClient({ baseUrl: range.wardenUrl, secret: range.wardenSecret }),
      rangeKey: resolveRangeKey(dataDir, range.rangeKey),
      forwardAuthSecret: range.forwardAuthSecret,
      limits: {
        capacity: range.capacity, idleMs: range.idleMs, maxMs: range.maxMs, extendMs: range.extendMs, ceilingMs: range.ceilingMs,
        startTimeoutMs: DEFAULT_LIMITS.startTimeoutMs,
      },
      registrationCode: range.registrationCode,
      secureCookies: range.publicScheme === 'https',
    },
  };
}
```

In `src/server.ts`:

1. Add the imports:

```ts
import { loadRangeConfig, RANGE_SECRET_NAMES, type RangeConfig } from './range/config.js';
import { portalAppOptions } from './range/options.js';
import type { Reaper } from './range/reaper.js';
```

2. Replace the line `scrubEnv(process.env, ['HVWA_ADMIN_PASSWORD']);` (and its comment) with:

```ts
// Portal mode (the range): its own settings, validated the same way, before anything else starts.
let range: RangeConfig | undefined;
if (config.HVWA_MODE === 'portal') {
  const r = loadRangeConfig(process.env);
  if (!r.ok) {
    console.error('HVWA: invalid range configuration (HVWA_MODE=portal):');
    for (const line of r.errors) console.error(`  ${line}`);
    process.exit(1);
  }
  range = r.config;
}
// The config holds them now; labs are built to leak, and code-execution ones reach process.env.
scrubEnv(process.env, ['HVWA_ADMIN_PASSWORD', ...RANGE_SECRET_NAMES]);
```

3. The app creation becomes:

```ts
const app = createApp(range ? portalAppOptions(config, range, dataDir) : appOptionsFromConfig(config, dataDir));
```

4. After the default-password warning block, add:

```ts
// Portal mode: reconcile the instance records with the warden now, then reap every 30 s.
let reaper: Reaper | undefined;
if (app.locals.range && range) {
  console.log(`HVWA: mode portal (portal ${range.portalHost}, instances at i-<id>.${range.domain}, capacity ${range.capacity})`);
  reaper = app.locals.range.start();
}
```

5. In `shutdown`, before `closeGracefully(...)`, add `reaper?.stop();`.

- [ ] **Step 4: Run the tests to see them pass**

Run: `npx vitest run tests/range-server.spec.ts tests/server-startup.spec.ts tests/tooling.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add src/range/options.ts src/server.ts tests/range-server.spec.ts
git commit -m "feat(range): server.ts portal mode: options from env, secrets scrubbed, reconcile and reaper"
```

---

## Part 4 — Compose, Traefik and verification (spec §13 step 4)

### Task 25: The fixture lab (`labs/_fixture/`)

The fixture is **not** a catalog lab (the leading underscore marks it; Plan B's harness and uniqueness gate skip `labs/_*`). It exists so the platform can be verified end to end before any showcase lab: it follows the runtime contract of "Interfaces for Plans B–E" below, plants the flag as a file and as a page, and exposes two diagnostic routes (`/env`, `/headers`) that `range-verify` reads.

**Files:**
- Create: `labs/_fixture/lab.json`, `labs/_fixture/Dockerfile`, `labs/_fixture/app/server.mjs`, `labs/_fixture/app/health.mjs`
- Test: `tests/range-fixture.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-fixture.spec.ts`:

```ts
// The fixture lab (labs/_fixture: NOT a catalog lab; scripts/range-verify.mjs launches it), run here as a plain Node
// process: it plants HVWA_FLAG as a file and as a page, removes it from its environment, answers its health path; its
// manifest parses and its Dockerfile follows the range lab runtime contract.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { labManifestSchema } from '../src/lab-registry.js';

const dir = join(process.cwd(), 'labs', '_fixture');
const FLAG = 'HVWA{abcdefghijklmnopqrstuvwx}';
const kids: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) k.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); });
});

async function run(level: string, flag?: string) {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'hvwa-fixture-'));
  dirs.push(data);
  const flagFile = join(data, 'hvwa', 'flag.txt');
  const env: NodeJS.ProcessEnv = { ...process.env, HVWA_LEVEL: level, HVWA_PORT: String(port), HVWA_INSTANCE_HOST: 'i-x.localhost', HVWA_FIXTURE_FLAG_FILE: flagFile };
  delete env.HVWA_FLAG;
  if (flag !== undefined) env.HVWA_FLAG = flag;
  const child = spawn(process.execPath, [join(dir, 'app', 'server.mjs')], { env, stdio: 'ignore' });
  kids.push(child);
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error('the fixture did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, port, flagFile };
}
const health = (port: number) => spawnSync(process.execPath, [join(dir, 'app', 'health.mjs')], { env: { ...process.env, HVWA_PORT: String(port) }, timeout: 10_000 }).status;

describe('labs/_fixture/app', () => {
  it('Templar: the flag is a file and a page, gone from the environment; health passes', async () => {
    const { base, port, flagFile } = await run('templar', FLAG);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${base}/`)).text()).toContain('data-testid="level">templar<');
    expect(await (await fetch(`${base}/flag`)).text()).toContain(FLAG);
    expect(readFileSync(flagFile, 'utf8').trim()).toBe(FLAG);
    expect(await (await fetch(`${base}/env`)).json()).toMatchObject({ flagInEnv: false });
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect(health(port)).toBe(0);
    expect(health(await freePort())).toBe(1);
  });

  it('Divine: a decoy that explains it is the secure reference; no flag anywhere', async () => {
    const { base, flagFile } = await run('divine');
    const page = await (await fetch(`${base}/flag`)).text();
    expect(page).toContain('Divine is the secure reference');
    expect(page).not.toMatch(/HVWA\{/);
    expect(readFileSync(flagFile, 'utf8')).not.toMatch(/HVWA\{/);
  });

  it('/headers echoes the request headers (range-verify proves Traefik strips the forward-auth secret)', async () => {
    const { base } = await run('acolyte', FLAG);
    expect(await (await fetch(`${base}/headers`, { headers: { 'x-probe': 'yes' } })).json()).toMatchObject({ 'x-probe': 'yes' });
  });
});

describe('labs/_fixture manifest and image', () => {
  it('lab.json is a valid manifest: r00, port 8080, /healthz, the flag as a file, one small /tmp', () => {
    const m = labManifestSchema.parse(JSON.parse(readFileSync(join(dir, 'lab.json'), 'utf8')));
    expect(m).toMatchObject({ id: 'r00', slug: 'fixture', port: 8080, health: '/healthz', flag: { placement: 'file:/tmp/hvwa/flag.txt' },
      tmpfs: [{ path: '/tmp', sizeMiB: 16 }], levels: ['acolyte', 'templar', 'inquisitor', 'divine'] });
  });

  it('the Dockerfile: pinned base, setuid/setgid stripped, no package managers, uid 10001, a HEALTHCHECK, node only', () => {
    const lines = readFileSync(join(dir, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n').split('\n');
    expect(lines).toContain('FROM node:22.23.5-alpine3.24');
    expect(lines).toContain('USER 10001:10001');
    expect(lines).toContain('HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]');
    expect(lines).toContain('CMD ["node", "/app/server.mjs"]');
    expect(lines.join('\n')).toMatch(/-perm \/6000 -exec chmod a-s/);
    expect(lines.join('\n')).toMatch(/\/usr\/local\/bin\/npm/);
    expect(lines.join('\n')).not.toMatch(/^(ADD|RUN (apk|npm) (add|install))/m);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-fixture.spec.ts`
Expected: FAIL — `labs/_fixture/` does not exist.

- [ ] **Step 3: Implement**

Create `labs/_fixture/lab.json`:

```json
{
  "id": "r00",
  "slug": "fixture",
  "title": { "en": "Range fixture", "id": "Fixture range" },
  "app": "Fixture",
  "category": "Platform check",
  "difficulty": "easy",
  "levels": ["acolyte", "templar", "inquisitor", "divine"],
  "port": 8080,
  "health": "/healthz",
  "flag": { "placement": "file:/tmp/hvwa/flag.txt" },
  "resources": {},
  "tmpfs": [{ "path": "/tmp", "sizeMiB": 16 }],
  "needsBot": false,
  "themeId": "fixture",
  "scenario": { "en": "Not a lab: proves the range platform end to end.", "id": "Bukan lab: membuktikan platform range dari ujung ke ujung." },
  "briefing": { "en": "The flag is on /flag at every exploitable level.", "id": "Flag ada di /flag pada setiap level yang dapat dieksploitasi." },
  "hints": []
}
```

Create `labs/_fixture/Dockerfile`:

```dockerfile
# labs/_fixture — NOT a lab: the minimal range instance scripts/range-verify.mjs launches to prove the platform (hardening,
# routing, gate, forward-auth, flag delivery, isolation). It follows the range lab runtime contract (plan
# docs/superpowers/plans/2026-11-20-range-a-platform.md, "Interfaces for Plans B–E"): uid 10001, a read-only rootfs with
# /tmp as the only writable path, HVWA_FLAG planted then removed from the environment, a HEALTHCHECK on lab.json's health.
#   docker build -t hvwa-lab/r00:verify labs/_fixture
FROM node:22.23.5-alpine3.24
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v* \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
WORKDIR /app
COPY app/ ./
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["node", "/app/health.mjs"]
CMD ["node", "/app/server.mjs"]
```

Create `labs/_fixture/app/server.mjs`:

```js
// labs/_fixture/app/server.mjs — the range fixture (NOT a lab). Its start hook plants HVWA_FLAG where lab.json says (a
// file) and serves it as a page, then removes it from process.env, as every range lab must (spec range §6). Divine gets
// no flag and plants a decoy. /env and /headers are diagnostics for scripts/range-verify.mjs.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const host = process.env.HVWA_INSTANCE_HOST || 'localhost';
// Only the fixture's own spec moves the file (it runs outside a container); in the image it is lab.json's path.
const flagFile = process.env.HVWA_FIXTURE_FLAG_FILE || '/tmp/hvwa/flag.txt';
const DECOY = 'Divine is the secure reference: there is no flag here.';

const flag = process.env.HVWA_FLAG;
delete process.env.HVWA_FLAG;
mkdirSync(dirname(flagFile), { recursive: true });
writeFileSync(flagFile, `${level === 'divine' || !flag ? DECOY : flag}\n`, { mode: 0o400 });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  const send = (status, type, body) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (path === '/healthz') return send(200, 'application/json', '{"status":"ok"}');
  if (path === '/') return send(200, 'text/html; charset=utf-8', page('Range fixture',
    `<p>Level: <span data-testid="level">${esc(level)}</span></p><p>Host: ${esc(host)}</p><p><a href="/flag">Flag</a></p>`));
  if (path === '/flag') return send(200, 'text/html; charset=utf-8', page('Flag', `<pre data-testid="flag">${esc(readFileSync(flagFile, 'utf8').trim())}</pre>`));
  if (path === '/env') return send(200, 'application/json', JSON.stringify({ flagInEnv: 'HVWA_FLAG' in process.env, uid: process.getuid?.() ?? null }));
  if (path === '/headers') return send(200, 'application/json', JSON.stringify(req.headers));
  return send(404, 'text/plain', 'not found\n');
}).listen(port, '0.0.0.0', () => { console.log(`fixture on :${port} (${level})`); });
```

Create `labs/_fixture/app/health.mjs`:

```js
// labs/_fixture/app/health.mjs — the image's HEALTHCHECK: exit 0 when the app answers lab.json's health path, else 1.
const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-fixture.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. If Docker is running, also `docker build -t hvwa-lab/r00:verify labs/_fixture` once (expected: success). Expected: all green.

```bash
git add labs/_fixture/lab.json labs/_fixture/Dockerfile labs/_fixture/app/server.mjs labs/_fixture/app/health.mjs tests/range-fixture.spec.ts
git commit -m "feat(range): fixture lab for end-to-end platform verification"
```

---

### Task 26: `docker-compose.range.yml` behind the Cloudflare Tunnel, and Traefik's dynamic configuration

**Files:**
- Create: `docker-compose.range.yml`, `docker/range/traefik/range.yml`
- Test: `tests/range-compose.spec.ts`

Exposure (spec §3, §12; plan D3, D16): TLS ends at Cloudflare. The owner's `cloudflared` (bootstrap compose, not this stack) sends `hvwa.my.id` and `*.hvwa.my.id` to `http://traefik:80` over the external network `hvwa-edge`. Traefik (service `router`) joins `hvwa-edge` with the alias `traefik` (on that network only), has one plain-HTTP entrypoint on port 80 bound to its `hvwa-edge` address, publishes no port and has no ACME or certificate resolver. The `edge` network (router + portal) is internal: nothing in this stack has a route out except Traefik through `hvwa-edge`.

The socket-proxy flags (tecnativa v0.5.0: each variable gates the API path prefix of the same name; `POST=0` makes a proxy read-only; anything not granted is refused with 403):

| Variable | `socket-proxy` (warden, write) | `socket-proxy-ro` (Traefik) | Why |
|---|---|---|---|
| `CONTAINERS` | 1 | 1 | create/start/inspect/remove; list for Traefik |
| `NETWORKS` | 1 | 1 | create/connect/disconnect/remove the instance networks |
| `POST` | 1 | 0 | writes for the warden only (also needed for DELETE) |
| `EVENTS` | 0 | 1 | Traefik watches container events |
| `PING`, `VERSION` | 1 | 1 | health and API negotiation |
| `EXEC` | 0 | 0 | an exec created under `/containers/{id}/exec` can never be started (`/exec/{id}/start` refused) |
| `IMAGES`, `VOLUMES`, `BUILD`, `COMMIT`, `DISTRIBUTION`, `AUTH`, `SECRETS`, `CONFIGS`, `SERVICES`, `SWARM`, `NODES`, `TASKS`, `PLUGINS`, `SYSTEM`, `INFO`, `SESSION`, `GRPC` | 0 | 0 | nothing the range needs |
| `ALLOW_START`, `ALLOW_STOP`, `ALLOW_RESTARTS` | 0 | 0 | covered by `CONTAINERS`+`POST` for the warden; never for Traefik |

- [ ] **Step 1: Write the failing test**

Create `tests/range-compose.spec.ts`:

```ts
// The range stack as text (Docker itself is exercised by `npm run range:verify`): behind the owner's Cloudflare Tunnel
// (external network hvwa-edge, alias traefik, no published port, no TLS, no cloudflared here), the networks of spec §3,
// the two socket proxies and their exact flags, pinned third-party images, who mounts the Docker socket (the proxies
// only), and Traefik's dynamic config matching the names the warden's container labels use.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { containerSpec } from '../src/warden/template.js';
import { testRegistry } from './support/range.js';

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8').replace(/\r\n/g, '\n');
const yml = read('docker-compose.range.yml');
const dynamic = read('docker/range/traefik/range.yml');

/** The lines of a top-level service (`  <name>:` up to the next line indented 2 or less), comments dropped. */
function service(name: string): string[] {
  const lines = yml.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`no service ${name}`);
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !/^ {3,}/.test(line)) break;
    if (/^\s*#/.test(line)) continue;
    out.push(line);
  }
  return out;
}
const services = ['router', 'socket-proxy-ro', 'socket-proxy', 'warden', 'portal'];
const OFF = ['EXEC', 'IMAGES', 'VOLUMES', 'BUILD', 'COMMIT', 'DISTRIBUTION', 'AUTH', 'SECRETS', 'CONFIGS', 'SERVICES', 'SWARM', 'NODES',
  'TASKS', 'PLUGINS', 'SYSTEM', 'INFO', 'SESSION', 'GRPC', 'ALLOW_START', 'ALLOW_STOP', 'ALLOW_RESTARTS'];
const env = (name: string, value: string) => `      ${name}: "${value}"`;

describe('docker-compose.range.yml', () => {
  it('has exactly the five platform services (no cloudflared), with pinned third-party images', () => {
    const names = yml.slice(yml.indexOf('\nservices:\n'), yml.indexOf('\nnetworks:\n')).split('\n')
      .filter((l) => /^ {2}[a-z-]+:$/.test(l)).map((l) => l.trim().slice(0, -1));
    expect(names).toEqual(services);
    expect(yml).not.toMatch(/^ {2}cloudflared:/m);
    expect(service('router')).toContain('    image: traefik:v3.7.19');
    expect(service('socket-proxy')).toContain('    image: tecnativa/docker-socket-proxy:v0.5.0');
    expect(service('socket-proxy-ro')).toContain('    image: tecnativa/docker-socket-proxy:v0.5.0');
    expect(service('warden')).toContain('    image: sigmajo/hvwa:range-warden-${HVWA_RANGE_VERSION:-0.1.0}');
    expect(service('portal')).toContain('    image: sigmajo/hvwa:range-portal-${HVWA_RANGE_VERSION:-0.1.0}');
  });

  it('publishes no port at all and configures no TLS: Cloudflare terminates TLS, cloudflared is the only way in', () => {
    for (const name of services) expect(/\n {4}ports:/.test(`\n${service(name).join('\n')}`), name).toBe(false);
    expect(service('router').join('\n')).not.toMatch(/WEBSECURE|CERTIFICATESRESOLVERS|ACME|_TLS|REDIRECTIONS/);
  });

  it('the router joins the external hvwa-edge network as `traefik` (only there), and edge + traefik-ro', () => {
    expect(service('router').join('\n')).toContain('    networks:\n      hvwa-edge:\n        aliases: [traefik]\n      edge: {}\n      traefik-ro: {}');
    const nets = yml.slice(yml.indexOf('\nnetworks:\n'));
    expect(nets).toContain('  hvwa-edge:\n    external: true\n    name: ${HVWA_EDGE_NETWORK:-hvwa-edge}');
    for (const n of ['edge', 'control', 'traefik-ro']) {
      expect(nets).toContain(`  ${n}:\n    internal: true\n    driver_opts:\n      com.docker.network.bridge.gateway_mode_ipv4: isolated`);
    }
    expect(service('portal')).toContain('    networks: [edge, control]');
    expect(service('warden')).toContain('    networks: [control]');
  });

  it('one entrypoint on port 80, bound at start to the hvwa-edge address (the alias traefik), never 0.0.0.0', () => {
    const r = service('router');
    expect(r).toEqual(expect.arrayContaining([
      '    entrypoint: ["/bin/sh", "-ec"]',
      '        addr="$$(getent hosts traefik | awk \'NR==1 {print $$1}\')"',
      '        export TRAEFIK_ENTRYPOINTS_WEB_ADDRESS="$$addr:80" TRAEFIK_ENTRYPOINTS_WEB_ASDEFAULT=true',
      '        exec traefik',
      '      net.ipv4.ip_unprivileged_port_start: 0',
      '      TRAEFIK_ENTRYPOINTS_PING_ADDRESS: "127.0.0.1:8082"',
      '      TRAEFIK_PROVIDERS_DOCKER_ENDPOINT: "tcp://socket-proxy-ro:2375"',
      '      TRAEFIK_PROVIDERS_DOCKER_EXPOSEDBYDEFAULT: "false"',
      '      TRAEFIK_PROVIDERS_DOCKER_CONSTRAINTS: "Label(`hvwa.range`,`1`)"',
      '      TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic"',
      '      TRAEFIK_API: "false"',
      '      - ./docker/range/traefik:/etc/traefik/dynamic:ro',
    ]));
    expect(r.join('\n')).not.toMatch(/TRAEFIK_ENTRYPOINTS_WEB_ADDRESS: /); // never a fixed (all-interfaces) address
  });

  it('the write proxy: containers, networks, POST; nothing else; on `control` only', () => {
    expect(service('socket-proxy')).toEqual(expect.arrayContaining([env('CONTAINERS', '1'), env('NETWORKS', '1'), env('POST', '1'),
      env('EVENTS', '0'), env('PING', '1'), env('VERSION', '1'), ...OFF.map((n) => env(n, '0')), '    networks: [control]']));
  });

  it('the read-only proxy: containers, networks, events, no POST; on `traefik-ro` only', () => {
    expect(service('socket-proxy-ro')).toEqual(expect.arrayContaining([env('CONTAINERS', '1'), env('NETWORKS', '1'), env('POST', '0'),
      env('EVENTS', '1'), env('PING', '1'), env('VERSION', '1'), ...OFF.map((n) => env(n, '0')), '    networks: [traefik-ro]']));
  });

  it('only the two proxies mount the Docker socket, read-only', () => {
    for (const name of services) {
      const s = service(name).join('\n');
      expect(s.includes('/var/run/docker.sock'), name).toBe(name.startsWith('socket-proxy'));
      if (name.startsWith('socket-proxy')) expect(s).toContain('      - /var/run/docker.sock:/var/run/docker.sock:ro');
    }
  });

  it('every service is hardened: read-only rootfs, no capabilities, no new privileges, limits; Traefik not root', () => {
    for (const name of services) {
      expect(service(name), name).toEqual(expect.arrayContaining(['    read_only: true', '    cap_drop: [ALL]',
        '    security_opt: ["no-new-privileges:true"]']));
      expect(service(name).some((l) => l.startsWith('    pids_limit: ')), name).toBe(true);
      expect(service(name).some((l) => l.startsWith('    mem_limit: ')), name).toBe(true);
    }
    expect(service('router')).toContain('    user: "65532:65532"');
  });

  it('the portal: portal mode, the public scheme (https behind the tunnel), no trusted proxy; the warden: runtime and proxy', () => {
    const p = service('portal');
    expect(p).toEqual(expect.arrayContaining(['      HVWA_MODE: portal', '      HVWA_RANGE_PUBLIC_SCHEME: "${HVWA_RANGE_PUBLIC_SCHEME:-https}"',
      '      HVWA_WARDEN_URL: http://warden:8080', '      HVWA_LAB_REGISTRY: /etc/hvwa/registry.json', '      HVWA_FORWARD_AUTH_HOST: portal']));
    expect(p.join('\n')).not.toMatch(/TRUST_PROXY/);
    expect(service('warden')).toEqual(expect.arrayContaining(['      HVWA_DOCKER_URL: http://socket-proxy:2375',
      '      HVWA_RANGE_RUNTIME: "${HVWA_RANGE_RUNTIME:-runc}"', '      HVWA_TRAEFIK_CONTAINER: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"']));
    expect(service('router')).toContain('    container_name: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"');
  });
});

describe('docker/range/traefik/range.yml', () => {
  it('forward-auth to the portal with the secret header set before and removed after; Traefik trusts no client X-Forwarded-*', () => {
    expect(dynamic).toContain('    hvwa-forward-auth:\n      forwardAuth:\n        address: "http://portal:1337/__hvwa/auth"\n        trustForwardHeader: false\n        authRequestHeaders:\n          - Cookie\n          - X-Hvwa-Auth-Secret');
    expect(dynamic).toContain('    hvwa-auth-secret:\n      headers:\n        customRequestHeaders:\n          X-Hvwa-Auth-Secret: \'{{ env "HVWA_FORWARD_AUTH_SECRET" }}\'');
    expect(dynamic).toContain('    hvwa-strip-secret:\n      headers:\n        customRequestHeaders:\n          X-Hvwa-Auth-Secret: ""');
    expect(dynamic).toContain('    hvwa-instance:\n      chain:\n        middlewares:\n          - hvwa-auth-secret\n          - hvwa-forward-auth\n          - hvwa-strip-secret');
    expect(dynamic).not.toMatch(/^\s*(tls|certResolver):/m); // no TLS section: Cloudflare terminates TLS
  });

  it('the portal router and service, and exactly the names the warden\'s labels reference', () => {
    expect(dynamic).toContain("      rule: 'Host(`{{ env \"HVWA_PORTAL_HOST\" }}`)'");
    expect(dynamic).toContain('        servers:\n          - url: "http://portal:1337"');
    const labels = containerSpec({ lab: testRegistry().get('r01')!, level: 'acolyte', instanceId: 'a'.repeat(26), flag: `HVWA{${'b'.repeat(26)}}`, userId: 1, expiresAt: 1 },
      { domain: 'localhost', runtime: 'runc' }).body.Labels as Record<string, string>;
    const refs = Object.entries(labels).filter(([k]) => /\.(middlewares|service)$/.test(k)).map(([, v]) => v).filter((v) => v.endsWith('@file'));
    expect(refs.sort()).toEqual(['hvwa-instance@file', 'hvwa-portal@file']);
    expect(dynamic).toContain('    hvwa-instance:\n');
    expect(dynamic).toContain('    hvwa-portal:\n      loadBalancer:');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-compose.spec.ts`
Expected: FAIL — the two files do not exist.

- [ ] **Step 3: Implement**

Create `docker/range/traefik/range.yml`:

```yaml
# docker/range/traefik/range.yml — Traefik's file-provider configuration for the HVWA range (a Go template: {{ env }} reads
# the router container's environment). Mounted read-only at /etc/traefik/dynamic. Instance routers come from the labels
# the warden puts on each lab container (src/warden/template.ts) and use the middleware and the service defined here
# (hvwa-instance@file, hvwa-portal@file). Plain HTTP only: TLS ends at Cloudflare's edge (spec §12). Nothing secret here.
http:
  routers:
    hvwa-portal:
      rule: 'Host(`{{ env "HVWA_PORTAL_HOST" }}`)'
      service: hvwa-portal
      priority: 100

  services:
    hvwa-portal:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: "http://portal:1337"

  middlewares:
    # Every request to an instance host is checked by the portal first (/__hvwa/auth: the host-only hvwa_gate cookie).
    # The secret header proves the call comes from this Traefik: set just before the check, removed just after it, so
    # the lab never sees it (the portal compares it in constant time).
    hvwa-auth-secret:
      headers:
        customRequestHeaders:
          X-Hvwa-Auth-Secret: '{{ env "HVWA_FORWARD_AUTH_SECRET" }}'
    hvwa-forward-auth:
      forwardAuth:
        address: "http://portal:1337/__hvwa/auth"
        trustForwardHeader: false
        authRequestHeaders:
          - Cookie
          - X-Hvwa-Auth-Secret
    hvwa-strip-secret:
      headers:
        customRequestHeaders:
          X-Hvwa-Auth-Secret: ""
    hvwa-instance:
      chain:
        middlewares:
          - hvwa-auth-secret
          - hvwa-forward-auth
          - hvwa-strip-secret
```

Create `docker-compose.range.yml`:

```yaml
# HVWA Range — the platform stack (spec docs/superpowers/specs/2026-11-20-hvwa-range-design.md §3, §12).
# Every lab is DELIBERATELY VULNERABLE and runs in its own container, which only the warden creates.
#
#   browser --HTTPS--> Cloudflare (TLS) --tunnel--> cloudflared (the owner's bootstrap compose, NOT this stack)
#     --http on network hvwa-edge--> router (Traefik, alias `traefik`, :80 on its hvwa-edge address only)
#        +-> portal:1337 (network edge)          Host = HVWA_PORTAL_HOST (the domain)
#        +-> i-<id>.<domain>                     forward-auth -> portal, then the lab
#        +-> i-<id>.<domain>/__hvwa/*            the portal (the gate)
#   portal --control--> warden:8080 --control--> socket-proxy:2375     (containers + networks, write)
#   router --traefik-ro--> socket-proxy-ro:2375                         (containers + networks, read only)
#   each instance: its own internal network hvwa-i-<id> (no egress, isolated gateway), shared with the router only,
#   which listens on nothing there.
#
# No published ports and no TLS here. Needs Docker Engine 28+. Required in a .env next to this file (never commit it):
#   HVWA_RANGE_DOMAIN                     e.g. hvwa.my.id (instances at i-<id>.hvwa.my.id)
#   HVWA_ADMIN_PASSWORD                   the first admin's password, 10+ characters (used once; change it after)
#   HVWA_WARDEN_SECRET, HVWA_FORWARD_AUTH_SECRET   each from `openssl rand -hex 32`
#   HVWA_RANGE_RUNTIME=runsc              on a host with gVisor (the POC host requires it)
# Optional: HVWA_PORTAL_HOST, HVWA_RANGE_CAPACITY, HVWA_RANGE_IDLE_MIN / _MAX_MIN / _EXTEND_MIN / _CEILING_MIN,
#   HVWA_REGISTRATION_CODE, HVWA_RANGE_KEY, HVWA_RANGE_VERSION (image tags), HVWA_LAB_REGISTRY_FILE (default
#   ./labs/registry.json), HVWA_EDGE_NETWORK (default hvwa-edge), HVWA_RANGE_PUBLIC_SCHEME / HVWA_RANGE_PUBLIC_PORT
#   (local runs: http and the forwarder's port), HVWA_TRAEFIK_CONTAINER.
# Lab images listed in the registry must already be on this engine (the warden never pulls: IMAGES=0 on its proxy).
#
# Local run (no tunnel; browsers resolve *.localhost to loopback):
#   docker network create hvwa-edge
#   HVWA_RANGE_DOMAIN=localhost HVWA_PORTAL_HOST=hvwa.localhost HVWA_RANGE_PUBLIC_SCHEME=http HVWA_RANGE_PUBLIC_PORT=18080 \
#     ...the secrets... docker compose -f docker-compose.range.yml up -d
#   and a forwarder in place of cloudflared:
#   docker run -d --name hvwa-local-tunnel --network hvwa-edge -p 127.0.0.1:18080:8080 sigmajo/hvwa:range-portal-0.1.0 \
#     node -e "const n=require('node:net');n.createServer((c)=>{const u=n.connect(80,'traefik');c.pipe(u).pipe(c);c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8080)"
#   `npm run range:verify` does all of this on its own throwaway network, checks spec §11, and removes everything.

name: hvwa-range

services:
  router:
    image: traefik:v3.7.19
    # The warden connects this container to every instance network, by this name.
    container_name: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"
    user: "65532:65532"
    depends_on:
      socket-proxy-ro:
        condition: service_started
      portal:
        condition: service_healthy
    networks:
      hvwa-edge:
        aliases: [traefik]
      edge: {}
      traefik-ro: {}
    # One entrypoint, port 80, on the hvwa-edge address alone (plan D3). The alias `traefik` exists only on hvwa-edge,
    # so resolving it gives exactly that address; instance networks (connected later by the warden) find nothing listening.
    entrypoint: ["/bin/sh", "-ec"]
    command:
      - |
        addr="$$(getent hosts traefik | awk 'NR==1 {print $$1}')"
        if [ -z "$$addr" ]; then echo "router: no address on the hvwa-edge network (alias traefik)" >&2; exit 1; fi
        export TRAEFIK_ENTRYPOINTS_WEB_ADDRESS="$$addr:80" TRAEFIK_ENTRYPOINTS_WEB_ASDEFAULT=true
        exec traefik
    sysctls:
      net.ipv4.ip_unprivileged_port_start: 0
    environment:
      TRAEFIK_ENTRYPOINTS_PING_ADDRESS: "127.0.0.1:8082"
      TRAEFIK_PING: "true"
      TRAEFIK_PING_ENTRYPOINT: "ping"
      TRAEFIK_PROVIDERS_DOCKER: "true"
      TRAEFIK_PROVIDERS_DOCKER_ENDPOINT: "tcp://socket-proxy-ro:2375"
      TRAEFIK_PROVIDERS_DOCKER_EXPOSEDBYDEFAULT: "false"
      TRAEFIK_PROVIDERS_DOCKER_CONSTRAINTS: "Label(`hvwa.range`,`1`)"
      TRAEFIK_PROVIDERS_FILE_DIRECTORY: "/etc/traefik/dynamic"
      TRAEFIK_PROVIDERS_FILE_WATCH: "false"
      TRAEFIK_API: "false"
      TRAEFIK_GLOBAL_CHECKNEWVERSION: "false"
      TRAEFIK_GLOBAL_SENDANONYMOUSUSAGE: "false"
      TRAEFIK_LOG_LEVEL: "INFO"
      TRAEFIK_ACCESSLOG: "true"
      # Read by docker/range/traefik/range.yml ({{ env }}).
      HVWA_PORTAL_HOST: "${HVWA_PORTAL_HOST:-${HVWA_RANGE_DOMAIN:?set HVWA_RANGE_DOMAIN}}"
      HVWA_FORWARD_AUTH_SECRET: "${HVWA_FORWARD_AUTH_SECRET:?set HVWA_FORWARD_AUTH_SECRET}"
    volumes:
      - ./docker/range/traefik:/etc/traefik/dynamic:ro
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 512
    mem_limit: 512m
    cpus: 2.0
    healthcheck:
      test: ["CMD", "traefik", "healthcheck", "--ping"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s
      start_interval: 1s

  socket-proxy-ro:
    image: tecnativa/docker-socket-proxy:v0.5.0
    networks: [traefik-ro]
    environment:
      # Read only (POST=0): what Traefik's Docker provider needs.
      CONTAINERS: "1"
      NETWORKS: "1"
      EVENTS: "1"
      PING: "1"
      VERSION: "1"
      POST: "0"
      EXEC: "0"
      IMAGES: "0"
      VOLUMES: "0"
      BUILD: "0"
      COMMIT: "0"
      DISTRIBUTION: "0"
      AUTH: "0"
      SECRETS: "0"
      CONFIGS: "0"
      SERVICES: "0"
      SWARM: "0"
      NODES: "0"
      TASKS: "0"
      PLUGINS: "0"
      SYSTEM: "0"
      INFO: "0"
      SESSION: "0"
      GRPC: "0"
      ALLOW_START: "0"
      ALLOW_STOP: "0"
      ALLOW_RESTARTS: "0"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    read_only: true
    tmpfs:
      - /run:rw,nosuid,nodev,size=1m
      - /tmp:rw,noexec,nosuid,nodev,size=8m
      - /var/lib/haproxy:rw,noexec,nosuid,nodev,size=1m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 64
    mem_limit: 64m
    cpus: 0.5

  socket-proxy:
    image: tecnativa/docker-socket-proxy:v0.5.0
    networks: [control]
    environment:
      # The warden's: containers and networks, with writes (POST). Never exec, images, volumes, swarm, system.
      CONTAINERS: "1"
      NETWORKS: "1"
      POST: "1"
      EVENTS: "0"
      PING: "1"
      VERSION: "1"
      EXEC: "0"
      IMAGES: "0"
      VOLUMES: "0"
      BUILD: "0"
      COMMIT: "0"
      DISTRIBUTION: "0"
      AUTH: "0"
      SECRETS: "0"
      CONFIGS: "0"
      SERVICES: "0"
      SWARM: "0"
      NODES: "0"
      TASKS: "0"
      PLUGINS: "0"
      SYSTEM: "0"
      INFO: "0"
      SESSION: "0"
      GRPC: "0"
      ALLOW_START: "0"
      ALLOW_STOP: "0"
      ALLOW_RESTARTS: "0"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    read_only: true
    tmpfs:
      - /run:rw,nosuid,nodev,size=1m
      - /tmp:rw,noexec,nosuid,nodev,size=8m
      - /var/lib/haproxy:rw,noexec,nosuid,nodev,size=1m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 64
    mem_limit: 64m
    cpus: 0.5

  warden:
    image: sigmajo/hvwa:range-warden-${HVWA_RANGE_VERSION:-0.1.0}
    init: true
    depends_on:
      socket-proxy:
        condition: service_started
    networks: [control]
    environment:
      HVWA_WARDEN_SECRET: "${HVWA_WARDEN_SECRET:?set HVWA_WARDEN_SECRET}"
      HVWA_DOCKER_URL: http://socket-proxy:2375
      HVWA_LAB_REGISTRY: /etc/hvwa/registry.json
      HVWA_RANGE_DOMAIN: "${HVWA_RANGE_DOMAIN:?set HVWA_RANGE_DOMAIN}"
      HVWA_TRAEFIK_CONTAINER: "${HVWA_TRAEFIK_CONTAINER:-hvwa-range-traefik}"
      # runsc (gVisor) on the POC host; the warden always writes it as HostConfig.Runtime.
      HVWA_RANGE_RUNTIME: "${HVWA_RANGE_RUNTIME:-runc}"
    volumes:
      - "${HVWA_LAB_REGISTRY_FILE:-./labs/registry.json}:/etc/hvwa/registry.json:ro"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=16m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 128
    mem_limit: 256m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 20s
      start_interval: 1s

  portal:
    image: sigmajo/hvwa:range-portal-${HVWA_RANGE_VERSION:-0.1.0}
    init: true
    depends_on:
      warden:
        condition: service_healthy
    networks: [edge, control]
    environment:
      HVWA_MODE: portal
      HVWA_RANGE_DOMAIN: "${HVWA_RANGE_DOMAIN:?set HVWA_RANGE_DOMAIN}"
      HVWA_PORTAL_HOST: "${HVWA_PORTAL_HOST:-}"
      # https behind the tunnel (Secure, host-only cookies; the forms' Origin check); http only for local runs.
      HVWA_RANGE_PUBLIC_SCHEME: "${HVWA_RANGE_PUBLIC_SCHEME:-https}"
      HVWA_RANGE_PUBLIC_PORT: "${HVWA_RANGE_PUBLIC_PORT:-}"
      HVWA_ADMIN_PASSWORD: "${HVWA_ADMIN_PASSWORD:?set HVWA_ADMIN_PASSWORD (10+ characters)}"
      HVWA_WARDEN_URL: http://warden:8080
      HVWA_WARDEN_SECRET: "${HVWA_WARDEN_SECRET:?set HVWA_WARDEN_SECRET}"
      HVWA_FORWARD_AUTH_SECRET: "${HVWA_FORWARD_AUTH_SECRET:?set HVWA_FORWARD_AUTH_SECRET}"
      HVWA_FORWARD_AUTH_HOST: portal
      HVWA_RANGE_KEY: "${HVWA_RANGE_KEY:-}"
      HVWA_RANGE_CAPACITY: "${HVWA_RANGE_CAPACITY:-140}"
      HVWA_RANGE_IDLE_MIN: "${HVWA_RANGE_IDLE_MIN:-30}"
      HVWA_RANGE_MAX_MIN: "${HVWA_RANGE_MAX_MIN:-120}"
      HVWA_RANGE_EXTEND_MIN: "${HVWA_RANGE_EXTEND_MIN:-30}"
      HVWA_RANGE_CEILING_MIN: "${HVWA_RANGE_CEILING_MIN:-240}"
      HVWA_REGISTRATION_CODE: "${HVWA_REGISTRATION_CODE:-}"
      HVWA_LAB_REGISTRY: /etc/hvwa/registry.json
      FLAG_SECRET: "${FLAG_SECRET:-}"
    volumes:
      - range-data:/data
      - "${HVWA_LAB_REGISTRY_FILE:-./labs/registry.json}:/etc/hvwa/registry.json:ro"
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    pids_limit: 256
    mem_limit: 512m
    cpus: 2.0
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:1337/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s
      start_interval: 1s

  # The tunnel connector is NOT part of this stack: it runs in the owner's bootstrap compose on the same external
  # network, roughly like this (its token comes from the owner's 0600 secret file, never from this repository):
  #   cloudflared:
  #     image: cloudflare/cloudflared:<pinned version>
  #     command: ["tunnel", "--no-autoupdate", "run"]
  #     networks: [hvwa-edge]
  #     read_only: true
  #     cap_drop: [ALL]
  #     security_opt: ["no-new-privileges:true"]
  #   with the tunnel's public hostnames hvwa.my.id and *.hvwa.my.id -> http://traefik:80

networks:
  hvwa-edge:
    external: true
    name: ${HVWA_EDGE_NETWORK:-hvwa-edge}
  edge:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
  control:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated
  traefik-ro:
    internal: true
    driver_opts:
      com.docker.network.bridge.gateway_mode_ipv4: isolated

volumes:
  range-data: {}
```

Notes for the implementer (both are checked by Task 29, not by unit tests):
- The router's wrapper uses `getent` and `awk` from the Traefik image's Alpine base. If `getent hosts traefik` prints nothing there, the router exits with the message above; check `docker compose logs router`, and resolve the alias with `nslookup traefik 127.0.0.11` instead (same `awk` extraction of the last `Address` line). Never fall back to `0.0.0.0:80`: that would let every instance reach the portal and forge `CF-Connecting-IP`.
- If a socket proxy exits with "Read-only file system", add the path its log names to that proxy's `tmpfs` list (in both proxies); never remove `read_only`, `cap_drop` or `no-new-privileges` instead.

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-compose.spec.ts`
Expected: PASS. If Docker is running, also check the file parses with the required variables set (PowerShell): `docker network create hvwa-edge-check; $env:HVWA_EDGE_NETWORK='hvwa-edge-check'; $env:HVWA_RANGE_DOMAIN='localhost'; $env:HVWA_ADMIN_PASSWORD='Admin-Pass-1234'; $env:HVWA_WARDEN_SECRET=('w'*40); $env:HVWA_FORWARD_AUTH_SECRET=('f'*40); docker compose -f docker-compose.range.yml config --quiet; docker network rm hvwa-edge-check`. Expected: exit 0, no output from `config --quiet`.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green.

```bash
git add docker-compose.range.yml docker/range/traefik/range.yml tests/range-compose.spec.ts
git commit -m "feat(range): compose stack behind the Cloudflare Tunnel (hvwa-edge, no ports, no TLS) and forward-auth config"
```

---

### Task 27: `scripts/range-verify.mjs`: spec §11 security checks against a running local range

`range-verify` runs the real compose file in local mode: no Cloudflare, so it creates its own external network (`hvwa-range-verify-edge`, passed as `HVWA_EDGE_NETWORK`) and puts a one-line TCP forwarder container on it in place of `cloudflared` (`127.0.0.1:18080` → `traefik:80`). Everything is plain HTTP, the portal is `hvwa.localhost`, instances are `i-<id>.localhost`, and requests carry an explicit `Host` (no DNS needed).

**Files:**
- Create: `scripts/range-verify.mjs`
- Test: `tests/range-verify.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-verify.spec.ts`:

```ts
// scripts/range-verify.mjs's pure parts: the hardening comparison (pinned to what src/warden/template.ts creates for the
// fixture lab, as Docker reports it back, for runc and runsc) and the probe classification; and its safety: its own
// compose project and networks, no prune, no run beside another range.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyProbe, expectedHostConfig, hardeningProblems, PROJECT } from '../scripts/range-verify.mjs';
import { parseRegistry } from '../src/lab-registry.js';
import { containerSpec, type Runtime } from '../src/warden/template.js';

const ID = 'abcdefghijklmnopqrstuvwxyz';
const TRAEFIK = 'hvwa-range-verify-traefik';
const fixture = parseRegistry({ schema: 1, labs: [{
  ...JSON.parse(readFileSync(join(process.cwd(), 'labs', '_fixture', 'lab.json'), 'utf8')), version: '0.0.0', image: `sha256:${'f'.repeat(64)}`,
}] }).get('r00')!;

/** What `docker container inspect` / `docker network inspect` report for a container made from the template. */
function reported(runtime: Runtime = 'runc') {
  const { body } = containerSpec({ lab: fixture, level: 'templar', instanceId: ID, flag: `HVWA{${'a'.repeat(26)}}`, userId: 1, expiresAt: 1 },
    { domain: 'localhost', runtime });
  const hc = body.HostConfig as Record<string, unknown>;
  return {
    container: {
      HostConfig: { ...hc, CapAdd: null, Binds: null, Mounts: null, Devices: [], VolumesFrom: null, PortBindings: {} } as Record<string, unknown>,
      Mounts: [], Config: { User: body.User as string, Labels: body.Labels as Record<string, string> },
    },
    network: {
      Internal: true, Options: { 'com.docker.network.bridge.gateway_mode_ipv4': 'isolated' },
      Containers: { a: { Name: `hvwa-i-${ID}` }, b: { Name: TRAEFIK } } as Record<string, { Name: string }>,
    },
  };
}

describe('hardeningProblems', () => {
  it('finds nothing in exactly what the template creates (expectedHostConfig agrees with src/warden/template.ts)', () => {
    for (const runtime of ['runc', 'runsc'] as const) {
      const { container, network } = reported(runtime);
      expect(hardeningProblems(container, network, ID, TRAEFIK, runtime), runtime).toEqual([]);
      for (const [k, v] of Object.entries(expectedHostConfig(runtime))) expect(container.HostConfig[k], `${runtime} ${k}`).toEqual(v);
    }
    const { container, network } = reported('runc');
    expect(hardeningProblems(container, network, ID, TRAEFIK, 'runsc').join('\n')).toContain('HostConfig.Runtime');
  });

  it('names every weakening', () => {
    const { container, network } = reported();
    const weak = {
      ...container,
      HostConfig: { ...container.HostConfig, Privileged: true, CapAdd: ['NET_ADMIN'], Binds: ['/:/host'], ReadonlyRootfs: false,
        SecurityOpt: ['seccomp=unconfined'], PortBindings: { '8080/tcp': [{ HostPort: '8080' }] } },
      Config: { ...container.Config, User: 'root' },
    };
    const leaky = { ...network, Internal: false, Containers: { ...network.Containers, c: { Name: 'hvwa-range-verify-portal-1' } } };
    const text = hardeningProblems(weak, leaky, ID, TRAEFIK).join('\n');
    for (const want of ['HostConfig.Privileged', 'HostConfig.CapAdd', 'HostConfig.Binds', 'HostConfig.ReadonlyRootfs', 'HostConfig.SecurityOpt',
      'unconfined', 'HostConfig.PortBindings', 'User is "root"', 'not internal', 'the instance network holds']) {
      expect(text, want).toContain(want);
    }
  });
});

describe('classifyProbe', () => {
  it('blocked = nothing answered; refused = a host said no; anything else = reached', () => {
    for (const o of ['ETIMEDOUT', 'TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND']) expect(classifyProbe(o), o).toBe('blocked');
    expect(classifyProbe('ECONNREFUSED')).toBe('refused');
    for (const o of ['CONNECTED', 'ECONNRESET', '', 'something else']) expect(classifyProbe(o), o).toBe('reached');
  });
});

describe('the script', () => {
  it('uses its own compose project, edge network and tunnel stand-in, never prunes, and refuses to run beside another range', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'range-verify.mjs'), 'utf8');
    expect(PROJECT).toBe('hvwa-range-verify');
    expect(src).toContain("const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', PROJECT];");
    expect(src).toContain('const EDGE_NETWORK = `${PROJECT}-edge`;');
    expect(src).toContain('const TUNNEL = `${PROJECT}-tunnel`;');
    expect(src).not.toMatch(/\bprune\b/);
    expect(src).toContain("'label=hvwa.range=1'");
    expect(src).toContain('BLOCKED');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-verify.spec.ts`
Expected: FAIL — `scripts/range-verify.mjs` does not exist.

- [ ] **Step 3: Implement**

Create `scripts/range-verify.mjs`:

```js
// scripts/range-verify.mjs — `npm run range:verify` (NOT part of `npm test`; needs Docker Engine 28+, the docker CLI and
// a free loopback port 18080). Builds the range images (scripts/range-images.mjs build) and the fixture lab, then runs
// its OWN copy of docker-compose.range.yml in local mode: project hvwa-range-verify, its own external network
// hvwa-range-verify-edge (HVWA_EDGE_NETWORK) with a TCP forwarder on 127.0.0.1:18080 standing in for cloudflared, plain
// HTTP, the portal at hvwa.localhost, instances at i-<id>.localhost, capacity 2, runtime HVWA_VERIFY_RUNTIME (runc;
// runsc on a host with gVisor). Then it checks spec §11 from the outside:
//   container hardening exact; Traefik publishes nothing and listens only toward the tunnel; the gate and forward-auth;
//   host-only cookies; cross-user refusal; instance -> internet / DNS / portal / warden / socket proxies / another
//   instance / Traefik all blocked; the client IP (CF-Connecting-IP) behind the registration limit; a flag shared between
//   users refused; the proxies' allowlists; the queue; Extend; the reaper (a crashed instance); the startup reconcile
//   (an orphan); Stop.
// Stops at the first failure (later checks build on earlier ones), prints the stack's logs, and always ends with
// `docker compose down -v` plus the removal of its forwarder, its edge network and every hvwa-i-* it made.
// Refuses to start, changing nothing, when an hvwa.range=1 container or an hvwa-i-* network already exists on this
// engine: a real range's reaper and this one would fight over them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'hvwa-range-verify';
const COMPOSE_FILE = join(root, 'docker-compose.range.yml');
const COMPOSE = ['compose', '-f', COMPOSE_FILE, '-p', PROJECT];
const EDGE_NETWORK = `${PROJECT}-edge`;
const TUNNEL = `${PROJECT}-tunnel`;
const TRAEFIK = `${PROJECT}-traefik`;
const HTTP_PORT = Number(process.env.HVWA_VERIFY_HTTP_PORT || 18080);
const RUNTIME = (process.env.HVWA_VERIFY_RUNTIME || 'runc').trim();
const PORTAL = 'hvwa.localhost';
const FIXTURE_TAG = 'hvwa-lab/r00:verify';
const PASSWORD = 'Verify-Pass-1234';
const say = (msg) => console.log(`range:verify ${msg}`);

/** What src/warden/template.ts creates for the fixture (no lower limits, one 16 MiB /tmp), as Docker reports it. */
export function expectedHostConfig(runtime = 'runc') {
  return Object.freeze({
    ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false, PidsLimit: 128, Memory: 268435456, MemorySwap: 268435456,
    NanoCpus: 500000000, PublishAllPorts: false, IpcMode: 'private', Runtime: runtime, SecurityOpt: ['no-new-privileges:true'],
    RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
  });
}

/** Every way an instance (`docker container inspect`) and its network (`docker network inspect`) differ from spec §7. */
export function hardeningProblems(container, network, instanceId, traefikName, runtime = 'runc') {
  const p = [];
  const hc = container.HostConfig ?? {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [k, v] of Object.entries(expectedHostConfig(runtime))) {
    if (!same(hc[k], v)) p.push(`HostConfig.${k} is ${JSON.stringify(hc[k])}, want ${JSON.stringify(v)}`);
  }
  const empty = (x) => x === null || x === undefined || (Array.isArray(x) ? x.length === 0 : typeof x === 'object' && Object.keys(x).length === 0);
  for (const k of ['CapAdd', 'Binds', 'Mounts', 'Devices', 'VolumesFrom', 'PortBindings']) if (!empty(hc[k])) p.push(`HostConfig.${k} is not empty: ${JSON.stringify(hc[k])}`);
  if ((hc.SecurityOpt ?? []).some((o) => /unconfined/.test(o))) p.push('a security profile is unconfined');
  if (hc.NetworkMode !== `hvwa-i-${instanceId}`) p.push(`HostConfig.NetworkMode is ${hc.NetworkMode}`);
  if (!empty(container.Mounts)) p.push(`Mounts: ${JSON.stringify(container.Mounts)}`);
  const user = String(container.Config?.User ?? '');
  if (!/^\d+:\d+$/.test(user) || Number(user.split(':')[0]) < 1000) p.push(`User is "${user}", want a uid of 1000 or more`);
  if (container.Config?.Labels?.['hvwa.range'] !== '1') p.push('the label hvwa.range=1 is missing');
  if (network.Internal !== true) p.push('the instance network is not internal');
  if (network.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') p.push('the instance network gateway is not isolated');
  const members = Object.values(network.Containers ?? {}).map((c) => c.Name).sort();
  const want = [`hvwa-i-${instanceId}`, traefikName].sort();
  if (!same(members, want)) p.push(`the instance network holds ${members.join(', ')}; want ${want.join(', ')}`);
  return p;
}

/** blocked = nothing answered; refused = a host said no (nothing listens); anything else = reached. */
export function classifyProbe(outcome) {
  if (['ETIMEDOUT', 'TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'EAI_FAIL', 'EAI_NONAME'].includes(outcome)) return 'blocked';
  if (outcome === 'ECONNREFUSED') return 'refused';
  return 'reached';
}

// ------------------------------------------------------------------------------------------------ process helpers
/** Enough for compose to parse the file (its `:?` variables) before the real values exist: the preflight's `down`. */
const PARSE_ENV = Object.freeze({
  HVWA_EDGE_NETWORK: EDGE_NETWORK, HVWA_TRAEFIK_CONTAINER: TRAEFIK, HVWA_RANGE_DOMAIN: 'localhost',
  HVWA_ADMIN_PASSWORD: 'unused-unused', HVWA_WARDEN_SECRET: 'unused', HVWA_FORWARD_AUTH_SECRET: 'unused',
});
let env = { ...process.env, ...PARSE_ENV };
function run(cmd, args, { inherit = false, timeoutMs = 180_000 } = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: timeoutMs, stdio: inherit ? 'inherit' : 'pipe' });
  if (r.error) throw new Error(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const show = (r) => `exit ${r.code}${r.out ? `, stdout: ${r.out.slice(0, 400)}` : ''}${r.err ? `, stderr: ${r.err.slice(0, 400)}` : ''}`;
function must(cmd, args, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${show(r)}`);
  return r.out;
}
const compose = (args, opts) => run('docker', [...COMPOSE, ...args], opts);
const inspect = (kind, name) => JSON.parse(must('docker', [kind, 'inspect', name]))[0];
const exists = (kind, name) => run('docker', [kind, 'inspect', name]).code === 0;
const serviceContainer = (service) => `${PROJECT}-${service}-1`;
/** A container's address on a network: the exact name (external and instance networks) or the compose-prefixed one. */
function ipOn(container, network) {
  const nets = inspect('container', container).NetworkSettings.Networks;
  const key = Object.keys(nets).find((n) => n === network || n === `${PROJECT}_${network}`);
  if (!key) throw new Error(`${container} is not on ${network}`);
  return nets[key].IPAddress;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(what, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch (err) { last = err; }
    await sleep(everyMs);
  }
  throw new Error(`${what}: not within ${timeoutMs} ms${last ? ` (last error: ${last.message})` : ''}`);
}

// ------------------------- HTTP through the tunnel stand-in on loopback, with an explicit Host (*.localhost, no DNS)
function hit(method, host, path, { headers = {}, body, jar } = {}) {
  return new Promise((resolve, reject) => {
    const cookie = jar ? jar.header(host) : '';
    const req = httpRequest({
      host: '127.0.0.1', port: HTTP_PORT, method, path, timeout: 30_000,
      headers: { host: `${host}:${HTTP_PORT}`, ...(cookie ? { cookie } : {}), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (d) => { text += d; }).on('end', () => {
        const setCookies = [res.headers['set-cookie'] ?? []].flat();
        if (jar) jar.take(host, setCookies);
        resolve({ status: res.statusCode, headers: res.headers, body: text, setCookies });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method} ${host}${path} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

/** Host-only cookies, as a browser keeps them for these hosts (none of ours ever has a Domain). */
function newJar() {
  const byHost = new Map();
  return {
    header: (host) => [...(byHost.get(host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; '),
    take(host, lines) {
      const m = byHost.get(host) ?? new Map();
      for (const line of lines) {
        const [pair] = line.split(';');
        const eq = pair.indexOf('=');
        if (eq < 1) continue;
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v === '') m.delete(k); else m.set(k, v);
      }
      byHost.set(host, m);
    },
    get: (host, name) => byHost.get(host)?.get(name),
  };
}
function browser(headers = {}) {
  const jar = newJar();
  return {
    jar,
    get: (host, path) => hit('GET', host, path, { jar, headers }),
    form: (host, path, fields, extra = {}) => hit('POST', host, path, {
      jar, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(fields).toString(),
    }),
  };
}
function csrfOf(html) {
  const v = /name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if (!v) throw new Error('no _csrf field on the page');
  return v;
}

// ------------------------------------------------- probes from INSIDE an instance (docker exec from the host CLI)
const TCP_PROBE = (host, port) => `const s=require('node:net').connect({host:${JSON.stringify(host)},port:${port}});`
  + "s.setTimeout(4000,()=>{console.log('TIMEOUT');process.exit(0)});s.on('connect',()=>{console.log('CONNECTED');process.exit(0)});"
  + "s.on('error',(e)=>{console.log(e.code||e.message);process.exit(0)})";
function probe(container, host, port) {
  const r = run('docker', ['exec', container, 'node', '-e', TCP_PROBE(host, port)], { timeoutMs: 30_000 });
  if (r.code !== 0) throw new Error(`the probe in ${container} did not run: ${show(r)}`);
  return classifyProbe(r.out.trim());
}
function dnsProbe(container, name) {
  const script = `require('node:dns').lookup(${JSON.stringify(name)},(e)=>{console.log(e?e.code:'RESOLVED')})`;
  return must('docker', ['exec', container, 'node', '-e', script], { timeoutMs: 30_000 });
}

// ------------------------------------------------------------------------------------------------ the flows
const s = { launchMs: [] };
const secrets = {};

async function register(username, b = browser()) {
  const page = await b.get(PORTAL, '/register');
  if (page.status !== 200) throw new Error(`GET /register -> ${page.status}`);
  const r = await b.form(PORTAL, '/register', { _csrf: csrfOf(page.body), username, password: PASSWORD, confirm: PASSWORD });
  return { b, r };
}
async function player(username) {
  const { b, r } = await register(username);
  if (r.status !== 303 || r.headers.location !== '/login?registered=1') throw new Error(`register ${username} -> ${r.status} ${r.headers.location ?? ''}`);
  const login = await b.get(PORTAL, '/login');
  const signed = await b.form(PORTAL, '/login', { _csrf: csrfOf(login.body), username, password: PASSWORD });
  if (signed.status !== 303) throw new Error(`sign-in of ${username} -> ${signed.status}`);
  const auth = signed.setCookies.find((l) => l.startsWith('hvwa_auth=')) ?? '';
  if (!/; HttpOnly/i.test(auth) || /domain=/i.test(auth)) throw new Error(`hvwa_auth is not host-only HttpOnly: ${auth}`);
  return b;
}
const panel = async (b, level) => (await b.get(PORTAL, `/labs/r00/panel?level=${level}`)).body;
async function action(b, name, level) {
  const page = await b.get(PORTAL, `/labs/r00?level=${level}`);
  return b.form(PORTAL, `/labs/r00/${name}`, { _csrf: csrfOf(page.body), level });
}
async function launch(b, level) {
  const t0 = Date.now();
  const r = await action(b, 'launch', level);
  if (r.status !== 303) throw new Error(`launch -> ${r.status}`);
  await poll(`the ${level} instance to run`, async () => /data-state="running"/.test(await panel(b, level)), 60_000);
  return Date.now() - t0;
}
async function open(b) {
  const page = await b.get(PORTAL, '/labs/r00');
  const r = await b.form(PORTAL, '/labs/r00/open', { _csrf: csrfOf(page.body) });
  if (r.status !== 303) throw new Error(`open -> ${r.status}`);
  const u = new URL(r.headers.location);
  if (u.protocol !== 'http:' || Number(u.port) !== HTTP_PORT || !/^i-[a-z2-7]{26}\.localhost$/.test(u.hostname)) throw new Error(`Open lab -> ${u.href}`);
  return { id: u.hostname.slice(2, -'.localhost'.length), host: u.hostname, gatePath: `${u.pathname}${u.search}` };
}
const minutesLeft = (html) => Number(/data-testid="time-left">(\d+) min left</.exec(html)?.[1] ?? NaN);
function randomInstanceId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return [...randomBytes(26)].map((b) => alphabet[b & 31]).join('');
}

const checks = [
  ['the portal answers through the tunnel stand-in; Traefik publishes no port', async () => {
    const h = await hit('GET', PORTAL, '/healthz');
    if (h.status !== 200 || JSON.parse(h.body).status !== 'ok') throw new Error(`GET /healthz -> ${h.status}`);
    const t = inspect('container', TRAEFIK);
    if (Object.keys(t.HostConfig.PortBindings ?? {}).length > 0) throw new Error(`Traefik publishes ${JSON.stringify(t.HostConfig.PortBindings)}`);
  }],
  ['three players register and sign in; hvwa_auth is host-only', async () => {
    s.alice = await player('alice_v');
    s.bob = await player('bob_v');
    s.carol = await player('carol_v');
  }],
  ['the registration limit keys on CF-Connecting-IP (5 per hour per client IP)', async () => {
    const from = (ip) => browser({ 'cf-connecting-ip': ip });
    for (let i = 1; i <= 5; i++) {
      const { r } = await register(`cf_a${i}`, from('203.0.113.9'));
      if (r.status !== 303) throw new Error(`registration ${i} from 203.0.113.9 -> ${r.status}`);
    }
    const sixth = (await register('cf_a6', from('203.0.113.9'))).r;
    if (sixth.status !== 429) throw new Error(`the 6th registration from one IP -> ${sixth.status}`);
    const other = (await register('cf_b1', from('198.51.100.4'))).r;
    if (other.status !== 303) throw new Error(`a registration from another IP -> ${other.status}`);
  }],
  ['alice launches the fixture at Templar; it becomes ready', async () => {
    s.launchMs.push(await launch(s.alice, 'templar'));
    s.a = await open(s.alice);
    return `ready in ${s.launchMs[0]} ms (instance ${s.a.id}, runtime ${RUNTIME})`;
  }],
  ['the instance container and its network are exactly spec §7', () => {
    const p = hardeningProblems(inspect('container', `hvwa-i-${s.a.id}`), inspect('network', `hvwa-i-${s.a.id}`), s.a.id, TRAEFIK, RUNTIME);
    if (p.length) throw new Error(p.join('; '));
  }],
  ['Open lab: the single-use ticket becomes a host-only hvwa_gate cookie; the lab answers; a replay is refused', async () => {
    const r = await s.alice.get(s.a.host, s.a.gatePath);
    if (r.status !== 303 || r.headers.location !== '/') throw new Error(`gate -> ${r.status} ${r.headers.location ?? ''}`);
    const line = r.setCookies.find((l) => l.startsWith('hvwa_gate=')) ?? '';
    for (const part of [/; HttpOnly/i, /; SameSite=Lax/i, /; Path=\//]) if (!part.test(line)) throw new Error(`hvwa_gate lacks ${part}: ${line}`);
    if (/domain=/i.test(line)) throw new Error('hvwa_gate has a Domain attribute');
    if (/; Secure/i.test(line)) throw new Error('hvwa_gate is Secure on a plain-http local run (the public scheme is http)');
    if (r.setCookies.some((l) => /^hvwa_(sid|auth)=/.test(l))) throw new Error('a portal cookie was set on the lab host');
    const home = await s.alice.get(s.a.host, '/');
    if (home.status !== 200 || !home.body.includes('data-testid="level">templar<')) throw new Error(`the lab -> ${home.status}`);
    if (/hvwa_(sid|auth)=/.test(JSON.parse((await s.alice.get(s.a.host, '/headers')).body).cookie ?? '')) throw new Error('portal cookies reached the lab');
    const replay = await browser().get(s.a.host, s.a.gatePath);
    if (replay.status !== 401) throw new Error(`a replayed ticket -> ${replay.status}`);
  }],
  ['the lab never sees the forward-auth secret', async () => {
    const h = JSON.parse((await s.alice.get(s.a.host, '/headers')).body);
    if ('x-hvwa-auth-secret' in h || JSON.stringify(h).includes(secrets.forward)) throw new Error('the forward-auth secret reached the lab');
  }],
  ["cross-user: no cookie, a forged cookie, and bob's own cookie on alice's host are 401", async () => {
    s.launchMs.push(await launch(s.bob, 'acolyte'));
    s.b = await open(s.bob);
    await s.bob.get(s.b.host, s.b.gatePath);
    const bobs = s.bob.jar.get(s.b.host, 'hvwa_gate');
    if (!bobs) throw new Error('bob got no gate cookie');
    const tries = [
      ['no cookie', await browser().get(s.a.host, '/')],
      ['a forged cookie', await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=v1.${s.a.id}.1.9999999999999.${'A'.repeat(43)}` } })],
      ["bob's cookie", await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=${bobs}` } })],
    ];
    for (const [what, r] of tries) {
      if (r.status !== 401) throw new Error(`${what} -> ${r.status}`);
      if (!r.body.includes(`http://${PORTAL}:${HTTP_PORT}/`)) throw new Error(`${what}: the 401 page does not link the portal`);
    }
  }],
  ["from inside alice's instance: no internet, no DNS, no portal, no warden, no proxy, no other instance, nothing from Traefik", () => {
    const c = `hvwa-i-${s.a.id}`;
    const targets = [
      ['the internet (1.1.1.1:443)', '1.1.1.1', 443],
      ['the internet (8.8.8.8:53)', '8.8.8.8', 53],
      ['the portal (edge)', ipOn(serviceContainer('portal'), 'edge'), 1337],
      ['the portal (control)', ipOn(serviceContainer('portal'), 'control'), 1337],
      ['the warden', ipOn(serviceContainer('warden'), 'control'), 8080],
      ['the write socket proxy', ipOn(serviceContainer('socket-proxy'), 'control'), 2375],
      ['the read-only socket proxy', ipOn(serviceContainer('socket-proxy-ro'), 'traefik-ro'), 2375],
      ["bob's instance", ipOn(`hvwa-i-${s.b.id}`, `hvwa-i-${s.b.id}`), 8080],
      ["Traefik's tunnel-side address", ipOn(TRAEFIK, EDGE_NETWORK), 80],
      ["Traefik's edge address", ipOn(TRAEFIK, 'edge'), 80],
      ['the tunnel stand-in', ipOn(TUNNEL, EDGE_NETWORK), 8080],
    ];
    const reached = targets.map(([what, host, port]) => [what, probe(c, host, port)]).filter(([, o]) => o !== 'blocked');
    if (reached.length) throw new Error(reached.map(([w, o]) => `${w}: ${o}`).join('; '));
    const dns = dnsProbe(c, 'example.com');
    if (dns === 'RESOLVED') throw new Error('the instance resolved example.com');
    const traefikHere = ipOn(TRAEFIK, `hvwa-i-${s.a.id}`);
    for (const port of [80, 8082]) {
      const o = probe(c, traefikHere, port);
      if (o === 'reached') throw new Error(`Traefik answers the instance on ${traefikHere}:${port} (it could reach the portal and forge CF-Connecting-IP)`);
    }
    return `${targets.length} targets blocked, DNS ${dns}, Traefik listens on nothing toward instances`;
  }],
  ["the flag: a file and a page, gone from the environment, uid 10001; bob cannot score alice's flag; alice can", async () => {
    const flag = /<pre data-testid="flag">(HVWA\{[a-z2-7]{26}\})<\/pre>/.exec((await s.alice.get(s.a.host, '/flag')).body)?.[1];
    if (!flag) throw new Error('no flag on /flag');
    const info = JSON.parse((await s.alice.get(s.a.host, '/env')).body);
    if (info.flagInEnv !== false || info.uid !== 10001) throw new Error(`/env says ${JSON.stringify(info)}`);
    if (must('docker', ['exec', `hvwa-i-${s.a.id}`, 'cat', '/tmp/hvwa/flag.txt']) !== flag) throw new Error('the flag file differs');
    const submit = async (b, f) => {
      const page = await b.get(PORTAL, '/labs/r00');
      return (await b.form(PORTAL, '/labs/r00/submit', { _csrf: csrfOf(page.body), submission: f }, { 'hx-request': 'true' })).body;
    };
    if (!(await submit(s.bob, flag)).includes('data-result="wrong"')) throw new Error("bob scored alice's flag");
    if (!(await submit(s.alice, flag)).includes('data-result="new_best"')) throw new Error('alice could not score her own flag');
  }],
  ['the socket proxies: only containers and networks; the read-only one refuses writes', () => {
    const w = serviceContainer('warden');
    const status = (path, method) => Number(must('docker', ['exec', w, 'node', '-e',
      `fetch('http://socket-proxy:2375${path}',{method:'${method}'}).then(r=>console.log(r.status),()=>console.log(0))`]));
    const table = [['/v1.44/containers/json', 'GET', 200], ['/v1.44/networks', 'GET', 200], ['/v1.44/images/json', 'GET', 403],
      ['/v1.44/volumes', 'GET', 403], ['/v1.44/info', 'GET', 403], ['/v1.44/swarm', 'GET', 403], ['/v1.44/exec/x/start', 'POST', 403],
      ['/v1.44/build', 'POST', 403]];
    const wrong = table.map(([p, m, want]) => [p, m, want, status(p, m)]).filter(([, , want, got]) => got !== want);
    if (wrong.length) throw new Error(wrong.map(([p, m, want, got]) => `${m} ${p}: ${got}, want ${want}`).join('; '));
    const post = run('docker', ['exec', TRAEFIK, 'wget', '-q', '-O', '-', '--post-data=', 'http://socket-proxy-ro:2375/v1.44/containers/create']);
    if (post.code === 0 || !/403/.test(post.err)) throw new Error(`the read-only proxy accepted a POST (${show(post)})`);
    const read = run('docker', ['exec', TRAEFIK, 'wget', '-q', '-O', '/dev/null', 'http://socket-proxy-ro:2375/v1.44/containers/json']);
    if (read.code !== 0) throw new Error(`the read-only proxy refused a read (${show(read)})`);
  }],
  ['a full range (capacity 2) queues carol at position 1; she starts when bob stops; bob leaves nothing behind', async () => {
    await action(s.carol, 'launch', 'acolyte');
    const queued = await panel(s.carol, 'acolyte');
    if (!/data-state="queued"/.test(queued) || !/Position 1 in the queue/.test(queued)) throw new Error('carol is not queued at position 1');
    await action(s.bob, 'stop', 'acolyte');
    await poll('carol to run', async () => /data-state="running"/.test(await panel(s.carol, 'acolyte')), 60_000);
    s.c = await open(s.carol);
    if (exists('container', `hvwa-i-${s.b.id}`) || exists('network', `hvwa-i-${s.b.id}`)) throw new Error("bob's container or network is still there");
  }],
  ['Extend adds 30 minutes', async () => {
    const before = minutesLeft(await panel(s.alice, 'templar'));
    await action(s.alice, 'extend', 'templar');
    const after = minutesLeft(await panel(s.alice, 'templar'));
    // 29 when a minute boundary passes between the two reads.
    if (after - before < 29 || after - before > 30) throw new Error(`time left ${before} -> ${after}`);
  }],
  ['the reaper reports a crashed instance as failed (crashed)', async () => {
    must('docker', ['kill', `hvwa-i-${s.c.id}`]);
    await poll("carol's panel to show the crash", async () => /data-reason="crashed"/.test(await panel(s.carol, 'acolyte')), 90_000, 2000);
  }],
  ['the portal removes an orphan container when it starts (reconcile)', async () => {
    const id = randomInstanceId();
    must('docker', ['run', '-d', '--name', `hvwa-i-${id}`, '--label', 'hvwa.range=1', '--label', `hvwa.instance=${id}`,
      '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', FIXTURE_TAG]);
    const r = compose(['restart', 'portal'], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`restart portal: ${show(r)}`);
    await poll('the orphan to be removed', async () => !exists('container', `hvwa-i-${id}`), 90_000, 1000);
  }],
  ["Stop removes alice's container, its network and Traefik's endpoint; the host stops answering", async () => {
    await action(s.alice, 'stop', 'templar');
    await poll("alice's container to go", async () => !exists('container', `hvwa-i-${s.a.id}`), 30_000);
    if (exists('network', `hvwa-i-${s.a.id}`)) throw new Error("alice's network is still there");
    if (Object.keys(inspect('container', TRAEFIK).NetworkSettings.Networks).includes(`hvwa-i-${s.a.id}`)) throw new Error('Traefik is still attached');
    const after = await hit('GET', s.a.host, '/', { headers: { cookie: `hvwa_gate=${s.alice.jar.get(s.a.host, 'hvwa_gate')}` } });
    if (after.status === 200) throw new Error('the stopped lab still answers');
  }],
];

// ------------------------------------------------------------------------------------------------ run
let tmp = '';
let started = false;

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function removeOwnLeftovers() {
  run('docker', ['rm', '-f', TUNNEL]);
  compose(['down', '-v'], { timeoutMs: 180_000 });
  run('docker', ['network', 'rm', EDGE_NETWORK]);
}

async function preflight() {
  must('docker', ['version', '--format', '{{.Server.Version}}']);
  removeOwnLeftovers(); // of an interrupted run of THIS script only (its project, forwarder and network names)
  const ranges = run('docker', ['ps', '-aq', '--filter', 'label=hvwa.range=1']).out;
  const nets = run('docker', ['network', 'ls', '-q', '--filter', 'name=hvwa-i-']).out;
  if (ranges || nets) {
    throw new Error('BLOCKED: hvwa.range=1 containers or hvwa-i-* networks already exist on this engine (another range?); '
      + 'refusing to start (nothing was changed)');
  }
  if (!(await portFree(HTTP_PORT))) throw new Error(`BLOCKED: 127.0.0.1:${HTTP_PORT} is in use (set HVWA_VERIFY_HTTP_PORT)`);
}

async function main() {
  await preflight();
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  say(`building the range images (${version}) and the fixture lab`);
  env = { ...process.env, ...PARSE_ENV, HVWA_RANGE_VERSION: version };
  must(process.execPath, [join(root, 'scripts', 'range-images.mjs'), 'build'], { inherit: true, timeoutMs: 1_800_000 });
  must('docker', ['build', '-t', FIXTURE_TAG, join(root, 'labs', '_fixture')], { inherit: true, timeoutMs: 900_000 });
  const fixtureId = must('docker', ['image', 'inspect', '--format', '{{.Id}}', FIXTURE_TAG]);
  tmp = mkdtempSync(join(tmpdir(), 'hvwa-range-verify-'));
  const registry = join(tmp, 'registry.json');
  const lab = JSON.parse(readFileSync(join(root, 'labs', '_fixture', 'lab.json'), 'utf8'));
  writeFileSync(registry, JSON.stringify({ schema: 1, labs: [{ ...lab, version: '0.0.0', image: fixtureId }] }));
  secrets.admin = randomBytes(12).toString('base64url');
  secrets.warden = randomBytes(32).toString('hex');
  secrets.forward = randomBytes(32).toString('hex');
  // Local mode (PARSE_ENV already names the edge network, the Traefik container and HVWA_RANGE_DOMAIN=localhost).
  env = {
    ...process.env, ...PARSE_ENV, HVWA_RANGE_VERSION: version,
    HVWA_PORTAL_HOST: PORTAL, HVWA_RANGE_PUBLIC_SCHEME: 'http', HVWA_RANGE_PUBLIC_PORT: String(HTTP_PORT),
    HVWA_ADMIN_PASSWORD: secrets.admin, HVWA_WARDEN_SECRET: secrets.warden, HVWA_FORWARD_AUTH_SECRET: secrets.forward,
    HVWA_RANGE_KEY: '', HVWA_RANGE_CAPACITY: '2', HVWA_REGISTRATION_CODE: '', HVWA_LAB_REGISTRY_FILE: registry,
    HVWA_RANGE_RUNTIME: RUNTIME, FLAG_SECRET: '',
  };
  started = true;
  must('docker', ['network', 'create', EDGE_NETWORK]); // stands in for the owner's hvwa-edge
  say(`starting: docker compose -f docker-compose.range.yml -p ${PROJECT} up -d --wait`);
  const up = compose(['up', '-d', '--wait', '--wait-timeout', '240'], { inherit: true, timeoutMs: 900_000 });
  if (up.code !== 0) throw new Error(`docker compose up failed (exit ${up.code})`);
  // The tunnel stand-in: what cloudflared does on the server (a plain TCP hop to traefik:80), on loopback only.
  const forwarder = "const n=require('node:net');n.createServer((c)=>{const u=n.connect(80,'traefik');c.pipe(u).pipe(c);"
    + "c.on('error',()=>u.destroy());u.on('error',()=>c.destroy())}).listen(8080)";
  must('docker', ['run', '-d', '--name', TUNNEL, '--network', EDGE_NETWORK, '-p', `127.0.0.1:${HTTP_PORT}:8080`, '--read-only',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', `sigmajo/hvwa:range-portal-${version}`, 'node', '-e', forwarder]);
  await poll('the portal through the tunnel stand-in', async () => (await hit('GET', PORTAL, '/healthz')).status === 200, 60_000);

  for (const [name, fn] of checks) {
    try {
      const detail = await fn();
      say(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      say(`FAIL ${name} — ${err.message}`);
      const logs = compose(['logs', '--no-color', '--tail', '60']);
      console.error(logs.out || logs.err);
      throw new Error(`stopped at: ${name}`);
    }
  }
  say(`launch to ready: ${s.launchMs.join(' ms, ')} ms`);
  return checks.length;
}

function cleanup() {
  if (!started && !tmp) return;
  say(`stopping: the forwarder, docker compose -p ${PROJECT} down -v, the edge network, and every hvwa-i-* this run made`);
  try {
    removeOwnLeftovers();
    const left = run('docker', ['ps', '-aq', '--filter', 'label=hvwa.range=1']).out.split(/\s+/).filter(Boolean);
    if (left.length) run('docker', ['rm', '-f', ...left]);
    const nets = run('docker', ['network', 'ls', '-q', '--filter', 'name=hvwa-i-']).out.split(/\s+/).filter(Boolean);
    if (nets.length) run('docker', ['network', 'rm', ...nets]);
    run('docker', ['network', 'rm', EDGE_NETWORK]); // again: it is free only once every hvwa-i-* endpoint is gone
    run('docker', ['image', 'rm', FIXTURE_TAG]);
  } catch (err) {
    say(`cleanup: ${err.message}`);
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  started = false;
  tmp = '';
}

if (isMainModule(process.argv[1], import.meta.url)) {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => { say(`${signal}: interrupted, cleaning up`); cleanup(); process.exit(code); });
  }
  main().then(
    (n) => { cleanup(); say(`OK — all ${n} checks passed: the range holds (spec §11)`); },
    (err) => { cleanup(); console.error(`range:verify FAILED: ${err.message}`); process.exitCode = 1; },
  );
}
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-verify.spec.ts`
Expected: PASS.

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. Expected: all green (the script itself runs against Docker in Task 29).

```bash
git add scripts/range-verify.mjs tests/range-verify.spec.ts
git commit -m "feat(range): range:verify, the spec §11 security checks against a local range behind a tunnel stand-in"
```

---

## Part 5 — Images (spec §12: build and push) and the final gate

The range images come last in the build order: Tasks 25–27 only check them as text (compose, range-verify), and `range-verify` builds them itself when it runs in Task 29.

### Task 28: Images: `Dockerfile.range` (`range-portal`, `range-warden`), `npm run range:build` / `range:push`

**Files:**
- Create: `Dockerfile.range`, `scripts/range-images.mjs`
- Modify: `package.json` (scripts), `.dockerignore`
- Test: `tests/range-images.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/range-images.spec.ts`:

```ts
// The range images (spec range §12): Dockerfile.range builds `range-portal` and `range-warden` from one compile; the tags
// are sigmajo/hvwa:range-<name>-<version>; range:build / range:push / range:verify are scripts outside `npm test`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RANGE_REPO, RANGE_TARGETS, rangeTags, rangeVersion } from '../scripts/range-images.mjs';

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), 'utf8').replace(/\r\n/g, '\n');
const stage = (df: string, name: string) => {
  const at = df.indexOf(` AS ${name}\n`);
  if (at < 0) throw new Error(`no stage ${name}`);
  const next = df.indexOf('\nFROM ', at);
  return df.slice(at, next < 0 ? undefined : next).split('\n');
};

describe('scripts/range-images.mjs', () => {
  it('tags sigmajo/hvwa:range-portal-<version> and range-warden-<version>', () => {
    expect(RANGE_REPO).toBe('sigmajo/hvwa');
    expect(RANGE_TARGETS).toEqual(['range-portal', 'range-warden']);
    expect(rangeTags('0.1.0')).toEqual([
      { target: 'range-portal', tag: 'sigmajo/hvwa:range-portal-0.1.0' },
      { target: 'range-warden', tag: 'sigmajo/hvwa:range-warden-0.1.0' },
    ]);
  });

  it('the version is HVWA_RANGE_VERSION, else package.json\'s; it must be x.y.z', () => {
    expect(rangeVersion({}, { version: '0.1.0' })).toBe('0.1.0');
    expect(rangeVersion({ HVWA_RANGE_VERSION: ' 1.2.3 ' }, { version: '0.1.0' })).toBe('1.2.3');
    expect(() => rangeVersion({ HVWA_RANGE_VERSION: 'latest' }, { version: '0.1.0' })).toThrow(/x\.y\.z/);
  });

  it('package.json has range:build, range:push and range:verify; none of them is part of npm test', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['range:build']).toBe('node scripts/range-images.mjs build');
    expect(scripts['range:push']).toBe('node scripts/range-images.mjs push');
    expect(scripts['range:verify']).toBe('node scripts/range-verify.mjs');
    expect(scripts.test).toBe('vitest run');
  });
});

describe('Dockerfile.range', () => {
  const df = read('Dockerfile.range');

  it('one compile, a production-only base without package managers, then two non-root targets', () => {
    expect(df).toContain('ARG NODE_IMAGE=node:22.23.5-alpine3.24\n');
    expect(df).toContain('RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \\\n');
    expect(df).toContain('/usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack');
    const warden = stage(df, 'range-warden');
    expect(warden).toEqual(expect.arrayContaining(['USER node', 'CMD ["node", "dist/warden/main.js"]', 'EXPOSE 8080']));
    const portal = stage(df, 'range-portal');
    expect(portal).toEqual(expect.arrayContaining(['USER node', 'CMD ["node", "dist/server.js"]', 'EXPOSE 1337',
      'RUN mkdir -p /data && chown node:node /data']));
    expect(portal.join('\n')).toContain('HVWA_MODE=portal');
    expect(portal.join('\n')).toContain('HVWA_ALLOW_REMOTE=1');
    expect(df).not.toMatch(/COPY\s+labs/);
    expect(df).not.toMatch(/docker\.sock/);
  });

  it('the build context leaves out the lab packages and the range Dockerfile itself', () => {
    const ignore = read('.dockerignore').split('\n');
    expect(ignore).toEqual(expect.arrayContaining(['labs', 'Dockerfile.range']));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/range-images.spec.ts`
Expected: FAIL — `scripts/range-images.mjs` and `Dockerfile.range` do not exist.

- [ ] **Step 3: Implement**

Create `Dockerfile.range`:

```dockerfile
# HVWA Range images (spec docs/superpowers/specs/2026-11-20-hvwa-range-design.md §12): the portal and the warden, as tags
# of sigmajo/hvwa. Run them ONLY through docker-compose.range.yml (internal networks, socket proxies, Traefik).
#   docker build -f Dockerfile.range --target range-portal -t sigmajo/hvwa:range-portal-<version> .
#   docker build -f Dockerfile.range --target range-warden -t sigmajo/hvwa:range-warden-<version> .
# `npm run range:build` does both (scripts/range-images.mjs). The standalone images (Dockerfile) are unchanged.
ARG NODE_IMAGE=node:22.23.5-alpine3.24

# --- build: full deps + TypeScript, emits dist/ (server, range portal, warden, views)
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/clean-dist.mjs scripts/copy-assets.mjs scripts/main-module.mjs ./scripts/
COPY src ./src
RUN npm run build

# --- range-base: production deps only, no package managers, the compiled app
FROM ${NODE_IMAGE} AS range-base
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && rm -rf /root/.npm /tmp/* \
    /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*
COPY --from=build /src/dist ./dist

# --- range-warden: the only component that creates lab containers (through the socket proxy, over TCP)
FROM range-base AS range-warden
ENV HOST=0.0.0.0 \
    PORT=8080
LABEL org.opencontainers.image.title="HVWA Range warden" \
      org.opencontainers.image.description="Creates and removes HVWA range lab containers through a docker-socket-proxy. Run it only with docker-compose.range.yml." \
      org.opencontainers.image.licenses="MIT"
USER node
EXPOSE 8080
CMD ["node", "dist/warden/main.js"]

# --- range-portal: accounts, catalog, instances, gate and forward-auth (HVWA_MODE=portal). Mounts no labs.
FROM range-base AS range-portal
RUN mkdir -p /data && chown node:node /data
ENV HOST=0.0.0.0 \
    PORT=1337 \
    HVWA_ALLOW_REMOTE=1 \
    HVWA_DATA_DIR=/data \
    HVWA_MODE=portal
LABEL org.opencontainers.image.title="HVWA Range portal" \
      org.opencontainers.image.description="The HVWA range portal (accounts, catalog, per-user lab instances). Run it only with docker-compose.range.yml." \
      org.opencontainers.image.licenses="MIT"
USER node
EXPOSE 1337
CMD ["node", "dist/server.js"]
```

Create `scripts/range-images.mjs`:

```js
// scripts/range-images.mjs — `npm run range:build` / `npm run range:push` (NOT part of `npm test`; needs Docker).
//   build: Dockerfile.range's range-portal and range-warden targets, tagged sigmajo/hvwa:range-<name>-<version>
//          (version: HVWA_RANGE_VERSION, else package.json's), and prints each local image id.
//   push:  pushes both tags and prints each pushed digest (repo@sha256:...), the values that pin them.
// PUSH IS MANUAL: only the controller runs it, after Task 29 passed, with `docker login` done by the owner.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './main-module.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RANGE_REPO = 'sigmajo/hvwa';
export const RANGE_TARGETS = Object.freeze(['range-portal', 'range-warden']);

/** HVWA_RANGE_VERSION (trimmed), else package.json's version; x.y.z only. */
export function rangeVersion(env, pkg) {
  const v = (env.HVWA_RANGE_VERSION ?? '').trim() || pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`the range version must be x.y.z (got "${v}")`);
  return v;
}

export function rangeTags(version) {
  return RANGE_TARGETS.map((target) => ({ target, tag: `${RANGE_REPO}:${target}-${version}` }));
}

function docker(args, capture = false) {
  const r = spawnSync('docker', args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed (exit ${r.status})${capture ? `: ${(r.stderr ?? '').trim()}` : ''}`);
  return (r.stdout ?? '').trim();
}

export function main(argv, env) {
  const version = rangeVersion(env, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  if (argv[0] === 'build') {
    for (const { target, tag } of rangeTags(version)) {
      docker(['build', '-f', 'Dockerfile.range', '--target', target, '-t', tag, '.']);
      console.log(`range:build ${tag} ${docker(['image', 'inspect', '--format', '{{.Id}}', tag], true)}`);
    }
    return 0;
  }
  if (argv[0] === 'push') {
    for (const { tag } of rangeTags(version)) {
      docker(['push', tag]);
      const digests = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag], true));
      console.log(`range:push ${tag} ${digests.filter((d) => d.startsWith(`${RANGE_REPO}@`)).join(' ')}`);
    }
    return 0;
  }
  console.error('usage: node scripts/range-images.mjs build|push');
  return 2;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(`range-images: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
```

In `package.json` `scripts`, add after `"verify:docker"`:

```json
    "range:build": "node scripts/range-images.mjs build",
    "range:push": "node scripts/range-images.mjs push",
    "range:verify": "node scripts/range-verify.mjs",
```

In `.dockerignore`, add after the `Dockerfile` line:

```
Dockerfile.range
# Lab packages build their own images (their own context); the portal and warden images never contain them.
labs
```

- [ ] **Step 4: Run the test to see it pass**

Run: `npx vitest run tests/range-images.spec.ts tests/docker-files.spec.ts tests/copy-assets.spec.ts`
Expected: PASS (`tests/docker-files.spec.ts` still passes: the standalone `Dockerfile` is untouched and the new `.dockerignore` lines re-include nothing).

- [ ] **Step 5: Full gates and commit**

Run: `npx vitest run` then `npm run typecheck`. If Docker is running, also `npm run range:build` once (expected: two `range:build sigmajo/hvwa:range-...-0.1.0 sha256:...` lines). Expected: all green.

```bash
git add Dockerfile.range scripts/range-images.mjs package.json .dockerignore tests/range-images.spec.ts
git commit -m "feat(range): range-portal and range-warden image targets; range:build and range:push"
```

---

### Task 29: Final gate

**Files:** none new (fixes only, if a gate fails).

- [ ] **Step 1: Unit and type gates** (from `C:\Users\Sahuagin\Documents\hvwa`, capital `C:`)

Run: `npx vitest run`
Expected: every spec passes (the pre-range suite plus the 26 new specs).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 2: The production build, full and lite (standalone is unchanged)**

Run: `npm run verify:dist`
Expected: last line `verify:dist OK — the production build boots and serves`.

Run (PowerShell): `$env:HVWA_EDITION='lite'; npm run verify:dist; Remove-Item Env:HVWA_EDITION`
Expected: the same last line, with `server registered 5 challenge(s) (edition lite)` above it.

- [ ] **Step 3: Pull the pinned third-party images**

Run: `docker pull traefik:v3.7.19` and `docker pull tecnativa/docker-socket-proxy:v0.5.0`
Expected: both succeed. If a tag no longer exists, take the newest patch of the same minor (`traefik:v3.7.x`) or the newest `tecnativa/docker-socket-proxy:v0.x.y`, and change it in `docker-compose.range.yml`, `tests/range-compose.spec.ts` and this plan's ground rules. (`cloudflare/cloudflared` is not pulled here: it runs in the owner's own bootstrap compose.)

- [ ] **Step 4: The local range end to end**

Make sure Docker Desktop (or Docker Engine 28+) is running and nothing listens on 127.0.0.1:18080 (or set `HVWA_VERIFY_HTTP_PORT`). The script refuses to start beside any existing `hvwa.range=1` container or `hvwa-i-*` network, and touches only its own project (`hvwa-range-verify`), its own network (`hvwa-range-verify-edge`), its forwarder (`hvwa-range-verify-tunnel`) and the `hvwa-i-*` resources it creates. Never stop, remove or prune any other container, network or compose project on this machine.

Run: `npm run range:verify`
Expected: one `PASS` line per check (16), then `range:verify launch to ready: <a> ms, <b> ms` (each well under 5000 ms on a warm engine) and `range:verify OK — all 16 checks passed: the range holds (spec §11)`. The script cleans up after itself; afterwards `docker ps -a --filter label=hvwa.range=1`, `docker network ls --filter name=hvwa-i-` and `docker network ls --filter name=hvwa-range-verify` are empty.

Two of the checks are the only end-to-end proof of the router's address binding (plan D3): the first (the portal answers through the forwarder, so the `getent hosts traefik` wrapper bound the `web` entrypoint to the `hvwa-edge` address) and the isolation check (Traefik's address on the instance network refuses ports 80 and 8082). If the router exits instead, apply Task 26's implementer note (the `nslookup` fallback; never `0.0.0.0`).

On a Linux host with gVisor registered as the `runsc` runtime (the POC host), run `HVWA_VERIFY_RUNTIME=runsc npm run range:verify` as well: the same 16 checks, with `HostConfig.Runtime` checked as `runsc`. Docker Desktop has no `runsc`; there the default (`runc`) run is the gate.

If a check fails: read the printed logs, fix the cause in the task that owns it (with a failing unit test first when the bug is reproducible without Docker), rerun Steps 1–4.

- [ ] **Step 5: Record and stop**

Do NOT run `npm run range:push`: pushing is the controller's manual step after review, with `docker login` done by the owner. Commit only if Steps 1–4 required fixes:

```bash
git add <the files the fixes touched>
git commit -m "fix(range): <what the final gate found>"
```

---

## Self-review

### Spec coverage

| Spec | Requirement | Task(s) |
|---|---|---|
| §1.1 | 120 users register, log in, launch, solve concurrently; p95 launch < 5 s | Platform pieces: 5, 18, 23; measured at small scale in 27/29 (launch-to-ready printed). The 120-user load test is **Plan E**. |
| §1.2 | No access to another user's instance (URL, network, copied flag) | 12 (own network), 20 (ticket bound to user+instance), 21 (forward-auth ownership), 22 (flags per user), 27 (cross-user + shared-flag checks) |
| §1.3 | Instance reaches no internet, portal, Docker API, other instance | 12 (internal + isolated network), 26 (Traefik's one entrypoint on its `hvwa-edge` address only, proxies on other networks), 27 (probes, Traefik's addresses included) |
| §1.4 / §1.5 | Labs solvable; resource measurements | **Plans B, D, E** |
| §2 | Accounts with open registration, optional code, admin can close | 3, 5, 10 |
| §2 | One active instance per user; one container per (user, challenge, level) | 7 (DB index), 12, 18 |
| §2 | Real execution inside the container; lite image unchanged | 12 (container is the boundary); standalone untouched, D8 keeps lite databases working (2) |
| §3 | Components: Traefik v3, portal mode, warden, two socket proxies; `cloudflared` outside the stack; victim bot | 9, 11–14, 26 (`cloudflared` only as a commented example, D16); victim bot and `bot` network are **Plan C** |
| §3 | Networks `hvwa-edge` (external, alias `traefik`), edge, control, traefik-ro, one per instance | 12, 26 (`bot`: Plan C) |
| §3 | default-address-pools /28 on the server | **Plan E** (`scripts/range-setup.sh`) |
| §4 | users table, roles, scrypt, CSRF/Origin/Sec-Fetch-Site/backoff/check cap kept | 2, 3, 4 (Origin against the public scheme, D19) |
| §4 | Registration rules: 3–24 `[a-z0-9_]`, unique case-insensitive, ≥ 10, 5/h/IP, code, admin toggle | 3 (rules), 5 (route, limit on `clientIp`, code, toggle), 10 (admin), 27 (the limit through Traefik) |
| §4 | First admin from `HVWA_ADMIN_PASSWORD`, required in portal mode, scrubbed | 1 (required ≥ 10), 24 (scrubbed) |
| §4 | Progress keyed by user id; leaderboard ranks users | 7, 9 |
| §5.1–5.3 | Launch: active account, stop previous, capacity + FIFO queue, instanceId 128-bit base32, warden create, readiness polling | 9 (ids), 18, 23 |
| §5.4 | Open lab: single-use 60 s ticket at `https://i-<id>.<domain>/__hvwa/gate` → host-only `hvwa_gate` (HMAC over instance, user, expiry; HttpOnly, SameSite=Lax, Secure behind the tunnel) → redirect | 20, 23, 24 (Secure iff `https`), 27 (attributes, no `Domain`) |
| §5.5 | Forward-auth: stateless MAC, expiry, running, owned; last-seen in memory flushed every 30 s; 401 with link | 18 (touch/flush), 19 (flush in each pass), 21 |
| §5.6 | Idle 30 min; max 2 h; Extend +30 min to 4 h; Reset new flag; Stop; level change = new instance | 18, 19, 23 |
| §5.7 | Reaper every 30 s; startup reconcile by `hvwa.range=1` | 19, 24 |
| §5 states | queued → starting → running → stopping → stopped, failed with reason shown | 7 (CHECK), 18, 23 (reasons on the panel and admin page) |
| §5 config | `HVWA_RANGE_DOMAIN`, `HVWA_PORTAL_HOST` (default the domain; its first label never `i-`/`c-`), capacity, the four minute settings, runtime, registration code | 1 (portal, D17), 14 (`HVWA_RANGE_RUNTIME` on the warden, D12), 26 |
| §6 | Flag value, per-instance; `rangeKey` portal-only; delivered as a one-shot tmpfs file, never env; hash stored; verification within 24 h of own instances; Divine without flag | 12, 15, 16, 18, 22, 25 (start hook in the fixture) |
| §7 | The exact HostConfig; digest-pinned image allowlist; labels; restart none | 6, 12, 13, 27 |
| §7 | gVisor: `runsc` required on the POC host; the warden always writes `HostConfig.Runtime` | 12 (always set), 14 (setting), 26 (compose variable), 27 (`expectedHostConfig(runtime)`, `HVWA_VERIFY_RUNTIME=runsc`), 29 |
| §7 threat model | Docker API abuse: only the warden reaches a write proxy, containers + networks only | 11, 13, 26, 27 |
| §8.4 | Manifest fields | 6 (schema; D6 adds `briefing`/`hints`) |
| §8.1–8.3, §8.5 | Lab standard, harness, uniqueness gate, bot contract, request catcher | **Plans B, C** (interfaces below) |
| §9 | Showcase catalog | **Plans B, D** |
| §10 | Catalog cards + filters + solved per level; lab page (briefing, difficulty, level points, paid hints, Lab panel, flag submit); My Lab; leaderboard; admin (users, instances, capacity/queue, registration toggle, event code); register/login pages | 5, 9, 10, 22, 23 (the request-catcher link: **Plan C**) |
| §11 | Security checks: cross-user, isolation (instance→instance/portal/socket/internet), shared flag, exact hardening, orphans reaped | 27, 29 |
| §11 | Load test and `docs/RANGE.md` | **Plan E** |
| §12 | Hostnames one level deep: portal `<domain>`, instances `i-<instanceId>.<domain>`, catcher `c-<userId>.<domain>`; locally `i-<id>.localhost` | 9 (`hosts.ts`), 12 (router rule, `HVWA_INSTANCE_HOST`), 20, 21, 23, 27; the catcher's routing: **Plan C** (name reserved, D17) |
| §12 | TLS at Cloudflare's edge; Traefik one plain-HTTP entrypoint :80, no published ports, no ACME; `hvwa-edge` external with alias `traefik`; tunnel ingress → `http://traefik:80`; no `cloudflared` in the range compose | 26 (compose + `tests/range-compose.spec.ts`), 27 (no port bindings; reachable only through the forwarder) |
| §12 | Client IP from `CF-Connecting-IP` (socket address when absent) for the registration limit and the auth backoff | 5 (`clientIp`, `signInPerIp`, D18), 27 |
| §12 | Cookies host-only: `hvwa_gate` on the instance host, portal cookies on the portal host, never `Domain=` | 4 (`cookieAttributes`), 20, 27 |
| §12 | Images `range-portal`, `range-warden` as tags of `sigmajo/hvwa` with versions; digests printed | 28 (push run manually) |
| §12 | `docker-compose.range.yml`; local mode `HVWA_RANGE_DOMAIN=localhost` | 26, 27 |
| §12 | `labs/registry.json` pins by digest | 6 (format); filling it: **Plans B/E** (`range:build-labs`) |
| §13 steps 1–4 | Build order | Parts 1–4 follow it; images (the build half of §12) are Part 5 |

### Placeholder scan

Searched the plan for "TBD", "TODO", "implement later", "add validation", "handle edge cases", "similar to Task" and for code steps without code: none (the only hits are the catalog filter value `todo` in Task 9's code). Every modification step names the exact file and shows the exact lines; the places that depend on the outside world are explicit procedures, not gaps (Task 26's two implementer notes: the `nslookup` fallback if `getent` prints nothing, and a socket-proxy path that needs a tmpfs; Task 29's rule for a vanished image tag). Searched for leftovers of the pre-tunnel design (`.lab.`, `trustProxy`, `HVWA_TRUST_PROXY`, `websecure`, `certResolver`, published ports): only the assertions that they are absent remain.

### Type and name consistency

- `WardenApi`, `LaunchRequest`, `InstanceHealth`, `ListedInstance`, `WardenError`, `WARDEN_ERROR_CODES` are defined once in `src/warden/protocol.ts` (Task 11) and used unchanged by `warden.ts` (13), `server.ts` (14), `warden-client.ts` (17), `fake-warden.ts` (17), `lifecycle.ts` (18), `reaper.ts` (19).
- `INSTANCE_ID_RE`/`base32`/`newInstanceId` live in `src/range/ids.ts` (Task 9) and are imported by `protocol.ts`, `warden.ts`, `server.ts`, `hosts.ts`, `admin.ts`; `RANGE_FLAG_RE` lives in `protocol.ts` and is re-exported by `src/range/flags.ts`.
- Hosts are built in one place, `src/range/hosts.ts` (Task 9): `instanceHost(id, domain)` = `i-<id>.<domain>`, `instanceIdOfHost(hostname, domain)`, `instanceOrigin(id, domain, scheme = 'https', port?)`, `portalOrigin(portalHost, scheme = 'https', port?)` and the type `PublicScheme`. `gate.ts` (20), `forward-auth` (21) and the panel's Open lab (23) use them; `template.ts` (12) writes the same `i-<id>.<domain>` for the router rule and `HVWA_INSTANCE_HOST` (cross-checked by `tests/warden-template.spec.ts`).
- `publicScheme` flows from `loadRangeConfig` (Task 1, `HVWA_RANGE_PUBLIC_SCHEME`) through `portalAppOptions` (24) into `AuthOptions.publicScheme` (4, the Origin check) and `RangePortalOptions.publicScheme` (9, public URLs); `secureCookies` is `publicScheme === 'https'` on both.
- `RangePortalOptions` grows in order: Task 9 (domain, portalHost, publicScheme, publicPort, internalHost, registry, limits, registrationCode, secureCookies, now) → Task 18 (`warden`, `rangeKey`, `log`) → Task 21 (`forwardAuthSecret`); `tests/support/range.ts portalApp` and `src/range/options.ts portalAppOptions` (Task 24) pass every field.
- `AuthServiceOptions.passwordMinLength` (Task 3) → `AuthOptions` adds `secureCookies`, `publicScheme` (4), `registration`, `signInPerIp` (5); `clientIp(req)` lives in `src/auth/client-ip.ts` (5) and is the only reader of `CF-Connecting-IP` (used by `register.ts` and the sign-in budget in `index.ts`).
- `RangeContext` grows: Task 9 (db, auth, opts, registry, now) → 18 (`lifecycle`) → 20 (`tickets`). `RangePortal` grows: 9 (isInstanceHost, edge, locals, router) → 18 (`lifecycle`) → 19 (`start`) → 20 (`tickets`).
- `PlatformAuth` grows: Task 4 (`formOk`, `csrfFor`, `refuse`) → 5 (`settings`) → 10 (`adminRouter`); `requireAdmin` lives in `src/auth/forms.ts` and is re-exported by `src/auth/index.ts` (used by `src/auth/admin.ts` and `src/range/admin.ts`).
- `AuthSession` = `{ userId, username, role, defaultPassword }`; `res.locals.platformAuth` = `{ signedIn, userId, user, role, defaultPassword, csrf }` (types in `src/types/express.d.ts`, Task 4).
- Lifecycle methods used by the reaper (`refresh`, `stopInstance`, `fail`, `promote`, `flushLastSeen`, `store`) are all on the `Lifecycle` interface of Task 18. Store methods used later (`latestFor` in Task 23, `levelForFlag` in Task 22) are in Task 16.
- Names shared by code and config files: `hvwa-instance@file`, `hvwa-portal@file` (template.ts ↔ range.yml, cross-checked by `tests/range-compose.spec.ts`); `X-Hvwa-Auth-Secret` (range.yml ↔ gate.ts); `hvwa_gate` (`GATE_COOKIE`); the compose service `router`, its network alias `traefik` (on `hvwa-edge` only) and its container name (`HVWA_TRAEFIK_CONTAINER`, compose ↔ warden ↔ range-verify); `HVWA_EDGE_NETWORK` (compose ↔ range-verify); `RUNTIMES`/`Runtime` (template.ts ↔ warden config ↔ `expectedHostConfig(runtime)` in range-verify, cross-checked by `tests/range-verify.spec.ts` for both runtimes).
- View data never uses a reserved key (`level` is passed as `currentLevel`/`panel.level`; `portalNav` and `myLab` come only from `res.locals`).

### Residual risks noted for the reviewers

- `CF-Connecting-IP` is trusted because Traefik is reachable only from `cloudflared` (no published ports; its entrypoint listens on its `hvwa-edge` address). Anything else the owner attaches to `hvwa-edge` can set that header and so choose its own client IP for the registration limit and the sign-in budget; the per-account backoff does not depend on it. Keep `hvwa-edge` for the tunnel alone.
- Traefik is the one range container with a non-internal network (`hvwa-edge`, the owner's, which also gives `cloudflared` its egress), so Traefik has egress; it runs read-only, without capabilities, and reads Docker only through the read-only proxy. The portal, warden and proxies are on internal networks only.
- Instance hosts share the registrable domain with the portal (`i-<id>.hvwa.my.id` and `hvwa.my.id`), so a lab page can set a cookie for the parent domain (cookie tossing) or send same-site requests. Portal forms already refuse `Sec-Fetch-Site: same-site` and foreign Origins, and every platform cookie is host-only; tossing only reaches the instance's own owner (forward-auth keeps everyone else out). Renaming the portal cookies to `__Host-` would close it fully; it is left out because it renames the standalone cookie too.
- The flag is never in the environment, the image, the container configuration, `docker inspect` output or any log: it is written by the warden as a one-shot file (a tiny exec, after start) and read-and-unlinked by the lab's start hook. (An earlier revision passed it as `HVWA_FLAG`; that was removed during hardening.)
- The address binding of Traefik's entrypoint (D3) is proven only by `range:verify` on a real engine (Task 29 Step 4), not by unit tests.

## Interfaces for Plans B–E

**Lab manifest (`labs/<id>-<slug>/lab.json`)**, validated by `labManifestSchema` in `src/lab-registry.ts` (`.strict()`: unknown keys are errors):

| Field | Type | Read by |
|---|---|---|
| `id` | `r00`–`r99` (`r00` = fixture) | warden (registry key, label `hvwa.lab`), portal |
| `slug` | kebab-case, ≤ 40 | portal, image tag `lab-<slug>`, Plan B uniqueness gate |
| `title`, `scenario`, `briefing` | `{ en, id }`, ≤ 600 each | portal (catalog, lab page) |
| `app`, `category`, `themeId` | strings | portal; Plan B uniqueness gate (`app`, `scenario`, `themeId`) |
| `difficulty` | `easy` \| `medium` \| `hard` \| `expert` (100/200/300/400) | portal scoring |
| `levels` | unique subset of the four, ≥ 1 exploitable | warden (refuses other levels), portal |
| `port` | 1024–65535 | warden (`HVWA_PORT`, Traefik service port) |
| `health` | absolute path | the image's `HEALTHCHECK` (the warden reads Docker's health status) |
| `flag.placement` | `file:<path>` \| `db:<table>.<column>` \| `env-only` \| `custom` | the lab's start hook; Plan B harness |
| `resources` | `{ memoryMiB ≤ 256, pids ≤ 128, cpus ≤ 0.5 }`, optional | warden (only lowers the defaults) |
| `tmpfs` | `[{ path, sizeMiB }]`, total ≤ 64 MiB, default `[{ "/tmp", 64 }]` | warden (the only writable paths, `noexec,nosuid,nodev`) |
| `needsBot` | boolean | Plan C |
| `hints` | `[{ id: 1\|2\|3, cost, text: { en, id } }]`, ≤ 3 | portal (paid hints) |

**Registry (`labs/registry.json`)**, validated by `parseRegistry`/`loadRegistry`; mounted read-only at `/etc/hvwa/registry.json` into the portal and the warden (`HVWA_LAB_REGISTRY_FILE` on the host, default `./labs/registry.json`):

```json
{ "schema": 1, "labs": [ { "...every lab.json field...": "...", "version": "1.0.0",
  "image": "sigmajo/hvwa:lab-mercy-clinic-1.0.0@sha256:<64 hex>" } ] }
```

`image` must be `<repo>[:<tag>]@sha256:<64 hex>` (pulled images) or `sha256:<64 hex>` (a local image id). The warden runs nothing else; it never pulls (its proxy has `IMAGES=0`), so every listed image must already be on the engine (Plan E's deployment pulls them by digest). Duplicate ids or slugs are refused.

**What an instance receives** (fixed in `src/warden/template.ts`):
- Environment: `HVWA_LEVEL` (`acolyte`|`templar`|`inquisitor`|`divine`), `HVWA_PORT` (the manifest's), `HVWA_INSTANCE_HOST` (`i-<instanceId>.<domain>`, e.g. `i-<id>.hvwa.my.id`, locally `i-<id>.localhost`; for absolute links and cookies, which must stay host-only), `HOME=/tmp`, and the non-secret `HVWA_FLAG_FILE=/tmp/.hvwa-flag`. The flag itself is **never** an env var: below Divine only, the warden writes it after start (a tiny exec) as a one-shot file at that path. Reserved for Plan C (added to the template there, nothing else): `HVWA_CATCHER_HOST` (`c-<userId>.<domain>`) and `HVWA_BOT_URL`.
- The browser reaches the lab at `https://i-<id>.<domain>/` (TLS ends at Cloudflare; the lab itself serves plain HTTP on `HVWA_PORT` and sees `X-Forwarded-Proto: http` from Traefik, so a lab that builds absolute URLs uses `https://` + `HVWA_INSTANCE_HOST` in production and must not rely on the request's scheme).
- Process: uid:gid `10001:10001`, read-only rootfs, only the manifest's tmpfs writable (noexec), no capabilities, `no-new-privileges`, Docker's default seccomp, 128 PIDs / 256 MiB (no swap) / 0.5 CPU unless the manifest lowers them, its own internal network with Traefik as the only peer (listening on nothing there), no egress, no DNS beyond itself, restart policy none, runtime `runc` or `runsc` (`runsc` on the POC host: a lab must run under gVisor).
- Labels set by the warden (an image must not rely on its own Traefik labels): `hvwa.range=1`, `hvwa.instance`, `hvwa.user`, `hvwa.lab`, `hvwa.level`, `hvwa.expires`, and the routers `i-<id>` (the lab, through `hvwa-instance@file`) and `g-<id>` (`/__hvwa/*` to the portal, priority 1000). Paths under `/__hvwa/` on a lab host belong to the platform.

**Start-hook contract** (what `labs/_fixture/app/server.mjs` shows): below Divine, poll `HVWA_FLAG_FILE` (`/tmp/.hvwa-flag`) for up to ~10 s, read the flag once and unlink it, then plant it where `flag.placement` says before serving; if the file never appears, exit non-zero (the health check fails rather than serving without a flag). At Divine, skip the file and plant a decoy that says it is the secure reference. Never log the flag or the file contents; listen on `0.0.0.0:$HVWA_PORT`; show no HVWA chrome, hints or tool commands.

**Health contract:** the image declares `HEALTHCHECK` that requests the manifest's `health` path on `127.0.0.1:$HVWA_PORT` and exits 0 on a 2xx (the fixture's `health.mjs`). The warden keeps the image's test (`Healthcheck.Test: []`) and sets Interval 2 s, Timeout 2 s, Retries 3, StartPeriod 60 s, StartInterval 0.5 s. `ready` = Docker reports `healthy`; `starting`; `failed` with `unhealthy` / `no_healthcheck` / `exited` / `oom`; `missing`. The portal fails a start that is not ready within 90 s (`start_timeout`).

**For Plan C (victim bot, request catcher):** add the `bot` network (internal) to `docker-compose.range.yml` with Traefik and the bot; give Traefik a `bot` entrypoint bound to its address on that network, found the same way as `web` (a network alias that exists only there, resolved by the router's wrapper), so `web` stays on the `hvwa-edge` address alone and instances still find nothing listening; route `c-<userId>.<domain>` (one level, under the tunnel's existing `*.<domain>` ingress) to the portal with a file-provider router; add the two reserved env names to the template. The portal host check (`HVWA_PORTAL_HOST` never starts with `c-`, D17) already keeps that namespace free.

**For Plan E (load test, pushes, deployment):** `npm run range:push` prints the pushed `sigmajo/hvwa@sha256:...` digests of `range-portal`/`range-warden`; lab images are pushed as `sigmajo/hvwa:lab-<slug>-<version>` and pinned in `labs/registry.json`; `scripts/range-verify.mjs`'s `register` / `launch` / `open` / `submit` flows are the load test's building blocks (behind the real tunnel they need distinct `CF-Connecting-IP` values only in local runs; through Cloudflare the edge sets it). `range-setup.sh` sets `default-address-pools` (10.200.0.0/16 in /28 blocks), checks that `runsc` is registered as a Docker runtime and that `HVWA_RANGE_RUNTIME=runsc` is set, checks that the external network `hvwa-edge` exists and that the owner's `cloudflared` is on it with the ingress `hvwa.my.id` and `*.hvwa.my.id` → `http://traefik:80`, and checks that nothing publishes ports 80/443 for the range (TLS is Cloudflare's; there is no certificate on the host).
