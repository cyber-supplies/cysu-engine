#!/bin/sh
# One-command VPS installer for the Cyber Supplies Engine.
set -eu
umask 077

ENGINE_IMAGE=${CYSU_ENGINE_IMAGE_REF:-ghcr.io/cyber-supplies/cysu-engine:3.0.0}
PROXY_IMAGE=${CYSU_ENGINE_PROXY_IMAGE:-caddy:2.11.8}
ENGINE_NAME=cysu-engine
PROXY_NAME=cysu-engine-proxy
CONFIG_DIR=/etc/cysu-engine
IP=
# Discard any inherited export attribute before accepting the CLI value.
unset TOKEN
TOKEN=

usage() {
  echo 'Usage: sudo sh install.sh [--ip PUBLIC_IPV4] --token usr_...' >&2
  exit "${1:-2}"
}
die() { echo "Installer: $*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ip|--token)
      [ "$#" -ge 2 ] || usage
      case "$1" in --ip) IP=$2 ;; --token) TOKEN=$2 ;; esac
      shift 2 ;;
    --help|-h) usage 0 ;;
    *) usage ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die 'Run as root (sudo sh install.sh --ip ... --token ...).'
[ -n "$TOKEN" ] || usage
[ "$(uname -m)" = x86_64 ] || die 'The published engine images require an x86_64 (amd64) VPS.'

# Only an IPv4 literal can enter the Caddyfile. Reject reserved and private
# ranges so a typo cannot create a local certificate and appear successful.
if [ -n "$IP" ]; then
case "$IP" in *[!0-9.]*|'') die '--ip must be a public IPv4 address.' ;; esac
printf '%s\n' "$IP" | awk -F. '
  NF != 4 { exit 1 }
  { for (i=1; i<=4; i++) if ($i !~ /^[0-9]+$/ || length($i)>3 || $i>255 || (length($i)>1 && substr($i,1,1)=="0")) exit 1
    if ($1==0 || $1==10 || $1==127 || $1>=224 || ($1==169 && $2==254) ||
        ($1==172 && $2>=16 && $2<=31) || ($1==192 && $2==168) ||
        ($1==100 && $2>=64 && $2<=127) || ($1==192 && $2==0 && $3==2) ||
        ($1==198 && ($2==18 || $2==19 || $2==51 && $3==100)) ||
        ($1==203 && $2==0 && $3==113)) exit 1
  }
' || die '--ip must be a public IPv4 address.'
fi

case "$TOKEN" in
  usr_?*) case "$TOKEN" in *[!A-Za-z0-9_-]*) die '--token has invalid characters.' ;; esac ;;
  *) die '--token must be a Cyber Supplies user token (usr_...).' ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die 'Automatic Docker installation needs a Debian or Ubuntu VPS with apt-get.'
  echo 'Installing Docker and curl...'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq docker.io curl ca-certificates >/dev/null
fi
command -v curl >/dev/null 2>&1 || die 'curl is required.'
command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
docker info >/dev/null 2>&1 || die 'Docker is not running.'

exists() { [ -n "$(docker ps -aq --filter "name=^$1$")" ]; }
running() { [ -n "$(docker ps -q --filter "name=^$1$")" ]; }
ensure_engine_image() {
  if ! docker image inspect "$ENGINE_IMAGE" >/dev/null 2>&1; then
    echo "Downloading $ENGINE_IMAGE..."
    docker pull "$ENGINE_IMAGE" >/dev/null || die 'Engine image unavailable. Check that the v3 release is public.'
  fi
}

# Provision through local volume access before starting/replacing the engine.
# Never redirect the token to an HTTP endpoint, an env var or Docker arguments.
if exists "$ENGINE_NAME"; then
  data_mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$ENGINE_NAME")
  [ "$data_mount" = volume:cysu-engine-data ] || die 'Existing engine uses a different data mount; refusing to provision the wrong volume.'
fi
ensure_engine_image
set -- run --rm -i --log-driver none -v cysu-engine-data:/data
[ -z "${CYSU_API_URL:-}" ] || set -- "$@" -e "CYSU_API_URL=$CYSU_API_URL"
printf '%s' "$TOKEN" | docker "$@" "$ENGINE_IMAGE" node server/provision-auth.js || die 'Local token provisioning failed; the previous token is unchanged.'

if exists "$ENGINE_NAME"; then
  current=$(docker inspect -f '{{.Config.Image}}' "$ENGINE_NAME")
  if [ "$current" != "$ENGINE_IMAGE" ]; then
    echo "Updating engine from $current to $ENGINE_IMAGE..."
    ensure_engine_image
    docker stop -t 20 "$ENGINE_NAME" >/dev/null
    docker rm "$ENGINE_NAME" >/dev/null
  else
    running "$ENGINE_NAME" || docker start "$ENGINE_NAME" >/dev/null
  fi
fi
if ! exists "$ENGINE_NAME"; then
  ensure_engine_image
  set -- run -d --name "$ENGINE_NAME" --restart unless-stopped --init \
    -p 127.0.0.1:8787:8787 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v cysu-engine-data:/data
  [ -z "${CYSU_API_URL:-}" ] || set -- "$@" -e "CYSU_API_URL=$CYSU_API_URL"
  [ -z "${CYSU_ENGINE_IMAGE:-}" ] || set -- "$@" -e "CYSU_ENGINE_IMAGE=$CYSU_ENGINE_IMAGE"
  docker "$@" "$ENGINE_IMAGE" >/dev/null
fi

i=0
until curl --noproxy '*' -fsS --max-time 2 http://127.0.0.1:8787/api/health >/dev/null 2>&1; do
  running "$ENGINE_NAME" || die 'Engine container stopped. Check: docker logs cysu-engine'
  i=$((i+1)); [ "$i" -lt 60 ] || die 'Engine did not start. Check: docker logs cysu-engine'
  sleep 1
done

worker=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ENGINE_NAME" | sed -n 's/^CYSU_ENGINE_IMAGE=//p')
if [ -n "$worker" ] && ! docker image inspect "$worker" >/dev/null 2>&1; then
  echo "Downloading worker image $worker..."
  docker pull "$worker" >/dev/null || die "Worker image $worker is unavailable."
fi

# An omitted --ip creates a local install, or retains an existing HTTPS proxy.
if [ -z "$IP" ] && exists "$PROXY_NAME"; then
  IP=$(docker inspect -f '{{index .Config.Labels "cysu.engine.public-ip"}}' "$PROXY_NAME")
fi
if [ -z "$IP" ]; then
  echo 'Engine ready at http://127.0.0.1:8787'
  exit 0
fi

if exists "$PROXY_NAME"; then
  existing_ip=$(docker inspect -f '{{index .Config.Labels "cysu.engine.public-ip"}}' "$PROXY_NAME")
  [ "$existing_ip" = "$IP" ] || die "The existing proxy serves $existing_ip. Use that IP or remove the proxy container before changing it."
  running "$PROXY_NAME" || docker start "$PROXY_NAME" >/dev/null
else
  mkdir -p "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  cat > "$CONFIG_DIR/Caddyfile" <<EOF
{
  admin off
  default_sni $IP
}

https://$IP {
  tls {
    issuer acme https://acme-v02.api.letsencrypt.org/directory {
      profile shortlived
      disable_tlsalpn_challenge
    }
  }
  @engine_host host $IP
  handle @engine_host {
    reverse_proxy 127.0.0.1:8787 {
      header_up Host 127.0.0.1:8787
    }
  }
  handle {
    respond 403
  }
}
EOF
  chmod 600 "$CONFIG_DIR/Caddyfile"
  echo "Downloading $PROXY_IMAGE..."
  docker pull "$PROXY_IMAGE" >/dev/null || die 'Caddy image unavailable.'
  docker run --rm -v "$CONFIG_DIR/Caddyfile:/etc/caddy/Caddyfile" "$PROXY_IMAGE" \
    caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null || die 'Could not format the Caddy configuration.'
  chmod 600 "$CONFIG_DIR/Caddyfile"
  docker run --rm -v "$CONFIG_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" "$PROXY_IMAGE" \
    caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || die 'Caddy configuration is invalid.'
  docker run -d --name "$PROXY_NAME" --restart unless-stopped --network host \
    --label "cysu.engine.public-ip=$IP" \
    -v "$CONFIG_DIR/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v cysu-engine-caddy-data:/data \
    -v cysu-engine-caddy-config:/config \
    "$PROXY_IMAGE" >/dev/null
fi

echo 'Waiting for the publicly trusted IP certificate...'
i=0
until curl --noproxy '*' -fsS --max-time 5 --resolve "$IP:443:127.0.0.1" "https://$IP/api/health" >/dev/null 2>&1; do
  running "$PROXY_NAME" || die 'Caddy container stopped. Check: docker logs cysu-engine-proxy'
  i=$((i+1)); [ "$i" -lt 90 ] || die 'HTTPS did not become ready. Ensure ports 80 and 443 are open, then check: docker logs cysu-engine-proxy'
  sleep 2
done
echo "Engine ready at https://$IP"
echo "Use: cysu engine <command> --engine https://$IP --token <your user token>"
