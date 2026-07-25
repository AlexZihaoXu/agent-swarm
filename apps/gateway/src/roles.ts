// Global role registry. Roles are reusable {name, description} records agents
// can be assigned; the description is what an agent reads to understand the
// role. Persisted to config.rolesFile (in the gateway-data volume).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import type { Capability, Role } from './types.js';

/** Catalog of special capabilities a role can grant, with human-readable copy
 *  for the role editor + the agent's roles.md doc. `mcpHelp` is the exact
 *  behavior of the agent-side MCP tool that capability unlocks — surfaced in
 *  the dashboard's "?" popover next to each switch so the operator can read,
 *  before flipping, what the agent will actually be able to do. */
export const CAPABILITIES: {
  key: Capability;
  label: string;
  description: string;
  mcpHelp: string;
}[] = [
  {
    key: 'manage_agents',
    label: 'Manage agents',
    description: 'Start and stop other agents in the swarm (cannot remove them).',
    mcpHelp:
      "Tool: swarm_manage_agent(agent, action). `agent` = the peer's id or display name; `action` = 'start' or 'stop'. The gateway resolves the peer, verifies you share a group, and dispatches docker start/stop on its container. Scope: peers only — you can't manage yourself or agents you don't share a group with. The agent's persistent disk is untouched; removing an agent is operator-only.",
  },
  {
    key: 'view_screen',
    label: 'View screens',
    description: "Capture and view another agent's live screen image.",
    mcpHelp:
      "Tool: swarm_view_agent(agent). Captures the peer's noVNC desktop as a JPEG, writes it into your ~/.swarm/views/<peer>-<ts>.jpg, and returns the path so you can Read it. Scope: peers in a shared group. No side effect on the peer beyond a brief X server screenshot grab.",
  },
  {
    key: 'compact_agents',
    label: 'Compact agents',
    description: 'Trigger context compaction (/compact) on other agents that share a group.',
    mcpHelp:
      "Tool: swarm_compact_agent(agent). Runs Claude Code's native /compact slash command on the peer (Esc + /compact + Enter, interrupting any mid-turn). Debounced 90s per peer to avoid pile-up. Scope: peers in a shared group. The peer's transcript is preserved; only its context is compacted.",
  },
  {
    key: 'view_stats',
    label: 'Read agent stats',
    description:
      "Read other agents' live stats (context-window usage, tokens, activity) for agents that share a group.",
    mcpHelp:
      "Tool: swarm_agent_stats(agent). Returns the peer's current model, status (idle/busy/waiting), context-window fill, total tokens (input/output/cache), and last activity timestamp. Read-only. Scope: peers in a shared group.",
  },
  {
    key: 'dashboard_alerts',
    label: 'Dashboard usage alerts',
    description:
      'Read the swarm dashboard usage (5h/7d rate-limit windows, tokens, cost) and receive proactive warnings when usage is projected to hit 100% or actually reaches 90% of a window.',
    mcpHelp:
      'Tool: swarm_dashboard_usage(). Returns the current 5h + 7d rate-limit windows (used %, projected %, reset time) and the 12h token/cost totals across the swarm. Read-only. Also makes you eligible for proactive sys://usage warnings the gateway pushes when a window is projected to hit 100% or actually reaches 90%.',
  },
  {
    key: 'toggle_desktop',
    label: 'Toggle own desktop',
    description:
      "Turn this agent's own GNOME + noVNC desktop on or off (e.g., to free ~2 GB RSS when not needed).",
    mcpHelp:
      "Tool: swarm_toggle_desktop(enabled). `enabled` = true to bring the GNOME + noVNC stack up, false to stop it (saves ~2 GB RSS — gnome-shell, mutter, chrome, etc.). Scope: self only — you can't toggle a peer's desktop. The change takes effect immediately via systemctl start/stop tigervncserver@:1 novnc, and the marker on disk also gates the next boot. Your claude TUI session keeps running through the toggle.",
  },
  {
    key: 'set_effort',
    label: 'Set own reasoning effort',
    description:
      "Change this agent's own reasoning-effort level at runtime — including turning on ultracode for a hard task, and turning it back down when done. Scope: self only.",
    mcpHelp:
      "Tool: swarm_set_effort(effort). `effort` = one of low, medium, high, xhigh, max, ultracode, or default (clears the override). Runs Claude Code's `/effort <level>` slash command in your own TUI, so it applies to your very next turn — no restart. The level is also persisted to your identity, so it survives a session respawn instead of silently reverting. Scope: self only — you can never change a peer's effort. Ultracode means max effort plus multi-agent Workflow orchestration: it is substantially slower and burns far more tokens, and it wants headroom beyond the default 2-core / 4 GB agent, so switch to it deliberately for genuinely hard work and drop back down afterwards.",
  },
  {
    key: 'restart_self',
    label: 'Restart self',
    description:
      'Restart its own agent (stop → start) to apply pending settings — e.g. its refreshed guidance (CLAUDE.md) or auto-compact threshold. Scope: self only.',
    mcpHelp:
      "Tool: swarm_restart_self(). Restarts the agent's OWN container (a deferred stop → start, so the tool's reply reaches you first). The boot re-provisions on-disk state — your own guidance (~/.claude/CLAUDE.md), roles doc, auth/swarm tokens — reconnects integrations, and resumes your claude session via `--continue` so the transcript is preserved. Scope: self only — you can never restart a peer. Use it after swarm_append_guidance, or when the operator changes a setting that needs a restart. Takes ~10-20s of downtime while the container reboots.",
  },
];

const CAPABILITY_KEYS = new Set<string>(CAPABILITIES.map((c) => c.key));

/** Drop unknown/duplicate capability keys from a permissions list. */
function cleanPermissions(perms: unknown): Capability[] {
  if (!Array.isArray(perms)) return [];
  return [...new Set(perms.filter((p): p is Capability => CAPABILITY_KEYS.has(p as string)))];
}

/** Whether any of the given roles grants a capability (the effective check). */
export function rolesGrant(roleIds: string[], cap: Capability): boolean {
  return getRoles(roleIds).some((r) => r.permissions?.includes(cap));
}

/** name → stable slug id (lowercase, hyphenated, alnum). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'role'
  );
}

export function listRoles(): Role[] {
  try {
    const raw = JSON.parse(readFileSync(config.rolesFile, 'utf8')) as Role[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeRoles(roles: Role[]): void {
  mkdirSync(dirname(config.rolesFile), { recursive: true });
  writeFileSync(config.rolesFile, JSON.stringify(roles, null, 2));
}

export function getRoles(ids: string[]): Role[] {
  const by = new Map(listRoles().map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((r): r is Role => !!r);
}

/** Create a role (unique id; if the slug collides, suffix it). */
export function createRole(
  name: string,
  description: string,
  now: number,
  permissions?: unknown,
): Role {
  const trimmed = name.trim();
  if (!trimmed) throw Object.assign(new Error('role name required'), { statusCode: 400 });
  const roles = listRoles();
  let id = slugify(trimmed);
  if (roles.some((r) => r.id === id)) {
    let n = 2;
    while (roles.some((r) => r.id === `${id}-${n}`)) n++;
    id = `${id}-${n}`;
  }
  const role: Role = {
    id,
    name: trimmed,
    description: description.trim(),
    permissions: cleanPermissions(permissions),
    createdAt: now,
  };
  roles.push(role);
  writeRoles(roles);
  return role;
}

export function updateRole(
  id: string,
  patch: { name?: string; description?: string; permissions?: unknown },
): Role {
  const roles = listRoles();
  const role = roles.find((r) => r.id === id);
  if (!role) throw Object.assign(new Error('role not found'), { statusCode: 404 });
  if (patch.name !== undefined && patch.name.trim()) role.name = patch.name.trim();
  if (patch.description !== undefined) role.description = patch.description.trim();
  if (patch.permissions !== undefined) role.permissions = cleanPermissions(patch.permissions);
  writeRoles(roles);
  return role;
}

export function deleteRole(id: string): void {
  writeRoles(listRoles().filter((r) => r.id !== id));
}
