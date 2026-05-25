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
   config, watch and drive the live session (xterm.js terminal), start/stop/delete.
2. **Control plane (orchestrator)** — backend API that owns agent lifecycle.
   Talks **directly to the Docker engine** to run containers, injects
   config/secrets, relays the session stream, and persists agent state.
3. **Agent runtime (data plane)** — the container image. A thin supervisor
   spawns a normal `claude` CLI session in a **pty (node-pty)** and relays
   terminal I/O up to the control plane.

A fourth plane — **Swarm services** (shared MCP servers for messaging, memory,
and tools) — is planned but out of scope for now; the structure leaves room for
it.

```
        ┌──────────────┐      REST + WebSocket      ┌────────────────────┐
        │  Dashboard   │ ─────────────────────────► │   Control Plane    │
        │  (xterm.js)  │ ◄───────────────────────── │   (orchestrator)   │
        └──────────────┘   live terminal stream     └─────────┬──────────┘
                                                               │ Docker engine API
                                                               │ (socket)
                                                               ▼
                    ┌──────────────────────────────────────────────────────┐
                    │                  Agent Containers                     │
                    │  ┌────────────┐  ┌────────────┐  ┌────────────┐       │
                    │  │ supervisor │  │ supervisor │  │ supervisor │  ...  │
                    │  │ (node-pty) │  │ (node-pty) │  │ (node-pty) │       │
                    │  │ + `claude` │  │ + `claude` │  │ + `claude` │       │
                    │  └────────────┘  └────────────┘  └────────────┘       │
                    └──────────────────────────────────────────────────────┘
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
│   ├── dashboard/            # Web UI (Next.js + React + xterm.js terminal)
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
│   ├── shared/               # Shared TS types & API contracts (single source of truth)
│   │   └── src/
│   │
│   └── agent-runtime/        # Supervisor that runs *inside* each agent container
│       ├── src/              # spawns `claude` in a node-pty, relays terminal I/O
│       └── package.json
│
├── images/
│   └── agent/                # Container image for an agent
│       ├── Dockerfile        # base + Claude Code CLI + agent-runtime supervisor
│       └── entrypoint.sh
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

| Path                     | Responsibility                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `apps/dashboard`         | Operator UI: agent list, create/config forms, live xterm.js terminal, controls.         |
| `apps/control-plane`     | The brain. Owns the agent lifecycle state machine; drives the Docker engine.            |
| `apps/swarm-services`    | _(planned)_ shared MCP servers — messaging, memory, custom tools.                       |
| `packages/shared`        | Types/DTOs shared by dashboard ↔ control plane ↔ runtime to stay in sync.               |
| `packages/agent-runtime` | In-container supervisor: spawns the `claude` session in a pty, relays terminal I/O.     |
| `images/agent`           | The Dockerfile that bakes the Claude Code CLI + the supervisor into one runnable image. |
| `infra`                  | How it all gets stood up locally (docker-compose).                                      |

---

## Core concepts

- **Agent** — a logical unit: name, config, workspace, and lifecycle state
  (`creating → running → idle → stopped → deleted`). Backed by one container.
- **Agent config** — model, system prompt, allowed tools, env/secrets, resource
  limits, and the workspace it operates on.
- **Session** — the live `claude` CLI process inside an agent, spawned in a
  pseudo-terminal via **node-pty**. The supervisor relays its terminal stream up
  to the control plane, which fans it out to the dashboard's **xterm.js**
  terminal; keystrokes flow back down the same path for interactive control.
- **Docker driver** — thin wrapper over the Docker engine API (`create`,
  `start`, `stop`, `remove`, `attach`, `logs`) — the Portainer-style mechanism
  for managing the fleet on a single host.
- **Swarm layer** _(planned)_ — shared MCP servers that will give agents
  messaging, continuous memory, and custom tools. See below.

---

## Proposed tech stack

| Layer                   | Choice                                                  | Why                                                        |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| Dashboard               | Next.js + React + Tailwind + xterm.js                   | Fast to build; xterm.js renders the live session terminal. |
| Control plane           | Node + TypeScript (Fastify)                             | Shares types with the UI via `packages/shared`.            |
| Docker access           | `dockerode` over the engine socket                      | Direct container control, Portainer-style.                 |
| Agent runtime           | TS supervisor + node-pty spawning the real `claude` CLI | A normal Claude Code session in a pty, not the SDK.        |
| Persistence             | Postgres (agent state) + object store (logs/artifacts)  | Durable state; cheap blob storage.                         |
| Transport               | REST for control, WebSocket for live session streams    | Standard, dashboard-friendly.                              |
| Monorepo                | pnpm workspaces (+ Turborepo optional)                  | Single-version-policy, fast incremental builds.            |
| Swarm layer _(planned)_ | TS MCP servers over HTTP/SSE                            | Remote transport so all agents share one source of state.  |

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
- **Live session = node-pty + xterm.js** — supervisor spawns `claude` in a
  pty (node-pty) and relays it; dashboard renders with xterm.js. Built
  interactive-capable, since it's a small step beyond read-only.
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

```

```
