#!/usr/bin/env bash
# deploy.sh — pull the latest code and redeploy the whole HVWA range on this host: `bash deploy.sh`.
#
# Run it from a clone of the repo on the server. Everything that must not live in git stays in the stack directory
# ($HVWA_STACK_DIR, default ~/hvwa-range/stack): .env (secrets), the pinned lab registry the warden reads, server-only
# Traefik files (Portainer, the lab-gone catch-all) and an optional compose.server.yml override. This script copies
# the compose file and the repo's Traefik config into it, never deletes a server-only file and never touches .env.
#
# Steps: git pull (fast-forward only) -> build portal + warden -> build every lab and pin its image id in the stack's
# registry -> sync compose + Traefik config -> docker compose up --wait -> restart what reads changed config -> smoke.
# Builds happen before anything is replaced, so a failed build leaves the running range untouched.
#
# One-time on a host that exposes Portainer through Traefik (network hvwa-ops), create $HVWA_STACK_DIR/compose.server.yml:
#   services:
#     router:
#       networks:
#         ops: {}
#   networks:
#     ops:
#       external: true
#       name: hvwa-ops
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="${HVWA_STACK_DIR:-$HOME/hvwa-range/stack}"
PROJECT="${HVWA_PROJECT:-hvwa-range}"
BRANCH="${HVWA_BRANCH:-main}"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

for c in git docker python3 flock curl sha256sum; do command -v "$c" >/dev/null || die "missing command: $c"; done
docker compose version >/dev/null 2>&1 || die "missing the docker compose plugin"
[ -f "$STACK_DIR/.env" ] || die "$STACK_DIR/.env not found (the secrets live there, never in git)"

exec 9>"$STACK_DIR/.deploy.lock"
flock -n 9 || die "another deploy is already running"

compose_files=(-f "$STACK_DIR/docker-compose.range.yml")
[ -f "$STACK_DIR/compose.server.yml" ] && compose_files+=(-f "$STACK_DIR/compose.server.yml")
# Traefik reaches Portainer over hvwa-ops; that attachment must come from compose.server.yml once the repo's compose
# file replaces the server copy, or the Portainer route silently disappears.
if docker network inspect hvwa-ops >/dev/null 2>&1 && [ ! -f "$STACK_DIR/compose.server.yml" ]; then
  die "network hvwa-ops exists but $STACK_DIR/compose.server.yml does not (see the header of deploy.sh)"
fi
compose() { docker compose --env-file "$STACK_DIR/.env" --project-directory "$STACK_DIR" -p "$PROJECT" "${compose_files[@]}" "$@"; }
hash_of() { cat "$@" 2>/dev/null | sha256sum | cut -d' ' -f1; }

cd "$REPO_DIR"
log "git pull ($BRANCH)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the repo has local changes; commit or stash them first"
git fetch --prune origin
git checkout -q "$BRANCH"
git pull --ff-only origin "$BRANCH"
log "now at $(git log -1 --format='%h %s')"

VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
export HVWA_RANGE_VERSION="$VERSION" # wins over .env, so compose runs exactly the images built below

log "build portal + warden ($VERSION)"
for target in range-portal range-warden; do
  docker build -f Dockerfile.range --target "$target" -t "sigmajo/hvwa:$target-$VERSION" .
done

# The committed registry pins image ids built on a developer machine; a build here gets other ids, so the warden
# must read a registry pinned to THIS host's images. It is written only after every lab built.
log "build labs and pin them"
mkdir -p "$STACK_DIR/labs" "$STACK_DIR/docker/range/traefik"
registry="$STACK_DIR/labs/registry.json"
registry_before="$(hash_of "$registry")"
python3 - "$registry" <<'PY'
import json, subprocess, sys
reg = json.load(open('labs/registry.json'))
for lab in reg['labs']:
    tag = f"sigmajo/hvwa:lab-{lab['slug']}-{lab['version']}"
    subprocess.run(['docker', 'build', '-t', tag, f"labs/{lab['id']}-{lab['slug']}"], check=True)
    lab['image'] = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag],
                                  check=True, capture_output=True, text=True).stdout.strip()
    print(f"pinned {lab['id']} {tag} {lab['image']}")
with open(sys.argv[1], 'w') as f:  # in place: the warden's bind mount keeps pointing at this file
    json.dump(reg, f, indent=2)
    f.write('\n')
PY

log "sync compose + Traefik config into $STACK_DIR"
traefik_before="$(hash_of "$STACK_DIR"/docker/range/traefik/*.yml)"
cp docker-compose.range.yml "$STACK_DIR/docker-compose.range.yml"
cp docker/range/traefik/*.yml "$STACK_DIR/docker/range/traefik/"
compose config --quiet

log "deploy"
compose up -d --wait --wait-timeout 300
# up recreates only containers whose image or compose config changed; these read files that may have changed alone.
if [ "$(hash_of "$registry")" != "$registry_before" ]; then
  log "lab registry changed: restart warden + portal"
  compose restart warden portal
fi
if [ "$(hash_of "$STACK_DIR"/docker/range/traefik/*.yml)" != "$traefik_before" ]; then
  log "Traefik config changed: restart the router"
  compose restart router
fi
compose up -d --wait --wait-timeout 300
compose ps

host="$(sed -n 's/^HVWA_PORTAL_HOST=//p' "$STACK_DIR/.env" | tail -n1)"
[ -n "$host" ] || host="$(sed -n 's/^HVWA_RANGE_DOMAIN=//p' "$STACK_DIR/.env" | tail -n1)"
log "smoke: https://$host/login"
for _ in $(seq 1 20); do
  if curl -fsS -o /dev/null --max-time 10 "https://$host/login"; then
    log "deployed $(git log -1 --format='%h') — https://$host is up"
    exit 0
  fi
  sleep 3
done
die "https://$host/login did not answer 200 after the deploy; check: docker compose -p $PROJECT logs portal"
