# HVWA: Holy Vulnerable Web App

> **WARNING: HVWA is deliberately vulnerable. Never expose HVWA to an untrusted network.**
>
> **PERINGATAN: HVWA sengaja dibuat rentan. Jangan pernah mengekspos HVWA ke jaringan yang tidak tepercaya.**

HVWA is a deliberately vulnerable web application for learning web security
hands-on, a modern successor to DVWA. Every challenge has four difficulty
levels (Acolyte, Templar, Inquisitor, Divine), a flag to capture, and View
Source with a diff against the secure reference. It is bilingual
(English by default, Indonesian through the EN/ID switch) and built on Node 22, TypeScript, Express 5 and
`node:sqlite`.

## Run from Docker Hub (lite trial)

> **WARNING: HVWA is deliberately vulnerable. Never expose HVWA to an untrusted network. Run it on your own machine only, and stop it when you are done.**
>
> **PERINGATAN: HVWA sengaja dibuat rentan. Jangan pernah mengekspos HVWA ke jaringan yang tidak tepercaya. Jalankan hanya di komputer Anda sendiri, dan hentikan setelah selesai.**

The lite edition (`sigmajo/hvwa:lite`) has five beginner challenges: GK-01 SQLi
login bypass, GK-02 brute force, GK-12 IDOR profile, RM-05 negative quantity and
SC-01 reflected XSS. You need only Docker Engine 28 or newer (any current Docker
Desktop): no checkout, no Node.

The compose file ships inside the image. Copy it out, then start the stack, in any
shell (bash, zsh, PowerShell, cmd):

```sh
docker create --name hvwa-compose sigmajo/hvwa:lite
docker cp hvwa-compose:/app/docker-compose.hub.yml .
docker rm hvwa-compose
docker compose -f docker-compose.hub.yml up -d
```

You can also download `docker-compose.hub.yml` from this repository: it is the same
file, and it is the only file you need.

1. Open **http://127.0.0.1:1337**.
2. Log in as **`admin` / `password`**.
3. Change the password right away. A banner on every page links to
   **Change password** (`/account/password`) until you do.

| Task | Command |
|---|---|
| Stop (progress and password kept) | `docker compose -f docker-compose.hub.yml down` |
| Reset everything (progress, password, flag secret) | `docker compose -f docker-compose.hub.yml down -v` |
| Update to the newest image | `docker compose -f docker-compose.hub.yml pull`, then `up -d` again |

The stack has the same hardening as the source build (see [docs/SECURITY.md](docs/SECURITY.md)):
- the app runs non-root, on a read-only filesystem;
- it sits on an internal network, with **no internet access and no route to your machine**;
- it is behind a proxy published on `127.0.0.1` only.

Its compose project is named `hvwa`, like the source stack, so run only one of them at a time.
`HVWA_TAG=<tag>` picks another image tag. `HVWA_ADMIN_PASSWORD` sets the first password (see
[Login](#login)). Set either one in a `.env` file next to the compose file.

**`:lite` is a mutable tag:** each new push of the trial moves it, and the next `pull` gets the new
image. To stay on the exact image you tested, pin its digest. Read the digest of the image you have:

```sh
docker image inspect --format "{{index .RepoDigests 0}}" sigmajo/hvwa:lite
```

It prints `sigmajo/hvwa@sha256:<digest>`. Then put this line in the `.env` file next to the compose file:

```sh
HVWA_TAG=lite@sha256:<digest>
```

The image becomes `sigmajo/hvwa:lite@sha256:<digest>`. Docker runs exactly that digest; the tag is
only a label. Use the same `sigmajo/hvwa@sha256:<digest>` reference in `docker create` above to copy the
compose file out of that exact image.

## Quick start from source (Docker, recommended)

Needs Docker Engine 28 or newer (any current Docker Desktop). Run this in the
repository directory, where `docker-compose.yml` is:

```sh
docker compose up -d
```

The first `up` builds the image (the full edition), which needs internet access to download
base images and npm packages. After that, HVWA runs offline. `HVWA_EDITION=lite docker compose up -d --build`
builds the lite edition instead.

Open **http://127.0.0.1:1337** and log in as **`admin` / `password`**, then change the password.
Stop with `docker compose down`, which keeps your progress. `docker compose down -v` resets it. From any
other directory, use `docker compose -p hvwa down`.

**After pulling new changes**, rebuild and recreate everything:

```sh
docker compose up -d --build --force-recreate
```

A plain `up -d` can keep running an old `hvwa-app:local` image, possibly one
built from another checkout. When a network setting has changed, it can also
leave the app re-attached without its service name, and the proxy then
answers 502.

The stack runs the app non-root on a read-only filesystem, on an internal
network with **no internet access and no route to your machine**, behind a
proxy published on loopback only. To check all of that on your machine (needs
Node 22.18+ and Docker):

```sh
npm run verify:docker
```

It builds, checks, and stops the stack again, keeping the data volume. It
refuses to run while an HVWA stack started from another checkout of the repo
exists. `HVWA_COMPOSE_FILE=docker-compose.hub.yml npm run verify:docker` runs the same checks on
the pull-only stack and its published image, for example a freshly built `sigmajo/hvwa:lite`.

Optional: copy `.env.example` to `.env` to set `FLAG_SECRET` or `HVWA_ADMIN_PASSWORD`. Never
put real secrets in it.

## Login

HVWA has one account, **`admin`**, DVWA-style. It guards the lab itself: the labs behind it are
the vulnerable part; the login is not one of them.

- **Default credentials: `admin` / `password`.** They are created on first start, when the data
  directory has no account yet. Change the password at `/account/password`. It must be at least 8
  characters and differ from the current one. Until you change it, every page shows a banner.
- **`HVWA_ADMIN_PASSWORD`** sets the first password instead of `password` (at least 8 characters). It
  applies only while no account exists. After that, the password lives (scrypt-hashed) in the data
  directory, and only `/account/password` changes it. Set later, it is ignored, and the server warns:
  "set but ignored". It is never logged, and the server removes it from its environment at startup.
- **`HVWA_AUTH`** (`on` | `off`) turns the login on or off. Unset, it is **on** when
  `NODE_ENV=production`, as in the Docker image, and **off** otherwise, as in `npm run dev` and `npm start`.
  Try it locally with `HVWA_AUTH=on npm run dev`.
- **Lockout.** After 5 failed attempts in a row, logging in pauses for 30 seconds. Each further
  failure doubles the pause, up to 15 minutes, and the pauses keep coming while failures do. Every
  failure shows the same message. When many attempts arrive at once, the extra ones get "server busy"
  (HTTP 503): wait a moment.
- **Changing the password** signs out every other browser. Lab progress is never lost: it belongs
  to your browser session, not to the login.
- **Locked out?** Clear the lockout and keep the password and your progress. This applies at once,
  with no restart:

  ```sh
  docker exec hvwa-app-1 node -e "new (require('node:sqlite').DatabaseSync)('/data/hvwa.db').exec('UPDATE users SET failures=0, locked_until=0')"
  ```

- **Forgot the password?** `docker compose down -v` resets everything. To keep your progress, delete
  only the account, then restart. The account is then re-created with `HVWA_ADMIN_PASSWORD`, or with
  `password` if that is unset:

  ```sh
  docker exec hvwa-app-1 node -e "new (require('node:sqlite').DatabaseSync)('/data/hvwa.db').exec('DELETE FROM auth_tokens; DELETE FROM users')"
  docker restart hvwa-app-1
  ```

  These work with both compose files: their project is named `hvwa`, so the app container is
  `hvwa-app-1`. Without Docker, run the same `node -e` line against `data/hvwa.db`: the unlock
  works while the server runs, but stop the server before deleting the account.

  Images published before the range release (for example `sigmajo/hvwa:lite` of 2026-11-18) still call the account
  table `auth_accounts`: with those, write `auth_accounts` where the commands above say `users`.

The login does not make HVWA safe to expose: see [docs/SECURITY.md](docs/SECURITY.md#the-platform-login).

## Local development

```sh
npm install
npm run dev        # http://127.0.0.1:1337, restarts on change (login off unless HVWA_AUTH=on)
npm test
```

You can also run `npm run typecheck`, `npm run build && npm start` (production
build) and `npm run verify:dist`. That builds `dist/` and boots it with `NODE_ENV=production`, as in
the image, so the login is on. It signs in with the default credentials and probes every challenge.
`HVWA_EDITION=lite npm run verify:dist` checks the lite edition: exactly 5 challenges.
`HVWA_EDITION=lite npm run dev` runs it locally. Running without Docker is **less isolated**: the
server runs as your user with your network access. See [docs/SECURITY.md](docs/SECURITY.md).

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) before running HVWA anywhere other
than your own machine. In short: don't.
