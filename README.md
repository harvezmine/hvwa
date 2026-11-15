# HVWA: Holy Vulnerable Web App

> **WARNING: HVWA is deliberately vulnerable. Never expose HVWA to an untrusted network.**
>
> **PERINGATAN: HVWA sengaja dibuat rentan. Jangan pernah mengekspos HVWA ke jaringan yang tidak tepercaya.**

HVWA is a deliberately vulnerable web application for learning web security
hands-on, a modern successor to DVWA. Every challenge has four difficulty
levels (Acolyte, Templar, Inquisitor, Divine), a flag to capture, and View
Source with a diff against the secure reference. It is bilingual
(Indonesian/English) and built on Node 22, TypeScript, Express 5 and `node:sqlite`.

## Quick start (Docker, recommended)

```sh
docker compose up -d
```

Open **http://127.0.0.1:1337**. Stop with `docker compose down`, which keeps
your progress. `docker compose down -v` resets it.

The stack runs the app non-root on a read-only filesystem, on an internal
network with **no internet access**, behind a proxy published on loopback only.
To check all of that on your machine (needs Node 22.16+ and Docker):

```sh
npm run verify:docker
```

Optional: copy `.env.example` to `.env` to set `FLAG_SECRET`. Never put real
secrets in it.

## Local development

```sh
npm install
npm run dev        # http://127.0.0.1:1337, restarts on change
npm test
```

You can also run `npm run typecheck`, `npm run build && npm start` (production
build) and `npm run verify:dist` (builds and smoke-tests `dist/`). Running
without Docker is **less isolated**: the server runs as your user with your
network access. See [docs/SECURITY.md](docs/SECURITY.md).

## Security

Read [docs/SECURITY.md](docs/SECURITY.md) before running HVWA anywhere other
than your own machine. In short: don't.
