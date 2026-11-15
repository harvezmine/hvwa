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

## What the container boundary protects

| Property | How | What it stops |
|---|---|---|
| **No egress from the app** | `app` is only on the internal `lab` network with an isolated gateway: no default route, no host address on the subnet, and Docker's embedded DNS answers internal names only (external names get SERVFAIL) | SSRF and RCE payloads cannot reach the internet, your LAN, the Docker host (neither `host.docker.internal` nor any host bridge address) or cloud metadata endpoints. Data cannot be exfiltrated over HTTP or DNS, and nothing can be downloaded into the lab |
| **Loopback-only publish** | `127.0.0.1:1337:8080`; the app publishes nothing | Other machines on your Wi-Fi or LAN cannot connect |
| **Host allowlist (DNS rebinding)** | Only `Host` = `localhost`, `127.0.0.1` or `[::1]` (any port) is served. Anything else, no `Host`, or an absolute-form target naming another host gets `421 Misdirected Request`. Duplicate `Host` headers get `400`. This is enforced twice: by the proxy (a `default_server` that never forwards) and by the app itself (`src/core/host-guard.ts`, the first middleware, so `npm start` is covered too) | A malicious website you visit cannot use DNS rebinding (pointing its own hostname at `127.0.0.1`) to drive the labs through your browser |
| **Non-root** | app runs as `node` (uid 1000), proxy as `nginx` (uid 101) | A code-execution lab gives an unprivileged user, not root |
| **No privileges** | `cap_drop: [ALL]`, `no-new-privileges:true`, never `privileged`, no Docker socket mounted | Blocks privilege escalation through capabilities, setuid binaries and the Docker API |
| **Read-only root filesystem** | `read_only: true`. Writable paths are only `/tmp` (tmpfs, `noexec`, 64 MiB) and `/data` (the named volume). The app code is root-owned | An exploit cannot modify the app's code or plant binaries that persist. A restart gives you clean code |
| **Resource limits** | `pids_limit`, `mem_limit`, `cpus` on both services | Fork bombs and runaway payloads cannot starve your machine |
| **Init process** | `init: true` | Child processes from exploited labs are reaped, so no zombies accumulate |

`npm run verify:docker` checks every row of this table against the running
containers. It runs the egress tests from inside the app, with a positive
control so that a failure to run the probe is never counted as a pass. Run it
after changing anything Docker-related.

## What it does NOT protect

- **Other local software.** Every process on your machine can talk to
  `127.0.0.1:1337` and send `Host: localhost`, so local malware or a rogue
  browser extension can drive the labs. Websites cannot, thanks to the Host
  allowlist. They can still fire blind cross-site requests at
  `http://localhost:1337` (CSRF-style, without reading the responses), which
  some labs are vulnerable to by design. The blast radius is still the
  container, but **stop HVWA when you are not using it** (`docker compose down`).
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
  checks only `docker-compose.yml`, so an override that weakens isolation would
  not be caught. Don't create one that does.
- **Port-forwarding tools.** Tunnels and forwarders (ngrok, cloudflared,
  Tailscale Serve/Funnel, VS Code port forwarding, `netsh interface portproxy`,
  WSL mirrored-networking tricks) can republish a loopback port to the world.
  Never point them at HVWA.

## Rules

1. **Never deploy HVWA publicly.** That means no server, cloud VM, shared
   classroom or office network, or reverse proxy or tunnel to the internet.
   Use it on your own machine, bound to loopback. For a class, every student
   runs their own copy locally.
2. **Never put real secrets in `.env`.** HVWA is built to leak configuration.
   `FLAG_SECRET` is only the HMAC key for lab flags, so use a throwaway value or
   leave it blank (a random one is generated and kept in the data volume). Never
   reuse a password, token or API key there.
3. **Prefer the container.** Running locally with `npm start` / `npm run dev`
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
| Start | `docker compose up -d`, then open http://127.0.0.1:1337 |
| Stop (progress kept) | `docker compose down` |
| Reset everything (progress + flag secret) | `docker compose down -v` |
| Verify the isolation | `npm run verify:docker` (builds, checks, then `down`; keeps the volume) |

The compose project is always named `hvwa`. Its containers, networks and
volume are `hvwa-*` / `hvwa_*`, and these commands never touch other compose
projects on the machine.

## Reporting

A vulnerability *in a lab* is a feature. A way **out** of the boundary
described above is a real bug: egress from the app, a non-loopback listener,
a container escape, or anything else that defeats a row in the protection
table. Please report it to the maintainers by opening an issue, with the
`npm run verify:docker` output.
