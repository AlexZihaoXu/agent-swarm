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

> **Status:** working, self-hostable build — actively evolving. Jump to
> [Quick start](#quick-start) to run it; the sections below describe how it works.

---

## Quick start

Self-host the whole thing in a few minutes. Like Portainer, it's **one stack you
run with Docker Compose** — then you create, configure, and watch every agent
from the web UI. No per-agent ports, no manual container wrangling.

### Prerequisites

- A host with **Docker** + **Docker Compose v2** (`docker compose …`). Linux is
  ideal for a server; macOS (Docker Desktop) works too.
- **~20 GB free disk** — each agent runs a full Ubuntu GNOME desktop image.
- A **Claude subscription** (or Anthropic API access) — you'll generate a login
  token in step 4.
- Standard (non-rootless) Docker that allows privileged containers. The dashboard
  needs the Docker socket. **Run this only on a host you trust** — see
  [Security](#security).

### 1. Get the code

```bash
git clone https://github.com/AlexZihaoXu/agent-swarm.git
cd agent-swarm
```

### 2. Create the shared network (once)

```bash
docker network create swarm-net
```

### 3. Start the dashboard

```bash
docker compose up --build -d
```

The control plane (gateway + UI) comes up as a single container on port **8080**.
Open **`http://<your-server>:8080`**.

### 4. Add your Claude token

Generate a token on any machine that has [Claude Code](https://claude.com/claude-code):

```bash
claude setup-token        # prints an sk-ant-oat… token
```

Open the dashboard → **Settings** → paste the token → **Save**. (Or set
`CLAUDE_CODE_OAUTH_TOKEN` in a `.env` file before step 3 — see
[`.env.example`](.env.example).)

### 5. Build the agent image + create your first agent

In the dashboard:

1. Click **Build image** on the "Agent image not built" banner — this builds the
   agent runtime once (a few minutes; it's a full desktop image).
2. Click **New agent**, give it a name, and **Create**.
3. Watch it live — an **xterm.js terminal** (the `claude` session) and a **noVNC
   desktop** (its GUI), both embedded in the dashboard.

That's it. Agents persist on disk and the stack restarts with the host
(`restart: unless-stopped`).

### Day-2 operations

```bash
docker compose up --build -d        # update the dashboard after a git pull
docker compose logs -f dashboard    # tail the control-plane logs
docker compose down                 # stop the dashboard (agents keep running)
docker compose down --remove-orphans  # also tear down spawned agents
```

- **Agent data** persists in `./.swarm_data/agents/<id>` (each agent's home disk);
  control-plane settings + state live in the `gateway-data` Docker volume. Both
  survive restarts and `compose up --build`.
- **Stop/restart/remove** individual agents from the dashboard (or the
  `/api/agents/:id` routes). Spawned agents aren't in `compose.yml`, so plain
  `docker compose down` leaves them running — use the dashboard's **Remove** or
  `--remove-orphans`.

### Remote access

The dashboard binds `:8080` with no built-in auth, so don't expose it directly to
the internet. For a remote mini-server, reach it over your LAN, an **SSH tunnel**
(`ssh -L 8080:localhost:8080 user@server`), a VPN (e.g. Tailscale), or put it
behind a reverse proxy that adds TLS + authentication.

### Security

The dashboard mounts the host's **Docker socket** and spawns agents with
**privileged flags** (`SYS_ADMIN`/`SYS_BOOT`, unconfined seccomp/apparmor) —
required for systemd + GNOME inside a container, but it means an agent is **not
strongly isolated** from the host. Treat the whole stack as trusted-host
software: run it on a machine you own, don't expose `:8080` publicly, and only
hand agents work you're comfortable running with that level of access.

---

## Overview

The initial build has two kinds of containers — the **dashboard** (control
plane) and the **agents** it spawns — across three logical planes:

1. **Dashboard UI** — Portainer-style operator console: create agents, edit
   config, and watch/drive each agent through two live views — an **xterm.js
   terminal** (the `claude` session) and a **noVNC desktop** (the agent's GUI) —
   plus start/stop/delete.
2. **Gateway (control plane)** — the single published port for the whole fleet.
   A TypeScript service that owns agent lifecycle (talks **directly to the
   Docker engine** via `dockerode`) and **reverse-proxies** each agent's
   terminal + desktop streams under `/a/:id/…` — so any number of agents are
   reachable through one port with **no per-agent host ports to collide**. The
   gateway and the Next.js UI run **together in one container** (the gateway
   serves the UI by proxying to the Next server on an internal port).
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
        ┌──────────────────────────▼──────────────────────────┐ ─ Docker socket ─┐
        │            Dashboard container (one container)        │  lifecycle via   │
        │  ┌─────────────────────┐   ┌──────────────────────┐  │  dockerode       │
        │  │  Gateway (TS, :8080) │──▶│ Next.js UI (int :3000)│ │  (create/stop/…) │
        │  │  /api/agents         │   │  HeroUI dashboard     │  │                  │
        │  │  /a/:id/desktop ─┐   │   └──────────────────────┘  │                  │
        │  │  /a/:id/terminal ┤ reverse-proxy HTTP + WS         │                  │
        │  │  /*  → UI        │   │                             │                  │
        │  └──────────────────┴───┘                             │                  │
        └──────────────────────────┬──────────────────────────┘                  │
                                   │  swarm-net (Docker DNS resolves by name)      │
              ┌────────────────────┼─────────────────────┐                        │
        ┌─────▼──────────────┐ ┌───▼────────────────┐ ┌──▼─────────────────┐ spawns│
        │ Agent (systemd PID1)│ │ Agent (systemd PID1)│ │ Agent (systemd PID1)│ ◄────┘
        │ GNOME+noVNC   :6080 │ │ GNOME+noVNC   :6080 │ │  … (no host ports) │
        │ terminals     :7681 │ │ terminals     :7681 │ │                    │
        │ node-pty→claude/sh  │ │ node-pty→claude/sh  │ │                    │
        └─────────────────────┘ └─────────────────────┘ └────────────────────┘

   The gateway and Next.js UI share one container; the gateway serves the UI and
   embeds each agent's xterm.js terminal + noVNC desktop through the /a/:id
   proxy. Persistence (Postgres / object store) and the planned Swarm Services
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
│   │   ├── app/              # App Router: fleet page + /agents/[id]/{terminal,desktop}
│   │   ├── lib/gateway.ts    # client for the gateway API + /a/:id URL builders
│   │   └── package.json
│   │
│   ├── gateway/              # Control plane + reverse proxy (single published port)
│   │   ├── src/
│   │   │   ├── server.ts     # HTTP server: API + /a/:id proxy + WS upgrades
│   │   │   ├── docker.ts     # dockerode lifecycle + proxy target resolver
│   │   │   ├── proxy.ts      # http-proxy (HTTP) + raw TCP relay (WS upgrades)
│   │   │   ├── router.ts     # /a/:id/<service>/<rest> path parsing
│   │   │   ├── api.ts        # /api/agents REST handlers
│   │   │   └── config.ts     # env (mode, network, image, project, upstream)
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
├── Dockerfile                # combined image: gateway + Next.js UI in one container
├── start.mjs                 # supervisor: runs Next (:3000) + gateway (:8080) together
├── compose.yml               # the dashboard stack (one service) on swarm-net
├── .env.example
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

### What lives where

| Path                       | Responsibility                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `apps/dashboard`           | Operator UI: agent list, create/config forms, live xterm.js terminal + noVNC desktop.   |
| `apps/gateway`             | Control plane + reverse proxy: owns lifecycle (dockerode), routes `/a/:id/…` to agents. |
| `apps/swarm-services`      | _(planned)_ shared MCP servers — messaging, memory, custom tools.                       |
| `packages/shared`          | _(planned)_ types/DTOs shared by dashboard ↔ gateway ↔ runtime to stay in sync.         |
| `images/agent`             | Ubuntu 24.04 GNOME desktop image (systemd): VNC/noVNC, browser, VS Code, toolchain.     |
| `images/agent/runtime`     | In-container terminal supervisor: node-pty sessions streamed over WebSocket.            |
| `Dockerfile` / `start.mjs` | Combined image + supervisor: gateway and Next.js UI in one container.                   |
| `compose.yml`              | The dashboard stack (single service) on the shared `swarm-net` network.                 |

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

# 2. Provide a Claude token (or paste it later in the dashboard Settings page)
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"   # see Authentication

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
- **Auth = a Claude Code OAuth token** — set once (dashboard Settings or
  `CLAUDE_CODE_OAUTH_TOKEN`) and injected into every agent (see Authentication).
- **Dashboard UI = HeroUI** — the dashboard uses HeroUI v3 (React, Tailwind-based)
  as its component library. The HeroUI MCP server is wired into project scope
  (`.mcp.json`) so component docs are available while building it.
- **Single-port gateway, proxy by path** — one published port fronts the fleet.
  The gateway routes `/a/:id/desktop` and `/a/:id/terminal` (HTTP + WebSocket) to
  each agent and serves the dashboard at `/`. Agents need **no host ports**, so
  the fleet scales without port collisions. The proxy resolves agents two ways
  (`GATEWAY_MODE`): **`network`** (by container name over `swarm-net`, used when
  the gateway is containerized — works on Linux and macOS) or **`ports`** (via
  Docker-assigned ephemeral host ports on `127.0.0.1`, for host-dev on macOS
  where a host process can't route to container DNS). Spawned agents are tagged
  with the stack's compose project so Docker UIs nest them under the dashboard.

## Authentication

Agents authenticate with a **Claude Code OAuth token** so sessions bill to your
Claude subscription. Generate one on any machine that has Claude Code:

```bash
claude setup-token        # prints an sk-ant-oat… token
```

Provide it either way:

- **Dashboard → Settings** — paste it; it's stored in the `gateway-data` volume
  and persists across restarts, **or**
- **`CLAUDE_CODE_OAUTH_TOKEN`** in `.env` (or the environment) before
  `docker compose up`.

The gateway injects the token into every agent as `CLAUDE_CODE_OAUTH_TOKEN`. It's
treated as a secret — the API only ever returns a masked hint (last 4 chars),
never the full value, and it's never committed to the repo. The token is
long-lived (~1 year); the dashboard shows an **expiry banner** ahead of time so
you can refresh it (`claude setup-token` again → paste).

> One token is shared across the fleet. That's fine for a personal swarm; if you
> later need stronger isolation, give agents separate tokens/keys.

## Running the stack

Normally you don't run agents by hand — the **gateway** creates them via
`dockerode` (the dashboard's **New agent** button, or `POST /api/agents`),
injecting the systemd flags and credential mount automatically. See
[Getting started](#getting-started) for the host-dev flow.

### Containerized (recommended) — `compose.yml`

The control plane runs as **one container** (gateway + Next.js UI) behind the
single `:8080` port — so the stack is just the dashboard plus each agent. The
gateway reaches agents **by name over `swarm-net`** in `network` mode — and
because container-to-container DNS works on both Linux and Docker Desktop for
Mac (only _host_-to-container is blocked on Mac), this path works everywhere.
Agents publish **no host ports**.

```bash
docker network create swarm-net 2>/dev/null || true   # shared, external network
docker compose up --build -d        # the dashboard container → http://localhost:8080
```

Then add your Claude token (dashboard **Settings**, or `CLAUDE_CODE_OAUTH_TOKEN`
in `.env`) and click **Build image** in the UI to build the agent runtime. See
[Quick start](#quick-start) for the full first-run walkthrough.

Spawned agents are tagged with this stack's compose project (`agent-swarm`), so
Docker UIs like **Portainer** nest them under the dashboard stack. (Because they
aren't in `compose.yml`, `docker compose down` treats them as orphans — use the
dashboard's **Remove**, or `docker compose down --remove-orphans`, to tear the
fleet down.)

> **Host-path gotcha:** the gateway runs in a container, but the per-agent home
> disks it bind-mounts are resolved by the **host** Docker daemon. `compose.yml`
> sets `SWARM_DATA_HOST=${PWD}/.swarm_data` (a host path) and mounts that same
> tree into the gateway at `/swarmdata`, so both see the same files. Keep those
> two in sync if you customize them.

### Host-dev (fast reload)

For hot-reload while developing, run the gateway + dashboard on the host instead
(see [Getting started](#getting-started)). Here the gateway uses **`ports` mode**
— each agent gets a Docker-assigned ephemeral host port and the host-run gateway
proxies to `127.0.0.1:<port>` — because a host process on Mac can't reach
container DNS names.

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
  -e CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  -p 6080:6080 -p 7681:7681 \
  agent-swarm/agent:dev
```

- **Desktop:** http://localhost:6080/ — GNOME over noVNC (scale-to-fit, locked 1080p)
- **Terminals:** http://localhost:7681/ — xterm.js; the first tab is the always-on `claude`

</details>

## Upgrading live agents

An agent has a **soft layer** that can be updated in place — the terminal
supervisor (`/opt/agent-runtime`), the statusLine script, Claude `settings.json`,
and the noVNC page — and a **hard layer** (base image: GNOME, systemd, apt
packages) that still needs a rebuilt image + recreate.

The gateway ships **numbered, ordered migrations** ([`apps/gateway/src/migrations.ts`](apps/gateway/src/migrations.ts))
that bring the soft layer up to date **without recreating** the container. Each
agent records the highest applied version in `/opt/agent-runtime/.swarm-version`;
the dashboard shows an **Upgrade** button when an agent is behind, and applying
it runs the pending migrations in order (restarting the terminal supervisor —
and thus the always-on `claude` session, whose transcript persists).

```bash
# status (installed vs latest, + pending migrations)
curl localhost:8080/api/agents/<id>/upgrade
# run pending migrations against the live agent
curl -X POST localhost:8080/api/agents/<id>/upgrade
```

**To add an upgrade:** append one entry to `migrations.ts` with the next integer
`version`, a `name`, and an `apply` using the `putDir` / `putFile` / `exec`
helpers. Ship any new files under `images/agent/` (the bundled build context).
Keep `apply` idempotent and forward-only. The full contract + recipe is
documented at the top of `migrations.ts`. Changes that need new apt packages or
base-image edits are hard-layer — put them in `images/agent/Dockerfile` and
build a new image instead.

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
