#!/bin/sh
# Set the system timezone from the container's TZ env var (set by the gateway).
# systemd services don't inherit the container env, so read it from PID 1.
set -e
TZ=$(tr '\0' '\n' < /proc/1/environ | sed -n 's/^TZ=//p' | head -n1)
[ -n "$TZ" ] || exit 0
ZONE="/usr/share/zoneinfo/$TZ"
[ -e "$ZONE" ] || { echo "agent-set-timezone: unknown zone '$TZ'" >&2; exit 0; }
ln -sf "$ZONE" /etc/localtime
printf '%s\n' "$TZ" > /etc/timezone
echo "agent-set-timezone: set to $TZ"
