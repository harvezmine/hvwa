# HVWA security model

HVWA is **deliberately vulnerable**. Its labs exist to be exploited: today SQL
injection; later SSRF, XXE, deserialization and remote code execution. Anyone
who can reach HVWA can run those exploits, so the question is not *whether*
the app gets compromised but **how far a compromise can reach**. This document
describes the boundary that limits that, what it does not cover, and the rules
for running HVWA safely.

> **Never expose HVWA to an untrusted network.** /
> **Jangan pernah mengekspos HVWA ke jaringan yang tidak tepercaya.**

## Architecture

```
host 127.0.0.1:1337 --> proxy (nginx, unprivileged) --> app:1337 (node, non-root)
                        networks: edge + lab            networks: lab ONLY (internal)
```

- **app** runs the lab server. It is attached only to `lab`, a Docker network
  with `internal: true` (no default route out) and
  `com.docker.network.bridge.gateway_mode_ipv4: isolated`. `internal` alone is
  not enough: Docker still gives the host an address (`.1`) on an internal
  bridge, and the app could open connections to the host's own services
  (SSH, databases, the Docker API, dev servers). With `isolated`, the host has
  no address on `lab` at all. This needs Docker Engine 28 or newer.
- **proxy** is a thin nginx (`nginxinc/nginx-unprivileged`). Docker cannot
  publish a port from an internal-only network, so the proxy sits on both
  `lab` and `edge` and forwards every request to `app:1337`. It is transparent
  on purpose, because the labs must stay exploitable. It adds no security
  headers and filters no payloads. It forwards `Host` exactly as sent, port
  included. It never sets or rewrites `X-Real-IP` or `X-Forwarded-*`: those are
  client input that labs read. Request bodies are streamed. The one exception
  is the Host allowlist (see below). Its upstream is fixed, so it is not an
  open proxy.
- The only published port is `127.0.0.1:1337`, on loopback only.
- **docker-compose.hub.yml**, the stack for people who only pull
  `sigmajo/hvwa`, is the same two services with the same hardening. The app is
  the published image instead of a local build. The proxy has no bind mount:
  its `nginx.conf` is inline (`HVWA_NGINX_CONF`), and nginx's own shell writes
  it to the proxy's `noexec` `/tmp` tmpfs at start, so the rootfs stays
  read-only. `tests/docker-files.spec.ts` keeps it identical to
  `docker/proxy/nginx.conf` and the rest of the file in step with
  `docker-compose.yml`. Run `HVWA_COMPOSE_FILE=docker-compose.hub.yml npm run verify:docker`
  to check every row below on it.

## What the container boundary protects

| Property | How | What it stops |
|---|---|---|
| **No egress from the app** | `app` is only on the internal `lab` network with an isolated gateway: no default route, no host address on the subnet, and Docker's embedded DNS answers internal names only (external names get SERVFAIL) | SSRF and RCE payloads cannot reach the internet, your LAN, the Docker host (neither `host.docker.internal` nor any host bridge address) or cloud metadata endpoints. Data cannot be exfiltrated over HTTP or DNS, and nothing can be downloaded into the lab |
| **Loopback-only publish** | `127.0.0.1:1337:8080`; the app publishes nothing | Other machines on your Wi-Fi or LAN cannot connect |
| **Host allowlist (DNS rebinding)** | Only `Host` = `localhost`, `127.0.0.1` or `[::1]` (any port) is served. Anything else, no `Host`, or an absolute-form target naming another host gets `421 Misdirected Request`. Duplicate `Host` headers get `400`. This is enforced twice: by the proxy (a `default_server` that never forwards) and by the app itself (`src/core/host-guard.ts`, the first middleware, so `npm start` is covered too) | A malicious website you visit cannot use DNS rebinding (pointing its own hostname at `127.0.0.1`) to drive the labs through your browser |
| **Non-root** | app runs as `node` (uid 1000), proxy as `nginx` (uid 101) | A code-execution lab gives an unprivileged user, not root |
| **No privileges** | `cap_drop: [ALL]`, `no-new-privileges:true`, never `privileged`, no Docker socket mounted | Blocks privilege escalation through capabilities, setuid binaries and the Docker API |
| **Read-only root filesystem** | `read_only: true`. Writable paths are only `/tmp` (tmpfs, `noexec,nosuid,nodev`, 64 MiB) and `/data` (the named volume). The app code is root-owned, and the image has no package managers (npm, npx, yarn, corepack) | An exploit cannot modify the app's code. Anything it plants lives either in `/tmp`, which is wiped on every restart, or in `/data`, which persists until `docker compose down -v` |
| **Resource limits** | `pids_limit`, `mem_limit`, `cpus` on both services | Fork bombs and runaway payloads cannot starve your machine |
| **Init process** | `init: true` | Child processes from exploited labs are reaped, so no zombies accumulate |

`npm run verify:docker` checks every row of this table against the running
containers. It runs the egress tests from inside the app, with a positive
control so that a failure to run the probe is never counted as a pass. Run it
after changing anything Docker-related.

## What it does NOT protect

- **Other local software.** Every process on your machine can talk to
  `127.0.0.1:1337` and send `Host: localhost`. With the login on (the Docker
  image), it must know the admin password first. Local malware or a rogue browser
  extension that has it, or that rides your signed-in browser, can drive the
  labs. Websites cannot, thanks to the Host allowlist. With the login on, a
  website's blind cross-site requests (CSRF-style, without reading the responses)
  get no further than the login page: the `hvwa_auth` cookie is `SameSite=Lax`,
  so a cross-site POST, frame or fetch does not carry it. A top-level GET link
  still does. With the login off, such requests reach the labs, some of which are
  vulnerable to them by design. The blast radius is still the container, but
  **stop HVWA when you are not using it** (`docker compose down`).
- **Kernel or container-runtime escapes.** Containers share a kernel. On Docker
  Desktop that is the WSL2 or VM kernel, not your host OS directly, but a
  kernel or Docker vulnerability can still break the boundary. Keep Docker
  updated. This is a sandbox, not a VM-grade boundary.
- **The data inside the container.** Lab data, the database and the flag
  secret in `/data` are readable by anyone who exploits a lab. That is part of
  the game.
- **The proxy's own network.** The proxy needs `edge`, a normal bridge network,
  to publish its port, so the proxy container itself has egress. It only
  forwards to `app:1337`. The app can reach the proxy on `lab`, but that path
  only leads back to the app.
- **Changes to the stack.** Publishing on `0.0.0.0`, removing
  `internal: true`, adding `privileged`, capabilities, host bind mounts or the
  Docker socket voids all of the above. **`docker compose up` also loads a
  `docker-compose.override.yml` automatically.** `verify:docker` deliberately
  checks only `docker-compose.yml` (or `docker-compose.hub.yml` with
  `HVWA_COMPOSE_FILE`), so an override that weakens isolation would not be
  caught. Don't create one that does.
- **Port-forwarding tools.** Tunnels and forwarders (ngrok, cloudflared,
  Tailscale Serve/Funnel, VS Code port forwarding, `netsh interface portproxy`,
  WSL mirrored-networking tricks) can republish a loopback port to the world.
  Never point them at HVWA.
- **Test servers (`npm test`).** The test wrapper (`tests/support/supertest.ts`) starts each app's server with
  `listen(0)`, so during a test run it briefly listens on all interfaces on a random port (supertest does the same).
  The Host allowlist still applies. Run tests on a trusted network or behind a host firewall.

## The platform login

HVWA has one account, `admin`. Every page and every lab sits behind it: everything
except `/login`, `/healthz` and the static assets. It is **on** in the Docker image
(`NODE_ENV=production`) and **off** for `npm run dev` / `npm start` unless
`HVWA_AUTH=on`. It protects the loopback lab from other people and programs
on your machine, and from websites you visit. It is platform code, held to the
same standard as the Divine levels. It is never a lab:

- **Change the default password.** The account starts as `admin` / `password`
  (or `HVWA_ADMIN_PASSWORD` on first start), and every page shows a banner
  until you change it at `/account/password`. **Never reuse a real password for
  HVWA**: an exploited lab can read `/data`, including the password's hash.
- **Storage.** Only a scrypt hash is stored (N = 2^15, r = 8, p = 1, a fresh
  16-byte salt per hash) in the platform database. The password is never
  stored, logged or echoed.
- **Sessions.** Each sign-in mints a fresh random 256-bit token in a separate
  `hvwa_auth` cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age` 12 h, no
  `Domain`. It is not `Secure`, because HVWA is served over plain HTTP on
  loopback. The server keeps only the token's SHA-256. A token expires after
  12 hours, or after 2 hours unused. Signing out revokes it, and changing the
  password revokes every token. A token is accepted only from that cookie,
  never from a URL, a header or a form. The anonymous lab session
  `hvwa_sid` is never rotated: lab progress belongs to it, not to the login.
- **Forms.** Sign-in, sign-out and the password change carry a synchroniser
  token, an HMAC of `hvwa_sid`, and refuse a foreign `Origin` (an absent one
  passes). The login and password pages refuse framing (`X-Frame-Options:
  DENY`, `frame-ancestors 'none'`) and are never cached.
- **Redirects.** `/login?next=` accepts only a local path: one leading slash, no
  double slash or backslash, no scheme, no CR/LF or other control characters, and
  none of those hidden behind percent-encoding. Anything else goes to `/`, so the
  login is never an open redirect.
- **Brute force.** After 5 failures in a row, the account locks for 30 s. Each
  further failure doubles that, up to 15 min. Attempts while locked are refused
  unchecked and do not extend the lock. Every attempt costs exactly one scrypt
  check: an unknown username is checked against a dummy hash. Every failure gets
  the same message, so neither the response nor its timing tells whether the
  username exists or the account is locked. The lock state is in the database,
  so a restart does not reset it.
- **What it is not.** The login does **not** make it safe to expose HVWA. It
  keeps strangers out of a lab that is built to be broken, but a signed-in
  player can still exploit every lab, by design. Anyone who can reach the login
  page can also lock the account for up to 15 minutes. **It is no substitute
  for the rules below: never expose HVWA beyond your own machine.**

## Rules

1. **Never deploy HVWA publicly.** That means no server, cloud VM, shared
   classroom or office network, or reverse proxy or tunnel to the internet.
   Use it on your own machine, bound to loopback. For a class, every student
   runs their own copy locally.
2. **Never put real secrets in `.env`.** HVWA is built to leak configuration.
   `FLAG_SECRET` is only the HMAC key for lab flags, so use a throwaway value or
   leave it blank (a random one is generated and kept in the data volume). Never
   reuse a password, token or API key there.
3. **Change the default password** (`admin` / `password`) the first time you
   log in, and never use a real password for HVWA.
4. **Prefer the container.** Running locally with `npm start` / `npm run dev`
   is **less isolated**. The server then runs as *you*, with your files,
   credentials (SSH keys, cloud CLIs, browser profiles) and full network
   access. It binds `127.0.0.1` by default and refuses any non-loopback `HOST`
   unless `HVWA_ALLOW_REMOTE=1`. **Never set `HVWA_ALLOW_REMOTE=1` outside the
   container.** Local runs are fine for development and for the
   injection/XSS-class labs. SSRF, deserialization and RCE-class labs are meant
   to run only in the container.

## Host allowlist and `HVWA_ALLOWED_HOSTS` (advanced)

HVWA only reads the raw `Host` header. `X-Forwarded-Host` and Express's
`req.hostname` never affect the decision, so labs remain free to use them as
attack vectors (host-header poisoning). Ambiguous requests fail closed at
**both** layers:

- **More than one `Host` header:** `400 Bad Request`. The app counts the raw
  header lines, since Node itself keeps only the first. nginx rejects them as
  well. The 400 echoes neither value.
- **An absolute-form request line** (`GET http://name/ HTTP/1.1`): its
  authority overrides `Host` (RFC 9112), so it must name an allowed host too.
  Otherwise the response is `421`. The proxy selects its server from that
  authority. It then forwards the client's `Host` unchanged, so an allowed
  authority with a foreign `Host` is still answered `421` by the app. Browsers
  never send absolute-form to a server they are not using as a proxy anyway.
- **Rejected requests** stop before every other middleware. They get no
  session cookie and reach no route.

To reach HVWA under another name, for example `hvwa.lab` in your hosts file
or the address of a host-only VM network, set a comma-separated list of bare
hostnames or IPs (no scheme, port or wildcard):

```sh
HVWA_ALLOWED_HOSTS=hvwa.lab        # in .env, or the environment of npm start
```

With Docker, also add the name to `server_name` in
`docker/proxy/nginx.conf`. The proxy keeps its own list, so a name in `.env`
alone still gets 421 at the proxy. The server prints the extra names at
startup.

> **Warning:** every name you add is another way in. Never add a name whose
> DNS someone else controls, such as a public domain or a shared dynamic-DNS
> name: that re-opens DNS rebinding. Adding names does not make it safe to
> expose HVWA beyond your own machine.

## Operations

| Task | Command |
|---|---|
| Start | `docker compose up -d`, then open http://127.0.0.1:1337 and log in as `admin` / `password` |
| Change the password | `/account/password` (the banner links it until you do) |
| Stop (progress kept) | `docker compose down` |
| Reset everything (progress, password, flag secret) | `docker compose down -v` |
| Forgot the password (progress kept) | See README, "Login" |
| Verify the isolation | `npm run verify:docker` (builds, checks, then `down`; keeps the volume) |
| Pull-only stack (Docker Hub) | `docker compose -f docker-compose.hub.yml up -d` / `down`; verify with `HVWA_COMPOSE_FILE=docker-compose.hub.yml npm run verify:docker` |

The compose project is always named `hvwa`. Its containers, networks and
volume are `hvwa-*` / `hvwa_*`, and these commands never touch other compose
projects on the machine.

## Reporting

A vulnerability *in a lab* is a feature. A way **out** of the boundary
described above is a real bug: egress from the app, a non-loopback listener,
a container escape, or anything else that defeats a row in the protection
table. Please report it to the maintainers by opening an issue, with the
`npm run verify:docker` output.
