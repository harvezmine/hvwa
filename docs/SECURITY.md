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
  created with `internal: true`, which has no gateway and therefore no route to
  the outside.
- **proxy** is a thin nginx (`nginxinc/nginx-unprivileged`). Docker cannot
  publish a port from an internal-only network, so the proxy sits on both
  `lab` and `edge` and forwards every request to `app:1337`. It is transparent
  on purpose: it adds no security headers and filters no payloads, because the
  labs must stay exploitable. Its upstream is fixed, so it is not an open
  proxy.
- The only published port is `127.0.0.1:1337`, on loopback only.

## What the container boundary protects

| Property | How | What it stops |
|---|---|---|
| **No egress from the app** | `app` is only on the internal `lab` network: no default route, and Docker's embedded DNS answers internal names only (external names get SERVFAIL) | SSRF and RCE payloads cannot reach the internet, your LAN, the Docker host (`host.docker.internal`) or cloud metadata endpoints. Data cannot be exfiltrated over HTTP or DNS, and nothing can be downloaded into the lab |
| **Loopback-only publish** | `127.0.0.1:1337:8080`; the app publishes nothing | Other machines on your Wi-Fi or LAN cannot connect |
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

- **Anything that can reach your loopback.** Every local process, and every
  browser tab, can talk to `127.0.0.1:1337`. A malicious website could use DNS
  rebinding to drive the labs through your browser (the proxy forwards any
  `Host`). The blast radius is still the container, but **stop HVWA when you are
  not using it** (`docker compose down`).
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
