#!/usr/bin/env bash
#
# Agent Swarm — uninstaller. Removes the control-plane + every spawned agent
# container, the shared network, and the built images.
#
#   ./scripts/uninstall.sh            # remove the stack, KEEP agent data (default)
#   ./scripts/uninstall.sh --purge    # ALSO delete all agent disks + control-plane state (irreversible)
#   ./scripts/uninstall.sh --yes      # don't prompt for confirmation
#
# Works from a clone (uses compose + ./.swarm_data) and also standalone (falls
# back to Docker label/name filters), so it can be run anywhere the daemon is.
#
set -euo pipefail

PROJECT="agent-swarm"
PURGE=0
ASSUME_YES=0
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) printf 'unknown argument: %s (try --help)\n' "$a" >&2; exit 1 ;;
  esac
done

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker not found."

# Run from the repo root when invoked as ./scripts/uninstall.sh, so compose +
# ./.swarm_data resolve. (Harmless if the layout isn't there — we fall back.)
if [ -f "$(dirname "$0")/../compose.yml" ]; then
  cd "$(dirname "$0")/.." && IN_REPO=1
else
  IN_REPO=0
fi

# --- confirm --------------------------------------------------------------
if [ "$ASSUME_YES" != 1 ]; then
  if [ "$PURGE" = 1 ]; then
    printf '\033[1;31mPURGE:\033[0m stop everything AND delete all agent disks (./.swarm_data) + the gateway-data volume. This is irreversible.\n'
  else
    printf 'Stop + remove the Agent Swarm containers, network, and images. Agent data is kept.\n'
  fi
  printf 'Continue? [y/N] '
  if [ -r /dev/tty ]; then read -r ans </dev/tty; else read -r ans; fi
  case "${ans:-}" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

# --- 1. stop + remove containers (control plane + spawned agents) ---------
log "Stopping the control plane + spawned agents"
if [ "$IN_REPO" = 1 ]; then
  if [ "$PURGE" = 1 ]; then
    docker compose down --remove-orphans --volumes || true
  else
    docker compose down --remove-orphans || true
  fi
fi
# Belt-and-suspenders: catch anything left in the project OR named swarm-agent-*
# (docker ANDs multiple --filter flags, so query each and union the results).
leftover="$(printf '%s\n%s' \
  "$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}" 2>/dev/null || true)" \
  "$(docker ps -aq --filter "name=^swarm-agent-" 2>/dev/null || true)" | sort -u | sed '/^$/d')"
if [ -n "$leftover" ]; then
  log "Removing leftover containers"
  # shellcheck disable=SC2086
  docker rm -f $leftover >/dev/null 2>&1 || true
fi

# --- 2. images ------------------------------------------------------------
log "Removing built images"
docker rmi -f agent-swarm/agent:dev "${PROJECT}-dashboard" >/dev/null 2>&1 || true

# --- 3. shared network (only succeeds once nothing is attached) -----------
log "Removing the swarm-net network"
docker network rm swarm-net >/dev/null 2>&1 || true

# --- 4. data (purge only) -------------------------------------------------
if [ "$PURGE" = 1 ]; then
  log "Deleting control-plane state (gateway-data volume)"
  docker volume rm "${PROJECT}_gateway-data" >/dev/null 2>&1 || true
  if [ "$IN_REPO" = 1 ] && [ -d ./.swarm_data ]; then
    log "Deleting agent disks (./.swarm_data)"
    # Agent homes are owned by sysbox-mapped uids; fall back to sudo if needed.
    rm -rf ./.swarm_data 2>/dev/null || sudo rm -rf ./.swarm_data || true
  fi
fi

printf '\n\033[1;32m✓ Agent Swarm removed.\033[0m '
if [ "$PURGE" = 1 ]; then
  printf 'All data deleted.\n'
else
  printf 'Agent data kept (./.swarm_data + gateway-data volume) — reinstall to resume.\n'
fi
