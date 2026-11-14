#!/bin/sh
# egress-guard.sh installs the worker's outbound firewall. Runs as root at
# container start, before any agent or profile code, and exits non-zero if the
# rules cannot be installed (the entrypoint then refuses to run).
#
# Allowed:  the public internet, loopback, and DNS to the nameservers in
#           /etc/resolv.conf (home routers like 192.168.1.1 often serve DNS).
#           With CYSU_ENGINE_ALLOW (engine linked): that one engine address:port.
# Blocked:  the host and other containers, private LANs, link-local and cloud
#           metadata (169.254.169.254), carrier-grade NAT, multicast, reserved.
set -eu

BLOCK_V4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
BLOCK_V6="::/128 ::1/128 ::ffff:0:0/96 fc00::/7 fe80::/10 ff00::/8"

nameservers() { awk '/^nameserver/ { print $2 }' /etc/resolv.conf 2>/dev/null; }

iptables -P OUTPUT ACCEPT
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for ns in $(nameservers | grep -v ':' || true); do
  iptables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
done
# Engine linked: CYSU_ENGINE_ALLOW=<IPv4>:<port> lets through that one
# address and TCP port (the engine's agent port), before the blocks.
if [ -n "${CYSU_ENGINE_ALLOW:-}" ]; then
  engine_ip=${CYSU_ENGINE_ALLOW%:*}
  engine_port=${CYSU_ENGINE_ALLOW##*:}
  if ! printf '%s' "$engine_ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ||
     ! printf '%s' "$engine_port" | grep -Eq '^[0-9]{1,5}$'; then
    echo "egress guard: CYSU_ENGINE_ALLOW must be <IPv4>:<port>" >&2
    exit 1
  fi
  iptables -A OUTPUT -d "$engine_ip" -p tcp --dport "$engine_port" -j ACCEPT
fi
for cidr in $BLOCK_V4; do
  iptables -A OUTPUT -d "$cidr" -j REJECT
done

# IPv6: same rules. If they cannot be installed, only continue when the
# container has no routable IPv6 address (Docker's default).
if ! {
  ip6tables -P OUTPUT ACCEPT &&
  ip6tables -F OUTPUT &&
  ip6tables -A OUTPUT -o lo -j ACCEPT &&
  ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT &&
  for ns in $(nameservers | grep ':' || true); do
    ip6tables -A OUTPUT -d "$ns" -p udp --dport 53 -j ACCEPT &&
    ip6tables -A OUTPUT -d "$ns" -p tcp --dport 53 -j ACCEPT
  done &&
  for cidr in $BLOCK_V6; do ip6tables -A OUTPUT -d "$cidr" -j REJECT; done
} 2>/dev/null; then
  if awk '$6 != "lo" && $1 !~ /^fe80/ { found = 1 } END { exit !found }' /proc/net/if_inet6 2>/dev/null; then
    echo "egress guard: IPv6 is enabled but ip6tables rules could not be installed" >&2
    exit 1
  fi
fi
