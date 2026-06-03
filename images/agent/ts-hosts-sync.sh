#!/bin/bash
# Layer 1 (userspace-mode safe): populate /etc/hosts with tailnet peers
# scraped from `tailscale status --json`. Bracketed by markers so re-runs
# replace the block instead of appending duplicates.
#
# Why /etc/hosts and not a real resolver? In --tun=userspace-networking mode,
# tailscaled exposes its DNS only via its unix socket — 100.100.100.100 isn't
# reachable from the kernel netstack (no route to 100.x). Static /etc/hosts
# entries work without touching the resolver path. Connecting to the 100.x IPs
# still requires SOCKS (no kernel route), but apps stop failing at the DNS leg.
set -eu

MARK_BEGIN="# >>> swarm tailnet peers (auto-generated) >>>"
MARK_END="# <<< swarm tailnet peers <<<"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale not installed; skipping"
  exit 0
fi

if ! tailscale status --json >/dev/null 2>&1; then
  echo "tailscale not up; skipping"
  exit 0
fi

# Build the new block: one "IP  shortname FQDN" line per peer + self.
block=$(tailscale status --json | python3 -c '
import json, sys
d = json.load(sys.stdin)
out = []
def add(p):
    ip = (p.get("TailscaleIPs") or [None])[0]
    if not ip: return
    name = (p.get("HostName") or "").strip()
    dns = (p.get("DNSName") or "").rstrip(".").strip()
    parts = [ip]
    if name: parts.append(name)
    if dns and dns != name: parts.append(dns)
    if len(parts) > 1:
        out.append("  ".join(parts))
self = d.get("Self") or {}
if self: add(self)
for p in (d.get("Peer") or {}).values(): add(p)
print("\n".join(out))
')

# Strip any prior block, then append the new one.
tmp=$(mktemp)
awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
  $0 == b {skip=1; next}
  $0 == e {skip=0; next}
  !skip {print}
' /etc/hosts > "$tmp"

if [ -n "$block" ]; then
  {
    echo "$MARK_BEGIN"
    echo "# generated $(date -Iseconds) by /usr/local/bin/ts-hosts-sync"
    echo "$block"
    echo "$MARK_END"
  } >> "$tmp"
fi

cat "$tmp" > /etc/hosts
rm -f "$tmp"
echo "wrote $(echo "$block" | wc -l) tailnet hosts to /etc/hosts"
