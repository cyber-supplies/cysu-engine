#!/bin/sh
# engine.sh: run the Cyber Supplies Engine as a Docker container on this
# machine. This is what `cysu engine` does under the hood (docs/INSTALL.md).
#
#   sh scripts/engine.sh start     start it (or resume it); safe to run again
#   sh scripts/engine.sh stop      stop it (a run in progress is cancelled)
#   sh scripts/engine.sh status    is it running? (with CYSU_TOKEN set: also its setup status)
#   sh scripts/engine.sh logs      follow its log
#   sh scripts/engine.sh update    replace the container with the current image (data is kept)
#   sh scripts/engine.sh reset-auth  disable API access until the installer provisions a token again
#
# Settings (environment):
#   CYSU_ENGINE_IMAGE_REF   engine image          (default ghcr.io/cyber-supplies/cysu-engine:latest;
#                           from a checkout after `npm run engine:build`: cysu-engine:dev)
#   CYSU_ENGINE_PORT        port on 127.0.0.1     (default 8787)
#   CYSU_ENGINE_IMAGE       worker image the engine starts for stages
#                           (default: the engine's own default)
#
# The engine API needs your Cyber Supplies user token on every request (it is
# provisioned locally by install.sh --token); only "is it up?" (/api/health) answers without it.
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
    echo "Downloading the worker image $worker (first time only)…"
    if docker pull "$worker" >/dev/null; then echo "Worker image ready."
    else echo "Could not download $worker (no network, or the image is not public yet). Runs need it."; fi
  fi
}

create() {
  set -- run -d --name "$NAME" --restart unless-stopped --init \
    -p "127.0.0.1:$PORT:8787" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v cysu-engine-data:/data
  [ -z "${CYSU_ENGINE_IMAGE:-}" ] || set -- "$@" -e "CYSU_ENGINE_IMAGE=$CYSU_ENGINE_IMAGE"
  docker "$@" "$IMAGE_REF" >/dev/null
}

case "${1:-}" in
  start)
    if running; then echo "Already running."; elif exists; then docker start "$NAME" >/dev/null; else create; fi
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
    if exists; then docker stop -t 20 "$NAME" >/dev/null 2>&1 || true; docker rm "$NAME" >/dev/null; fi
    create && wait_ready ;;
  reset-auth)
    # Only for a lost token. Keeps the passkey, LLM login, workspaces and runs.
    if ! running; then echo "The engine is not running; start it first: sh scripts/engine.sh start"; exit 1; fi
    if [ "${2:-}" != "--yes" ]; then
      printf 'This removes the engine token and locks protected routes. Restore access with install.sh --token on this host.\nType yes to continue: '
      read -r answer
      [ "$answer" = "yes" ] || { echo "Cancelled."; exit 1; }
    fi
    docker exec "$NAME" node server/reset-auth.js ;;
  *)
    sed -n '2,/^set -eu$/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
