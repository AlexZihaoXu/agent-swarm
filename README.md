# Agent Swarm

A platform for running and managing a fleet ("swarm") of autonomous coding
agents. Each agent is an isolated Docker container running a real
[Claude Code](https://claude.com/claude-code) session, and a web dashboard —
in the spirit of [Portainer](https://www.portainer.io/) — provides
create / configure / monitor / delete control over the whole fleet.

Down the line, a shared **MCP layer** will let agents talk to each other, share
**continuous memory**, and gain custom tools — turning N isolated sessions into
a true swarm. That layer is a planned extension point, not part of the initial
build (see [Planned: the swarm layer](#planned-the-swarm-layer)).

> **Status:** early design. The structure below is a proposal meant to anchor
> discussion — see [Open Questions](#open-questions).

---

## Overview

The initial build has three planes:

1. **Dashboard (UI)** — Portainer-style operator console: create agents, edit
   config, and watch/drive each agent through two live views — an **xterm.js
   terminal** (the `claude` session) and a **noVNC desktop** (the agent's GUI) —
   plus start/stop/delete.
2. **Gateway (control plane)** — the single published port for the whole fleet.
   A TypeScript service that owns agent lifecycle (talks **directly to the
   Docker engine** via `dockerode`) and **reverse-proxies** each agent's
   terminal + desktop streams under `/a/:id/…` — so any number of agents are
   reachable through one port with **no per-agent host ports to collide**. It
   also serves the dashboard.
3. **Agent runtime (data plane)** — an **Ubuntu 24.04 GNOME desktop** container
   running **systemd** as PID 1. systemd starts the desktop stack (TigerVNC +
   GNOME Shell, served to the browser over **noVNC** on `:6080`) and a
   **terminal supervisor** on `:7681` that owns multiple `claude`/shell sessions
   as node-pty processes and streams them to xterm.js. The first session is an
   always-on `claude --dangerously-skip-permissions` in `/home/agent`. Ships a
   full toolchain (Chrome/Chromium, VS Code, ffmpeg, Python/uv, Node/nvm, fish)
   and self-updating Claude Code. Needs privileged run flags (see
   [Running the stack](#running-the-stack)).

A fourth plane — **Swarm services** (shared MCP servers for messaging, memory,
and tools) — is planned but out of scope for now; the structure leaves room for
it.

```
                              host :8080   ← the only published port
                                   │
                       ┌───────────▼────────────┐ ── Docker engine API (socket) ──┐
                       │      Gateway (TS)       │   lifecycle via dockerode        │
                       │  /api/agents            │   (create / start / stop / rm)   │
                       │  /a/:id/desktop  ─┐      │                                  │
                       │  /a/:id/terminal ─┤ reverse-proxy HTTP + WS                 │
                       │  /*  → dashboard  │      │                                  │
                       └───────────┬───────┴──────┘                                  │
                                   │  swarm-net (Docker DNS resolves by name)        │
              ┌────────────────────┼─────────────────────┐                          │
        ┌─────▼──────────────┐ ┌───▼────────────────┐ ┌──▼─────────────────┐  spawns │
        │ Agent (systemd PID1)│ │ Agent (systemd PID1)│ │ Agent (systemd PID1)│ ◄──────┘
        │ GNOME+noVNC   :6080 │ │ GNOME+noVNC   :6080 │ │  … (no host ports) │
        │ terminals     :7681 │ │ terminals     :7681 │ │                    │
        │ node-pty→claude/sh  │ │ node-pty→claude/sh  │ │                    │
        └─────────────────────┘ └─────────────────────┘ └────────────────────┘

   The Dashboard (Next.js + HeroUI) is served by the gateway and embeds each
   agent's xterm.js terminal + noVNC desktop through the /a/:id proxy.
   Persistence (Postgres / object store) and the planned Swarm Services
   (messaging / memory / tools MCP servers) attach here later.
```

---

## Repository layout

A pnpm-workspace monorepo so the dashboard, control plane, and shared contracts
evolve together:

```
agent-swarm/
├── apps/
│   ├── dashboard/            # Web UI (Next.js + React + HeroUI + xterm.js + noVNC)
│   │   ├── app/              # App Router: fleet page + /agents/[id]/terminal
│   │   ├── lib/gateway.ts    # client for the gateway API + /a/:id URL builders
│   │   ├── Dockerfile        # Next.js standalone image
│   │   └── package.json
│   │
│   ├── gateway/              # Control plane + reverse proxy (single published port)
│   │   ├── src/
│   │   │   ├── server.ts     # HTTP server: API + /a/:id proxy + WS upgrades
│   │   │   ├── docker.ts     # dockerode lifecycle + proxy target resolver
│   │   │   ├── proxy.ts      # http-proxy HTTP+WS forwarding (prefix strip)
│   │   │   ├── router.ts     # /a/:id/<service>/<rest> path parsing
│   │   │   ├── api.ts        # /api/agents REST handlers
│   │   │   └── config.ts     # env (mode, network, image, ports, upstream)
│   │   ├── Dockerfile
│   │   └── package.json
│   │
│   └── swarm-services/       # (planned) shared MCP servers — messaging/memory/tools
│
├── packages/
│   └── shared/               # (planned) shared TS types & API contracts
│
├── images/
│   └── agent/                # Ubuntu 24.04 GNOME desktop image (systemd as PID 1)
│       ├── Dockerfile                 # GNOME + TigerVNC/noVNC + browser + VS Code + toolchain
│       ├── novnc.service              # systemd: noVNC web (:6080) → VNC
│       ├── agent-terminals.service    # systemd: terminal supervisor (:7681)
│       ├── claude-code-update.service # systemd: update Claude Code at boot
│       ├── claude-config.json         # pre-accept Claude onboarding + workspace trust
│       ├── novnc-index.html           # noVNC viewer (scale-to-fit, locked 1080p)
│       └── runtime/                   # terminal supervisor (node-pty + ws)
│           ├── server.js              # multi-session manager + WebSocket streaming
│           ├── public/index.html      # xterm.js multi-terminal UI
│           └── package.json
│
├── compose.yml               # prod stack: gateway + dashboard on swarm-net
├── .env.example
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### What lives where

| Path                   | Responsibility                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `apps/dashboard`       | Operator UI: agent list, create/config forms, live xterm.js terminal + noVNC desktop.   |
| `apps/gateway`         | Control plane + reverse proxy: owns lifecycle (dockerode), routes `/a/:id/…` to agents. |
| `apps/swarm-services`  | _(planned)_ shared MCP servers — messaging, memory, custom tools.                       |
| `packages/shared`      | _(planned)_ types/DTOs shared by dashboard ↔ gateway ↔ runtime to stay in sync.         |
| `images/agent`         | Ubuntu 24.04 GNOME desktop image (systemd): VNC/noVNC, browser, VS Code, toolchain.     |
| `images/agent/runtime` | In-container terminal supervisor: node-pty sessions streamed over WebSocket.            |
| `compose.yml`          | Prod stack: gateway + dashboard on the shared `swarm-net` network.                      |

---

## Core concepts

- **Agent** — a logical unit: name, config, workspace, and lifecycle state
  (`creating → running → idle → stopped → deleted`). Backed by one container.
- **Agent config** — model, system prompt, allowed tools, env/secrets, resource
  limits, and the workspace it operates on.
- **Session** — the live `claude` CLI process inside an agent, spawned in a
  pseudo-terminal via **node-pty**. The agent supervisor streams its terminal
  over WebSocket; the gateway proxies it to the dashboard's **xterm.js**
  terminal, and keystrokes flow back down the same path.
- **Desktop** — each agent runs the full **Ubuntu GNOME desktop** (GNOME Shell
  on TigerVNC) served to the browser over **noVNC**, giving the agent a GUI
  environment (browsers, graphical apps) and the operator a way to watch/drive
  it. The gateway proxies the noVNC WebSocket per agent — no per-agent host
  ports exposed.
- **Docker driver** — thin wrapper over the Docker engine API (`create`,
  `start`, `stop`, `remove`, `attach`, `logs`) — the Portainer-style mechanism
  for managing the fleet on a single host.
- **Swarm layer** _(planned)_ — shared MCP servers that will give agents
  messaging, continuous memory, and custom tools. See below.

---

## Proposed tech stack

| Layer                   | Choice                                                      | Why                                                             |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Dashboard               | Next.js + React + HeroUI (Tailwind) + xterm.js + noVNC      | HeroUI v3 component library; xterm.js + noVNC for live views.   |
| Gateway (control plane) | Node + TypeScript (`node:http` + `http-proxy`)              | One process owns lifecycle + reverse proxy; minimal deps.       |
| Docker access           | `dockerode` over the engine socket                          | Direct container control, Portainer-style.                      |
| Fleet routing           | One published port → `/a/:id/<service>` reverse proxy       | No per-agent host ports; agents reachable by name on swarm-net. |
| Agent base image        | Ubuntu 24.04 + systemd (PID 1)                              | systemd is required for a stable GNOME Shell session.           |
| Agent desktop           | GNOME Shell + TigerVNC + noVNC                              | The real Ubuntu desktop, streamed to the browser.               |
| Agent terminals         | node-pty + ws, rendered by xterm.js                         | Always-on `claude`/shell sessions; multi-session add/remove.    |
| Agent toolchain         | Chrome/Chromium, VS Code, ffmpeg, Python/uv, Node/nvm, fish | What the agent needs to actually get work done.                 |
| Persistence             | Postgres (agent state) + object store (logs/artifacts)      | Durable state; cheap blob storage.                              |
| Transport               | REST for control, WebSocket for live session streams        | Standard, dashboard-friendly.                                   |
| Monorepo                | pnpm workspaces (+ Turborepo optional)                      | Single-version-policy, fast incremental builds.                 |
| Swarm layer _(planned)_ | TS MCP servers over HTTP/SSE                                | Remote transport so all agents share one source of state.       |

---

## Getting started

Local dev runs the gateway and dashboard on the host (fast reload) while agents
run as containers. See [Running the stack](#running-the-stack) for the why.

```bash
pnpm install

# 1. Build the agent image
docker build -t agent-swarm/agent:dev images/agent

# 2. Bridge your Claude login to a host file (macOS — see Authentication)
mkdir -p ~/.agent-swarm
security find-generic-password -s "Claude Code-credentials" -w \
  > ~/.agent-swarm/.credentials.json

# 3. Gateway: creates swarm-net, drives Docker, proxies agents (ports mode on macOS)
pnpm --filter @agent-swarm/gateway dev      # http://localhost:8080

# 4. Dashboard (dev): talks to the gateway on :8080
pnpm --filter @agent-swarm/dashboard dev    # http://localhost:3000
```

Then open the dashboard and click **New agent** (or `curl -X POST
localhost:8080/api/agents`). Each agent's terminal and desktop are reachable at
`/a/:id/terminal/` and `/a/:id/desktop/` through the gateway — no per-agent
host ports.

---

## Decided

- **Single-host, Docker engine, Portainer-style** — control plane talks
  directly to the Docker daemon via `dockerode`. No Kubernetes.
- **Control plane in TypeScript** — one language across the stack, shared types.
- **Agents run a normal `claude` CLI session** — not the Agent SDK.
- **Live terminals = node-pty + xterm.js** — an in-container supervisor owns one
  node-pty per session and streams it to xterm.js. Sessions are **always-on**
  (run with or without a viewer), **multi-session** (add/remove), and history is
  preserved across reconnects via a server-side terminal snapshot.
- **Agent = Ubuntu 24.04 GNOME desktop on systemd + noVNC** — each agent runs the
  real Ubuntu GNOME desktop (systemd as PID 1, GNOME Shell via TigerVNC) streamed
  over noVNC, plus a full toolchain. Modern GNOME Shell requires systemd, so the
  container runs with **privileged flags** (see Running an agent) — weaker
  isolation that we've accepted; memory/fleet-density is a non-goal.
- **Auth = shared host credentials, bind-mounted** — agents reuse the host's
  Claude login via a single mounted `.credentials.json` (see Authentication).
- **Dashboard UI = HeroUI** — the dashboard uses HeroUI v3 (React, Tailwind-based)
  as its component library. The HeroUI MCP server is wired into project scope
  (`.mcp.json`) so component docs are available while building it.
- **Single-port gateway, proxy by path** — one published port fronts the fleet.
  The gateway routes `/a/:id/desktop` and `/a/:id/terminal` (HTTP + WebSocket) to
  each agent and serves the dashboard at `/`. Agents need **no host ports**, so
  the fleet scales without port collisions. The proxy resolves agents two ways
  (`GATEWAY_MODE`): **`network`** (by container name over `swarm-net`, prod/Linux)
  or **`ports`** (via Docker-assigned ephemeral host ports on `127.0.0.1`, dev on
  macOS where the host can't route to container IPs/DNS).

## Authentication

Agents reuse the **host's Claude Code login** rather than a separate API key.
A single credentials file is bind-mounted (read-write) into every container at
the path Claude Code reads (`$CLAUDE_CONFIG_DIR/.credentials.json`).

**macOS hosts need a bridge.** On macOS the OAuth token lives in the **Keychain**,
not on disk, so there's no folder to mount directly. At startup the control
plane extracts it once to a host-side file:

```bash
# macOS: Keychain → file (run by the control plane on boot)
security find-generic-password -s "Claude Code-credentials" -w \
  > ~/.agent-swarm/.credentials.json

# Linux: the file already exists, just point at it
ln -sf ~/.claude/.credentials.json ~/.agent-swarm/.credentials.json
```

Each container then mounts it:

```
-v ~/.agent-swarm/.credentials.json:/home/agent/.claude/.credentials.json
```

> **Caveat (known):** one OAuth login shared across many containers is fine for
> a handful of agents, but tokens expire and refresh by _writing back_ a rotated
> token — concurrent refreshes across a large fleet can invalidate each other.
> If we scale up, revisit (per-agent creds, a credential broker, or API keys).

## Running the stack

Normally you don't run agents by hand — the **gateway** creates them via
`dockerode` (the dashboard's **New agent** button, or `POST /api/agents`),
injecting the systemd flags and credential mount automatically. See
[Getting started](#getting-started) for the host-dev flow.

**Why host-dev on macOS.** Docker Desktop for Mac can't route from the host to
container IPs or Docker DNS names — only to published ports. So the gateway runs
in **`ports` mode**: each agent gets a Docker-assigned ephemeral host port and
the host-run gateway proxies to `127.0.0.1:<port>`. On Linux you instead run the
gateway containerized in **`network` mode** (`compose.yml`), where it reaches
agents by name over `swarm-net` and agents publish nothing.

```bash
# Prod-oriented stack (Linux): gateway + dashboard behind one port
CLAUDE_CREDENTIALS_FILE=$HOME/.agent-swarm/.credentials.json \
  docker compose up --build        # dashboard + gateway on :8080
```

> **Credential path gotcha:** in `network` mode the gateway runs in a container,
> but the agent bind mount it requests is resolved by the **host** Docker daemon.
> So `CLAUDE_CREDENTIALS_FILE` must be a **host** path (it is not mounted into the
> gateway — the gateway only forwards the string to the engine).

The agent caps (`SYS_ADMIN`/`SYS_BOOT`), cgroup mount, and unconfined
seccomp/apparmor are required for systemd + GNOME Shell in a container; the
gateway injects these per agent. The image is multi-arch: **arm64** uses Chromium
(xtradeb PPA), **amd64** uses Google Chrome; browsers render WebGL in software
(SwiftShader).

<details>
<summary>Run a single agent image directly (no gateway)</summary>

```bash
docker build -t agent-swarm/agent:dev images/agent
docker run -d --name agent1 \
  --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
  --cap-add SYS_BOOT --cap-add SYS_ADMIN \
  --security-opt seccomp=unconfined --security-opt apparmor=unconfined \
  -v "$HOME/.agent-swarm/.credentials.json:/home/agent/.claude/.credentials.json" \
  -p 6080:6080 -p 7681:7681 \
  agent-swarm/agent:dev
```

- **Desktop:** http://localhost:6080/ — GNOME over noVNC (scale-to-fit, locked 1080p)
- **Terminals:** http://localhost:7681/ — xterm.js; the first tab is the always-on `claude`

</details>

## Planned: the swarm layer

Out of scope for the initial build, but the structure is designed to absorb it.
A future `apps/swarm-services` will host shared **MCP servers** that agents
connect to, giving the fleet:

- **Messaging** — agents send/receive messages to/from each other.
- **Continuous memory** — persistent memory across sessions/restarts.
- **Custom tools** — domain-specific MCP tools shared across agents.

These are deliberately unspecified for now; we'll design them when we get there.

## Open questions

1. **Workspace model** — git repo clone, mounted volume, or ephemeral scratch
   dir per agent? Drives persistence and security.

2. **Other secrets & isolation** — Anthropic auth is settled (shared mounted
   creds); still open: how _repo_ credentials (git tokens, SSH keys) reach a
   container, and how strongly agents are sandboxed from each other/the host.

3. **Multi-tenancy / auth** — single operator, or multiple users with RBAC over
   agents?

4. **Image-paste into the web terminal** — xterm.js handles text paste, not
   clipboard _images_, so pasting an image to Claude in the browser terminal
   doesn't work yet. Needs a clipboard-image path (known limitation).
