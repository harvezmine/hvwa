# HVWA Range — isolated per-user labs (POC design)

Date: 2026-11-20. Status: approved by the owner in conversation; this document is the binding spec for the
implementation plan.

## 1. Goal

Turn HVWA from one shared process into a **range**: every user works in their own isolated container, one per
(user, challenge, level), behind a portal that handles accounts, the catalog, scoring and instance lifecycle.
At the same time, raise the labs from single-form exercises to **realistic, unique applications**.

The POC proves the model on one Linux server with **120 concurrent users** and **10 showcase labs**.

### Success criteria

1. 120 simulated users can register, log in, launch a lab, use it and submit a flag at the same time.
   Launch time p95 is under 5 s and no request fails because of the platform.
2. No user can reach another user's instance: not through the URL, not through the network, and not with a
   flag copied from someone else.
3. An instance cannot reach the internet, the portal, the Docker API or any other instance.
4. Each of the 10 showcase labs is solvable at every exploitable level by its reference solve script. The
   Divine level resists all of them, and the exploit for each level fails at the next level up.
5. Resource use per instance is measured, and the server size needed for 120 users is documented from those
   measurements.

## 2. Owner decisions (binding)

| Topic | Decision |
|---|---|
| Priority | Focus on the POC. The Phase 2 batches (fp-b1, fp-b3, sc-b2) are parked on their branches. The Phase 3 simulation engines E5 (simNet) and E7 (graphql) are stopped, because the range runs these classes for real. |
| Accounts | Open self-registration page, then login. An optional event code (env, off by default). Admin can close registration. |
| Deployment | One Linux server with a domain: wildcard DNS `*.lab.<domain>` and HTTPS. Local development uses `*.localhost`. |
| Labs per user | One active instance per user. Launching another challenge or level stops the previous one. |
| Lab realism | Each challenge is a unique, realistic app. Exploitation needs recon and, at higher levels, chaining. Flags are hidden CTF-style. |
| Execution | Real execution inside the isolated container is allowed. This replaces "simulated execution only" for range labs. |
| Isolation unit | One container per (user, challenge, level), so a foothold at an easy level never exposes a harder level's flag. |
| POC scope | 10 new showcase labs, each with a difficulty rating and 4 levels. |
| Existing image | `sigmajo/hvwa:lite` and the standalone app stay as they are. The 45 existing labs are upgraded to the new standard later. |

## 3. Architecture

```
browser ──HTTPS──► Traefik ──┬─► hvwa.<domain>                 portal (Node, existing app in portal mode)
                             ├─► <instance>.lab.<domain>        instance container (forward-auth → portal)
                             ├─► <instance>.lab.<domain>/__hvwa/*   portal (gate ticket exchange)
                             └─► catch-<user>.lab.<domain>      portal (request catcher)

portal ──internal API──► warden ──► docker-socket-proxy (write: containers, networks; nothing else)
Traefik ──► docker-socket-proxy-ro (read-only: containers, networks)
victim-bot ──► Traefik (range hosts only)
```

### Components

| Component | Responsibility | Reachable from |
|---|---|---|
| **Traefik v3** | TLS (wildcard), routing by host, websocket pass-through, forward-auth on instance hosts. It discovers instance routes from container labels. | internet (443/80 only) |
| **Portal** (`HVWA_MODE=portal`) | Accounts, catalog, challenge pages, hints, flag verification, leaderboard, "My Lab" lifecycle UI, admin dashboard, gate and forward-auth endpoints, request catcher. Mounts no labs. | Traefik |
| **Warden** | Small Node service. It is the only component that may create or remove lab containers. API: `launch`, `stop`, `list`, `health`. The container configuration is fixed inside the warden; callers pass only `{ labId, level, instanceId, flag }`. | portal only (internal network, shared secret) |
| **docker-socket-proxy** (×2) | One write-capable proxy for the warden (containers, networks; no exec, images, volumes, swarm, system). One read-only proxy for Traefik. | warden / Traefik only |
| **Instance containers** | One lab app at one level. No platform login of its own. | Traefik only |
| **Victim bot** | Pooled headless Chromium that plays an admin or customer for client-side labs. | portal queues jobs; it reaches range hosts through Traefik only |

The existing app keeps a third mode, `HVWA_MODE=standalone` (the default), which is today's behaviour: all labs in
one process, used by the lite and full images. Nothing in standalone mode changes.

### Networks

- **`edge`**: Traefik and the portal.
- **`control`**: internal; the portal, the warden and the write socket proxy.
- **`traefik-ro`**: internal; Traefik and the read-only socket proxy.
- **`bot`**: internal; the victim bot and Traefik.
- **One network per instance**, `hvwa-i-<instance>`: internal (no egress), holding only the instance container
  and Traefik. The warden creates it, connects Traefik, starts the container, and removes all three on stop.
  The server setup script sets the Docker `default-address-pools` to `10.200.0.0/16` in `/28` blocks, which gives
  4096 networks.

## 4. Accounts and roles

- **Accounts table:** `users(id, username, password_hash, role, created_at, disabled)`, with role `player` or
  `admin`. Passwords use the existing scrypt service. The existing auth module (`src/auth`) is generalised from
  one admin to many users. The CSRF, Origin, Sec-Fetch-Site, backoff and check-cap protections stay as they are.
- **Registration (`/register`):**
  - username 3–24 characters from `[a-z0-9_]`, unique, case-insensitive;
  - password at least 10 characters;
  - rate limit per IP: 5 registrations per hour;
  - the optional `HVWA_REGISTRATION_CODE`;
  - the admin toggle "registration open".
- **First admin:** created on first start from `HVWA_ADMIN_PASSWORD`, which is required in portal mode and
  scrubbed from the environment after use, as in the lite edition.
- **Progress:** solves, hints and score are keyed by user id, not by `hvwa_sid`. The leaderboard ranks users.

## 5. Instance lifecycle

1. **Launch.** The player opens a challenge, picks a level and presses **Launch**. The portal then:
   - checks that the account is active;
   - stops the player's current instance, if any (one active per user);
   - checks global capacity. If the range is full, the player joins a FIFO queue and sees their position.
2. **Create.** The portal generates `instanceId` (128-bit random, base32, lowercase), computes the flag (§6) and
   calls the warden. The warden creates the network, then the container from the lab's pinned image digest with
   the fixed hardening (§7), then connects Traefik and starts the container. The instance's state is `starting`.
3. **Ready.** The portal polls the warden (htmx, every second) until the lab's health check passes. The state
   becomes `running`.
4. **Open.** **Open lab** opens `https://<instanceId>.lab.<domain>/__hvwa/gate?t=<ticket>` in a new tab:
   - the ticket is single-use, valid for 60 s, and bound to (user, instance);
   - the portal answers that path, sets a **host-only** cookie `hvwa_gate` for that instance host (HMAC over
     instance, user and expiry; HttpOnly, Secure, SameSite=Lax), and redirects to the lab's start page.
5. **Every request.** Traefik's forward-auth calls the portal's `/__hvwa/auth`. It checks `hvwa_gate`
   statelessly: valid MAC, not expired, the instance running and owned by that user. It records last-seen in
   memory, flushed every 30 s. Anything else gets 401 with a link back to the portal.
6. **Limits.**
   - Idle for 30 min: stop.
   - Maximum lifetime 2 h. **Extend** adds 30 min, up to 4 h in total.
   - **Reset** recreates the instance from a clean state with a new flag.
   - **Stop** removes it.
   - Changing level means a new instance.
7. **Reaper.** Every 30 s it stops expired and idle instances. On portal start it reconciles with the warden
   (`list` by label `hvwa.range=1`): unknown containers are removed, and records without a container are closed.

States: `queued → starting → running → stopping → stopped`, plus `failed` with a reason shown to the player and to
the admin.

### Configuration (env, portal)

| Variable | Default |
|---|---|
| `HVWA_RANGE_DOMAIN` | required, e.g. `example.com`; labs under `lab.<domain>` |
| `HVWA_RANGE_CAPACITY` | `140` instances |
| `HVWA_RANGE_IDLE_MIN` / `HVWA_RANGE_MAX_MIN` / `HVWA_RANGE_EXTEND_MIN` / `HVWA_RANGE_CEILING_MIN` | `30` / `120` / `30` / `240` |
| `HVWA_RANGE_RUNTIME` | `runc`; `runsc` (gVisor) when installed |
| `HVWA_REGISTRATION_CODE` | unset (open registration) |

## 6. Flags

- **Value:** `HVWA{<base32 of HMAC-SHA256(rangeKey, "flag|" + instanceId + "|" + labId + "|" + level)>[:26]}`.
  `rangeKey` lives only in the portal.
- **Delivery:** the warden passes the flag to the container as `HVWA_FLAG`. The lab's start hook plants it where
  the lab's manifest says (§8.4), then removes it from `process.env` (or the language equivalent). A foothold
  that can read the process environment only ever finds that level's own flag, which is acceptable.
- **Verification:** a submitted flag is accepted when it equals the flag of one of the **submitting user's**
  instances for that lab and level within the last 24 h. Instance records keep the flag hash, not the flag.
  A flag from another user's instance never matches.
- **Divine:** the instance is launched without a flag, and the lab plants a decoy that explains it is the secure
  reference. Divine scores nothing, as today.

## 7. Isolation and hardening

Every instance container is created with exactly this configuration, fixed in the warden:

| Setting | Value |
|---|---|
| Image | the lab's image, pinned by digest from the lab registry file; anything else is refused |
| User | non-root (uid ≥ 1000) |
| Root filesystem | read-only |
| Writable paths | tmpfs only, size-capped (64 MiB total by default, per manifest) |
| Capabilities | `cap_drop: ALL`; nothing added |
| `no-new-privileges` | true |
| seccomp | Docker default profile |
| PIDs / memory / CPU | 128 / 256 MiB (no swap) / 0.5 CPU by default; the manifest may lower them |
| Network | its own internal network; no published ports; no egress; DNS only for itself |
| Mounts | none (no volumes, no Docker socket, no host paths) |
| Labels | `hvwa.range=1`, instance id, user id, lab id, level, expiry, Traefik router labels |
| Restart policy | none (a crashed instance is reported as failed) |

The lab images also strip setuid/setgid bits. For a server shared with untrusted users, the spec recommends
`HVWA_RANGE_RUNTIME=runsc` (gVisor) as an additional kernel boundary. The warden supports it as a setting.

### Threat model (summary)

| Threat | Control |
|---|---|
| Another player opens my instance URL | Forward-auth on every request: host-only gate cookie bound to user and instance |
| Gate cookie stolen by a lab bug | Host-only and bound to one instance; it is useless elsewhere and expires with the instance |
| Instance attacks another instance, the portal or the host | Per-instance internal network; no routes out; Traefik is the only peer |
| Escape from the container | Non-root, no caps, no-new-privileges, seccomp, read-only rootfs, limits; optional gVisor |
| Resource exhaustion | PIDs, memory, CPU and tmpfs caps; global capacity; one instance per user; registration rate limit |
| Docker API abuse | Only the warden reaches a socket proxy, and only for containers and networks; the configuration is not caller-controlled |
| Flag sharing | Flags derived per instance and checked against the submitter's own instances |
| Victim bot used as a pivot | The bot sees only range hosts through Traefik; fresh browser context per job; per-user job limits |

## 8. Range Lab Standard

Every range lab (the 10 showcase labs now, the upgraded catalog later) meets all of the following.

### 8.1 A unique application

- The lab is a fictional but believable application with:
  - its own name, purpose, visual identity and seeded data;
  - at least 3 meaningful pages or API resources;
  - navigation and accounts where the scenario calls for them.
- No two labs share a scenario, an app identity or a page template.
- **Uniqueness gate:** a registry test fails on any duplicate app name, scenario or theme id.
- The lab shows no HVWA chrome, hints, endpoint lists or tool commands. All guidance lives on the portal's
  challenge page.

### 8.2 Difficulty

Every lab has two layers of difficulty:

- **A rating per challenge:** Easy, Medium, Hard or Expert. It sets the base points (100 / 200 / 300 / 400).
- **Four levels per challenge:**
  - Acolyte: no defence. Scores ×1.
  - Templar: a naive defence. Scores ×1.5.
  - Inquisitor: a strong defence that needs a bypass or a chain. Scores ×2.
  - Divine: the secure reference. Not scored.

Each level of a challenge applies the same flaw in the same feature, with a different defence. Higher ratings mean
more recon, more steps and less obvious entry points. The step-up rule from the existing project stays: the solve
for one level must fail at every level above it.

### 8.3 Real behaviour

- **Real execution.** A lab may use real interpreters, template engines, shells and parsers inside its container,
  for example the real engine of its vulnerability class.
- **Victim bot for client-side labs.** Labs that need a victim use the victim bot through a documented contract:
  the lab calls a portal-provided job endpoint with the URL to visit and the role cookie to set. Jobs run in a
  fresh browser context with a time limit.
- **Request catcher.** Data a player exfiltrates goes to their own request catcher at
  `catch-<userId>.lab.<domain>`, which is reachable by the bot and listed in the player's portal page.

### 8.4 Lab package layout and manifest

```
labs/<id>-<slug>/
  lab.json        manifest (below)
  Dockerfile      builds the lab image (stack chosen by the lab)
  app/            the application, all four levels selected by HVWA_LEVEL
  seed/           seeded data
  solve/          reference solve scripts, one per exploitable level (used only by tests, never shipped in the image)
  README.md       author notes: scenario, intended path per level, why the next level resists it
```

`lab.json` fields:
- `id`, `slug`, `title`, `app` (the fictional app's name), `category`, `difficulty`, `levels`
- `port` (the app's internal port), `health` (path)
- `flag.placement` (`file:<path>`, `db:<table>.<column>`, `env-only`, or `custom`)
- `resources` (optional lower limits), `tmpfs` (paths and sizes)
- `needsBot` (bool), `themeId`, `scenario` (one line)

### 8.5 Tests (black-box, language-agnostic)

For every lab the test harness builds the image, starts one container per level with the range's hardening, and
runs these checks:

1. the health check passes;
2. the reference solve for each exploitable level obtains that level's flag;
3. the same solve fails at every higher level;
4. Divine resists every solve;
5. a no-op browse of the app's main pages returns no flag;
6. the container has no egress.

These run with Docker. They are part of the release gate for range labs.

## 9. Showcase catalog (POC)

| # | Category | App | Rating | Stack | Flag location type |
|---|---|---|---|---|---|
| 1 | SQL injection | Mercy Clinic (patient portal) | Easy | Node + SQLite | database row |
| 2 | Broken access control (API) | Courier (parcel tracking) | Easy | Node | record in the API |
| 3 | Business logic | Relic Market (new storefront) | Easy | Node + SQLite | purchased item |
| 4 | Authentication / tokens | Pilgrim Bank (online banking) | Medium | Node | account statement |
| 5 | Stored XSS (victim bot) | Helpdesk Scriptorium (ticketing) | Medium | Node | admin panel |
| 6 | Command injection | Beacon (router admin panel) | Medium | Node + shell | file |
| 7 | File upload | Atelier (artist portfolio) | Medium | PHP | file |
| 8 | SSRF | Linkpeek (link preview service) | Hard | Node + internal service in the container | internal service |
| 9 | Template injection | Postcard (greeting card maker) | Hard | Python (Flask/Jinja2) | file |
| 10 | Insecure deserialization | Saveforge (game-save cloud) | Expert | Python | file |

Detailed level designs (the flaw, each level's defence, the intended path and why the next level resists it) are
written per lab in the implementation plan and in each lab's `README.md`, following the existing plan style.

## 10. Portal UI

The UI keeps the Sanctum design system (`docs/UI.md`).

- **Catalog:**
  - cards with category, difficulty badge, the app name and its scenario line;
  - solved state per level;
  - filters by category, difficulty and solved state.
- **Challenge page:**
  - briefing;
  - difficulty, level picker with points;
  - hints (paid);
  - the **Lab panel**: state, time left, Launch / Open lab / Reset / Extend / Stop, and the queue position when the
    range is full;
  - flag submit;
  - the player's request-catcher link when the lab needs it.
- **My Lab** in the header: the active instance with a countdown, from any page.
- **Leaderboard:** top players by score, then by time of the last solve.
- **Admin:**
  - users (disable, reset password, make admin);
  - active instances (stop);
  - capacity and queue;
  - toggle registration;
  - the event code.
- **Register and login** pages in the same style as the existing login.

## 11. Capacity and load test

- **Budget per instance:** default 256 MiB and 0.5 CPU. Each showcase lab is measured idle and under its solve.
  The measured numbers go into `docs/RANGE.md`.
- **Expected host for 120 concurrent users:** 16–24 GiB RAM and 8 vCPU. The load test confirms or corrects this.
- **Load test** (`scripts/range-load.mjs`, k6-style plain Node): N virtual users (default 120), each of which:
  1. registers and logs in;
  2. launches a random showcase lab at a random level;
  3. waits for ready, then browses its pages for 5–10 minutes;
  4. submits a wrong flag, then the right one through the reference solve;
  5. stops.

  It reports launch latency (p50/p95/p99), failures and peak host memory. It also has a ramp mode, from 0 to 120
  over 5 minutes.
- **Security checks** (`scripts/range-verify.mjs`, in the style of `verify:docker`):
  - cross-user URL access is refused;
  - instance-to-instance, instance-to-portal, instance-to-socket and instance-to-internet are all blocked;
  - a flag shared between two users is refused;
  - the container hardening flags are exact;
  - orphaned containers are reaped.

## 12. Deployment

- **`docker-compose.range.yml`:** Traefik, the portal, the warden, both socket proxies and the victim bot, with
  networks as in §3.
- **Lab images** are built by `npm run range:build-labs`, tagged `hvwa-lab/<id>:<version>`, and pinned by digest in
  `labs/registry.json`.
- **`scripts/range-setup.sh`** (Linux server):
  1. checks Docker;
  2. writes `default-address-pools`;
  3. optionally installs gVisor;
  4. prints the DNS records to create: `hvwa.<domain>`, `*.lab.<domain>`.
- **TLS** is either a Let's Encrypt wildcard via the DNS-01 challenge (needs a DNS-provider API token, e.g.
  Cloudflare) or a wildcard certificate file provided by the owner.
- **Local development:** the same compose with `HVWA_RANGE_DOMAIN=localhost` (`hvwa.localhost`,
  `*.lab.localhost`) and Traefik's self-signed certificate or plain HTTP.

## 13. Build order

1. **Portal mode and accounts:**
   - mode switch;
   - multi-user auth, register, login, roles;
   - progress keyed by user;
   - leaderboard;
   - admin users page.
2. **Warden + socket proxy:** the fixed container template, networks, launch/stop/list/health, and its own tests
   against a stub socket.
3. **Range lifecycle in the portal:** instances table, gate ticket, forward-auth, reaper, queue, Lab panel UI,
   flags (§6).
4. **Compose and Traefik:** the range stack, local `*.localhost` run, `range-verify` security checks.
5. **Lab harness:**
   - the `labs/` layout and manifest schema;
   - the black-box test runner (§8.5);
   - the uniqueness gate;
   - one pilot lab end to end (Mercy Clinic).
6. **Victim bot and request catcher.**
7. **The remaining 9 showcase labs**, in parallel batches.
8. **Load test, measurements, `docs/RANGE.md`, deployment scripts, owner deployment checklist.**

## 14. Out of scope for the POC

- Kubernetes and multi-host scheduling. The warden's interface is kept small so a Kubernetes backend can
  replace it later.
- Upgrading the 45 existing labs to the range standard.
- Teams, events with start/end times, and per-event scoreboards.
- Email verification and password reset by email. Password reset is by the admin.

## 15. Needed from the owner before deployment (not before building)

- The domain name.
- The DNS provider and an API token for the wildcard certificate, or a wildcard certificate file.
- The target server's size (RAM/CPU) for the final capacity setting.
