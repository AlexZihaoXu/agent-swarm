#!/bin/sh
# If a GPU render node was passed into the container (gateway --device /dev/dri),
# grant the `agent` user access to its device group so Chrome/Mesa can use the
# GPU. The host gid (e.g. render=993, video=44) may not exist in the container,
# so create a matching group on the fly. A complete no-op without a GPU — the
# browser then renders in software.
set -e
for node in /dev/dri/renderD128 /dev/dri/card0; do
  [ -e "$node" ] || continue
  gid=$(stat -c '%g' "$node")
  grp=$(getent group "$gid" | cut -d: -f1)
  if [ -z "$grp" ]; then
    grp="gpu$gid"
    groupadd -g "$gid" "$grp" 2>/dev/null || true
  fi
  usermod -aG "$grp" agent 2>/dev/null || true
  echo "agent-gpu: granted agent access to $node (group $grp/$gid)"
done
