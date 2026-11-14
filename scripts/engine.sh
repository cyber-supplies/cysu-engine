#!/bin/sh
# engine.sh: run the Cyber Supplies Engine as a Docker container on this
# machine. This is what `cysu engine` does under the hood (docs/INSTALL.md).
#
#   sh scripts/engine.sh start     start it (or resume it); safe to run again
#   sh scripts/engine.sh stop      stop it (a run in progress is cancelled)
#   sh scripts/engine.sh status    is it running? (with CYSU_TOKEN set: also its setup status)
#   sh scripts/engine.sh logs      follow its log
#   sh scripts/engine.sh update    download the newest engine image and switch to it (data is kept)
#   sh scripts/engine.sh reset-auth  forget the engine token (lost it?), then run setup again
#
# Settings (environment):
#   CYSU_ENGINE_IMAGE_REF   engine image          (default ghcr.io/cyber-supplies/cysu-engine:latest;
#                           from a checkout after `npm run engine:build`: cysu-engine:dev)
#   CYSU_ENGINE_PORT        port on 127.0.0.1     (default 8787)
#   CYSU_ENGINE_IMAGE       worker image the engine starts for stages
#                           (default: the engine's own default)
#   CYSU_CLI_VERSION        Cyber Supplies CLI for stages: latest (default; checked
#                           on npm hourly, downloaded once per release), x.y.z, or
#                           image (the copy inside the worker image)
#
# The engine API needs your Cyber Supplies user token on every request (it is
# set at the first setup); only "is it up?" (/api/health) answers without it.
#
# Your settings, logins and runs live in the Docker volume cysu-engine-data;
# they survive stop/start/update. The engine needs the Docker socket to start
# worker containers: that gives it full control of Docker on this machine.
set -eu

NAME=cysu-engine
IMAGE_REF=${CYSU_ENGINE_IMAGE_REF:-ghcr.io/cyber-supplies/cysu-engine:latest}
PORT=${CYSU_ENGINE_PORT:-8787}
URL="http://127.0.0.1:$PORT"

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed (https://docs.docker.com/get-docker/)"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running, or this user cannot use it (try: docker ps)"; exit 1; }

exists()  { [ -n "$(docker ps -aq --filter "name=^${NAME}$")" ]; }
image_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }
# A name without a registry (cysu-engine:dev) was built on this machine: never pulled.
local_build() { case "$1" in */*) return 1 ;; *) return 0 ;; esac; }

# pull_image IMAGE WHAT: download IMAGE; if that fails, say why in plain words.
# ghcr.io answers "denied" both for a private image and for a name that does
# not exist, so that message covers both.
pull_image() {
  if out=$(docker pull "$1" 2>&1); then return 0; fi
  case "$out" in
    *unauthorized*|*denied*|*"authentication required"*|*forbidden*|*"requested access to the resource is denied"*)
      echo "Could not download the $2 ($1): access denied."
      echo "  Either the image is not public yet, or this machine is not logged in to the registry:"
      echo "    docker login ghcr.io     (user: your GitHub name; password: a GitHub token with read:packages)"
      echo "  Also check the image name is right." ;;
    *"manifest unknown"*|*"not found"*|*"no such manifest"*)
      echo "Could not download the $2 ($1): that version does not exist. Check the tag." ;;
    *"no such host"*|*"i/o timeout"*|*"TLS handshake timeout"*|*"dial tcp"*|*"connection refused"*|*"network is unreachable"*|*"Client.Timeout"*)
      echo "Could not download the $2 ($1): no connection to the registry. Check the network and try again." ;;
    *)
      echo "Could not download the $2 ($1):"
      printf '%s\n' "$out" | tail -n 3 | sed 's/^/  /' ;;
  esac
  return 1
}
running() { [ -n "$(docker ps -q --filter "name=^${NAME}$")" ]; }

wait_ready() {
  i=0
  while [ $i -lt 60 ]; do
    if curl -fsS -m 2 "$URL/api/health" >/dev/null 2>&1; then echo "Engine ready on $URL"; pull_worker; return 0; fi
    i=$((i + 1)); sleep 0.5
  done
  echo "The engine did not answer on $URL; see: sh scripts/engine.sh logs"; return 1
}

# pull_worker fetches the worker image the engine uses (once, ~2 GB), so the
# first run does not stall on the download.
# The image name comes from the container's settings (the API needs a token).
pull_worker() {
  worker=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$NAME" 2>/dev/null | sed -n 's/^CYSU_ENGINE_IMAGE=//p')
  [ -n "$worker" ] || return 0
  if ! docker image inspect "$worker" >/dev/null 2>&1; then
    echo "Downloading the worker image $worker (first time only, about 2 GB)…"
    if pull_image "$worker" "worker image"; then echo "Worker image ready."
    else echo "The engine is running, but runs cannot start until the worker image is downloaded."; fi
  fi
}

create() {
  if [ -z "$(image_id "$IMAGE_REF")" ]; then
    if local_build "$IMAGE_REF"; then echo "The image $IMAGE_REF is not on this machine; build it first (npm run engine:build)."; return 1; fi
    echo "Downloading the engine image $IMAGE_REF…"
    pull_image "$IMAGE_REF" "engine image" || return 1
  fi
  set -- run -d --name "$NAME" --restart unless-stopped --init \
    -p "127.0.0.1:$PORT:8787" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v cysu-engine-data:/data
  [ -z "${CYSU_ENGINE_IMAGE:-}" ] || set -- "$@" -e "CYSU_ENGINE_IMAGE=$CYSU_ENGINE_IMAGE"
  [ -z "${CYSU_CLI_VERSION:-}" ] || set -- "$@" -e "CYSU_CLI_VERSION=$CYSU_CLI_VERSION"
  docker "$@" "$IMAGE_REF" >/dev/null
}

case "${1:-}" in
  start)
    if running; then echo "Already running."; elif exists; then docker start "$NAME" >/dev/null; else create || exit 1; fi
    wait_ready ;;
  stop)
    if running; then docker stop -t 20 "$NAME" >/dev/null && echo "Stopped."; else echo "Not running."; fi ;;
  status)
    if ! running; then echo "Not running."; exit 0; fi
    if curl -fsS -m 5 "$URL/api/health" >/dev/null 2>&1; then echo "Running on $URL"; else echo "Running, but not answering on $URL yet (see: sh scripts/engine.sh logs)"; exit 1; fi
    if [ -n "${CYSU_TOKEN:-}" ]; then
      # The token goes to curl on stdin (-H @-), never on the command line (ps).
      printf 'Authorization: Bearer %s\n' "$CYSU_TOKEN" | curl -sS -m 5 -H @- "$URL/api/status"; echo
    else
      echo "(set CYSU_TOKEN to your Cyber Supplies user token to see its setup status)"
    fi ;;
  logs)
    docker logs -f "$NAME" ;;
  update)
    # Download first: if that fails, the engine that is running stays as it is.
    before=$(image_id "$IMAGE_REF")
    if ! local_build "$IMAGE_REF"; then
      echo "Downloading the newest engine image $IMAGE_REF…"
      if ! pull_image "$IMAGE_REF" "engine image"; then echo "Nothing was changed."; exit 1; fi
    fi
    # Settings given with update (CYSU_ENGINE_IMAGE, CYSU_CLI_VERSION) need a new container.
    if [ -n "$before" ] && [ "$before" = "$(image_id "$IMAGE_REF")" ] && running \
      && [ -z "${CYSU_ENGINE_IMAGE:-}" ] && [ -z "${CYSU_CLI_VERSION:-}" ]; then
      echo "Already up to date."; exit 0
    fi
    if exists; then docker stop -t 20 "$NAME" >/dev/null 2>&1 || true; docker rm "$NAME" >/dev/null; fi
    create && wait_ready ;;
  reset-auth)
    # Only for a lost token. Keeps the passkey, LLM login, workspaces and runs.
    if ! running; then echo "The engine is not running; start it first: sh scripts/engine.sh start"; exit 1; fi
    if [ "${2:-}" != "--yes" ]; then
      printf 'This removes the engine token. Until you run setup again, the next setup on this machine sets it.\nType yes to continue: '
      read -r answer
      [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
    fi
    docker exec "$NAME" node server/reset-auth.js ;;
  *)
    sed -n '2,/^set -eu$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
