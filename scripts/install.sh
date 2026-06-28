#!/usr/bin/env bash
#
# Agent Swarm — one-line installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AlexZihaoXu/agent-swarm/main/scripts/install.sh | bash
#
# Run from inside a clone it reuses the checkout; run standalone (the curl form)
# it clones the repo first. Either way it: creates .env, the shared swarm-net
# network, and brings up the control plane with `docker compose up --build -d`.
# Idempotent — safe to re-run to update an existing install.
#
# Environment knobs:
#   AGENT_SWARM_DIR   where to clone/use the repo   (default: ./agent-swarm, or the current clone)
#   AGENT_SWARM_REF   git branch/tag to install     (default: main)
#   NO_BUILD=1        configure only; skip `docker compose up --build`
#
set -euo pipefail

REPO_URL="https://github.com/AlexZihaoXu/agent-swarm.git"
REF="${AGENT_SWARM_REF:-main}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mx\033[0m  %s\n' "$*" >&2; exit 1; }

# --- prerequisites --------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker is required — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (the 'docker compose' subcommand)."
docker info >/dev/null 2>&1 || die "Can't reach the Docker daemon. Is it running, and can your user use it?"

# --- locate or fetch the repo --------------------------------------------
if [ -f compose.yml ] && [ -f Dockerfile ]; then
  DIR="$(pwd)"
  log "Using the current checkout: $DIR"
else
  command -v git >/dev/null 2>&1 || die "git is required to fetch the repo."
  DIR="${AGENT_SWARM_DIR:-$(pwd)/agent-swarm}"
  if [ -d "$DIR/.git" ]; then
    log "Updating existing clone at $DIR"
    git -C "$DIR" fetch --depth 1 origin "$REF"
    git -C "$DIR" checkout -q "$REF"
    git -C "$DIR" reset --hard -q "FETCH_HEAD"
  else
    log "Cloning $REPO_URL ($REF) → $DIR"
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$DIR"
  fi
fi
cd "$DIR"

# --- .env -----------------------------------------------------------------
# Portable in-place key=value setter for .env (no GNU sed dependency).
set_env() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env 2>/dev/null; then
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}

if [ ! -f .env ]; then
  cp .env.example .env
  log "Created .env from .env.example"
  # Pick good defaults for a real Linux host (these only touch a freshly-made .env).
  if docker info --format '{{.Runtimes}}' 2>/dev/null | grep -q 'sysbox-runc'; then
    set_env AGENT_RUNTIME sysbox-runc
    note "Detected Sysbox → set AGENT_RUNTIME=sysbox-runc (unprivileged, well-isolated agents)."
  elif [ "$(uname -s)" = "Linux" ]; then
    warn "Sysbox not detected. Agents will run with privileged flags (runc)."
    note "For strong agent↔host isolation install Sysbox and set AGENT_RUNTIME=sysbox-runc in .env:"
    note "  https://github.com/nestybox/sysbox"
  fi
  if [ -d /dev/dri ] && ls /dev/dri/render* >/dev/null 2>&1; then
    set_env AGENT_GPU 1
    note "Detected a GPU (/dev/dri) → set AGENT_GPU=1 for hardware-accelerated agent graphics."
  fi
else
  log ".env already present — leaving it untouched"
fi

# --- shared network (idempotent) -----------------------------------------
if docker network inspect swarm-net >/dev/null 2>&1; then
  log "Network swarm-net already exists"
else
  log "Creating the swarm-net network"
  docker network create swarm-net >/dev/null
fi

# --- bring up the control plane ------------------------------------------
if [ "${NO_BUILD:-}" = "1" ]; then
  warn "NO_BUILD=1 — skipping 'docker compose up --build'. Start it later with: docker compose up --build -d"
else
  log "Building + starting the control plane (first build takes a few minutes)…"
  docker compose up --build -d
fi

PORT="$(awk -F= '/^DASHBOARD_PORT=/{print $2}' .env 2>/dev/null)"; PORT="${PORT:-8080}"

printf '\n\033[1;32m✓ Agent Swarm is up.\033[0m  Open  \033[1mhttp://localhost:%s\033[0m  (or http://<this-host>:%s)\n\n' "$PORT" "$PORT"
cat <<EOF
First run:
  1. Create your operator login (username + password) on first open.
  2. Settings → paste your Claude token, then Save.
       claude setup-token        # run on any machine with Claude Code
     (or set CLAUDE_CODE_OAUTH_TOKEN in $DIR/.env and re-run this installer)
  3. Click "Build image", then "New agent".

Manage (from $DIR):
  docker compose logs -f dashboard     # tail control-plane logs
  docker compose up --build -d         # update after 'git pull' or re-running the installer
  ./scripts/uninstall.sh               # remove the stack (add --purge to also delete agent data)
EOF
