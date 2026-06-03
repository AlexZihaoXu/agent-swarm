#!/bin/bash
# Restore tailscale state from the agent's persistent backup if /var/lib/tailscale
# is empty (i.e. a fresh container layer after a recreate). The backup lives
# under /home/agent/.swarm/tailscale-backup/ which is bind-mounted, so it
# survives `docker rm`.
#
# What's restored:
#   - /var/lib/tailscale/        (auth keys, derp map cache, node state)
#   - /etc/default/tailscaled    (daemon flags)
#
# Runs as a oneshot before tailscaled.service. Idempotent: if state already
# exists, the restore is skipped; if no backup exists, the restore is skipped
# (new agent — operator will `tailscale up` manually).
set -eu

BACKUP=/home/agent/.swarm/tailscale-backup
STATE=/var/lib/tailscale

# Already has state -> nothing to do (preserves a hand-run `tailscale up`).
if [ -d "$STATE" ] && [ -n "$(ls -A "$STATE" 2>/dev/null)" ]; then
  echo "tailscale state present; skip restore"
  exit 0
fi

# No backup -> nothing to do (fresh agent path).
if [ ! -d "$BACKUP" ]; then
  echo "no backup at $BACKUP; skip restore"
  exit 0
fi

# Restore state dir (root:root 0700 to match a fresh install).
if [ -f "$BACKUP/var-lib-tailscale.tgz" ]; then
  mkdir -p "$STATE"
  tar xzf "$BACKUP/var-lib-tailscale.tgz" -C /var/lib
  chown -R root:root "$STATE"
  chmod 700 "$STATE"
  echo "restored $STATE from snapshot"
fi

# Restore daemon flags (e.g. --tun=userspace-networking --socks5-server).
if [ -f "$BACKUP/etc-default-tailscaled" ]; then
  cp "$BACKUP/etc-default-tailscaled" /etc/default/tailscaled
  echo "restored /etc/default/tailscaled from snapshot"
fi
