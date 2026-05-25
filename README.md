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
2. **Control plane (orchestrator)** — backend API that owns agent lifecycle.
   Talks **directly to the Docker engine** to run containers, injects
   config/secrets, proxies the terminal and desktop streams, and persists agent
   state.
3. **Agent runtime (data plane)** — an **Ubuntu 24.04 GNOME desktop** container
   running **systemd** as PID 1. systemd starts the desktop stack (TigerVNC +
   GNOME Shell, served to the browser over **noVNC** on `:6080`) and a
   **terminal supervisor** on `:7681` that owns multiple `claude`/shell sessions
   as node-pty processes and streams them to xterm.js. The first session is an
   always-on `claude --dangerously-skip-permissions` in `/home/agent`. Ships a
   full toolchain (Chrome/Chromium, VS Code, ffmpeg, Python/uv, Node/nvm, fish)
   and self-updating Claude Code. Needs privileged run flags (see
   [Running an agent](#running-an-agent-container)).

A fourth plane — **Swarm services** (shared MCP servers for messaging, memory,
and tools) — is planned but out of scope for now; the structure leaves room for
it.

```
        ┌───────────────┐  terminal (WS) + desktop (noVNC/WS)  ┌────────────────────┐
        │   Dashboard   │ ───────────────────────────────────► │   Control Plane    │
        │ xterm + noVNC │ ◄─────────────────────────────────── │   (orchestrator)   │
        └───────────────┘            live streams              └─────────┬──────────┘
                                                                         │ Docker engine API
                                                                         │ (socket)
                                                                         ▼
            ┌────────────────────────────────────────────────────────────────────┐
            │                 Agent Containers (systemd as PID 1)                 │
            │   ┌────────────────────────────┐  ┌────────────────────────────┐    │
            │   │ Ubuntu 24.04 GNOME desktop  │  │ Ubuntu 24.04 GNOME desktop  │  … │
            │   │ TigerVNC + noVNC   (:6080)  │  │ TigerVNC + noVNC   (:6080)  │    │
            │   │ terminal supervisor (:7681) │  │ terminal supervisor (:7681) │    │
            │   │  node-pty → claude/shells   │  │  node-pty → claude/shells   │    │
            │   └────────────────────────────┘  └────────────────────────────┘    │
            └────────────────────────────────────────────────────────────────────┘
                                          │
                          ┌───────────────┴───────────────┐
                          │   Postgres    │  object store  │
                          │ (agent state) │ (logs/artifacts)│
                          └───────────────────────────────┘

         (planned) Swarm Services: messaging / memory / tools MCP servers
                   that agents connect to over MCP — not built yet.
```

---

## Repository layout

A pnpm-workspace monorepo so the dashboard, control plane, and shared contracts
evolve together:

```
agent-swarm/
├── apps/
│   ├── dashboard/            # Web UI (Next.js + React + xterm.js + noVNC)
│   │   ├── src/
│   │   ├── public/
│   │   └── package.json
│   │
│   ├── control-plane/        # Orchestrator API (lifecycle, scheduling, streaming)
│   │   ├── src/
│   │   │   ├── api/          # HTTP/WS route handlers
│   │   │   ├── docker/       # Docker engine driver (dockerode)
│   │   │   ├── agents/       # agent domain model + lifecycle state machine
│   │   │   ├── db/           # schema, migrations, repositories
│   │   │   └── events/       # session/log streaming (pub-sub)
│   │   └── package.json
│   │
│   └── swarm-services/       # (planned) shared MCP servers — messaging/memory/tools
│
├── packages/
│   └── shared/               # Shared TS types & API contracts (single source of truth)
│       └── src/
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
├── infra/
│   ├── docker-compose.yml    # local dev: control-plane + db + dashboard
│   └── migrations/
│
├── scripts/                  # dev/build/release helpers
├── docs/
│   ├── architecture.md
│   └── adr/                  # architecture decision records
│
├── .env.example
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### What lives where

| Path                   | Responsibility                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `apps/dashboard`       | Operator UI: agent list, create/config forms, live xterm.js terminal + noVNC desktop. |
| `apps/control-plane`   | The brain. Owns the agent lifecycle state machine; drives the Docker engine.          |
| `apps/swarm-services`  | _(planned)_ shared MCP servers — messaging, memory, custom tools.                     |
| `packages/shared`      | Types/DTOs shared by dashboard ↔ control plane ↔ runtime to stay in sync.             |
| `images/agent`         | Ubuntu 24.04 GNOME desktop image (systemd): VNC/noVNC, browser, VS Code, toolchain.   |
| `images/agent/runtime` | In-container terminal supervisor: node-pty sessions streamed over WebSocket.          |
| `infra`                | How it all gets stood up locally (docker-compose).                                    |

---

## Core concepts

- **Agent** — a logical unit: name, config, workspace, and lifecycle state
  (`creating → running → idle → stopped → deleted`). Backed by one container.
- **Agent config** — model, system prompt, allowed tools, env/secrets, resource
  limits, and the workspace it operates on.
- **Session** — the live `claude` CLI process inside an agent, spawned in a
  pseudo-terminal via **node-pty**. The agent supervisor relays its terminal
  stream up to the control plane, which fans it out to the dashboard's
  **xterm.js** terminal; keystrokes flow back down the same path.
- **Desktop** — each agent runs a full **Ubuntu desktop** (XFCE on Xvfb) served
  to the browser over **noVNC**, giving the agent a GUI environment (browsers,
  graphical apps) and the operator a way to watch/drive it. The control plane
  proxies the noVNC WebSocket per agent — no per-agent ports exposed.
- **Docker driver** — thin wrapper over the Docker engine API (`create`,
  `start`, `stop`, `remove`, `attach`, `logs`) — the Portainer-style mechanism
  for managing the fleet on a single host.
- **Swarm layer** _(planned)_ — shared MCP servers that will give agents
  messaging, continuous memory, and custom tools. See below.

---

## Proposed tech stack

| Layer                   | Choice                                                      | Why                                                          |
| ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------ |
| Dashboard               | Next.js + React + Tailwind + xterm.js + noVNC               | Renders the live terminal and the agent desktop.             |
| Control plane           | Node + TypeScript (Fastify)                                 | Shares types with the UI via `packages/shared`.              |
| Docker access           | `dockerode` over the engine socket                          | Direct container control, Portainer-style.                   |
| Agent base image        | Ubuntu 24.04 + systemd (PID 1)                              | systemd is required for a stable GNOME Shell session.        |
| Agent desktop           | GNOME Shell + TigerVNC + noVNC                              | The real Ubuntu desktop, streamed to the browser.            |
| Agent terminals         | node-pty + ws, rendered by xterm.js                         | Always-on `claude`/shell sessions; multi-session add/remove. |
| Agent toolchain         | Chrome/Chromium, VS Code, ffmpeg, Python/uv, Node/nvm, fish | What the agent needs to actually get work done.              |
| Persistence             | Postgres (agent state) + object store (logs/artifacts)      | Durable state; cheap blob storage.                           |
| Transport               | REST for control, WebSocket for live session streams        | Standard, dashboard-friendly.                                |
| Monorepo                | pnpm workspaces (+ Turborepo optional)                      | Single-version-policy, fast incremental builds.              |
| Swarm layer _(planned)_ | TS MCP servers over HTTP/SSE                                | Remote transport so all agents share one source of state.    |

---

## Getting started

> Placeholder — fill in once the stack is scaffolded.

```bash
pnpm install
cp .env.example .env          # set ANTHROPIC_API_KEY, DB url, etc.
docker compose -f infra/docker-compose.yml up   # control-plane + db
pnpm --filter dashboard dev   # http://localhost:3000
```

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

## Running an agent container

Today the agent image is the runnable piece (control plane + dashboard aren't
built yet). Build and run one directly:

```bash
docker build -t agent-swarm/agent:dev images/agent

# macOS: bridge the Claude credential out of the Keychain first (see Authentication)
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

The `SYS_ADMIN`/`SYS_BOOT` caps, cgroup mount, and unconfined seccomp/apparmor
are required for systemd + GNOME Shell in a container; the control plane will
inject these (and the credential mount) per agent via `dockerode`. The image is
multi-arch: **arm64** uses Chromium (xtradeb PPA), **amd64** uses Google Chrome;
browsers render WebGL in software (SwiftShader).

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
