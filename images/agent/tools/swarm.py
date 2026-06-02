#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Swarm agent-communication MCP server.

Lets an agent talk to the other agents in the same swarm. Sending posts to the
gateway, which injects the message into the target agent's terminal as
`[swarm://<sender>] <text>` — the target replies with its own swarm_send.

A minimal Model Context Protocol stdio server (JSON-RPC 2.0 over stdin/stdout,
newline-delimited), stdlib only — no SDK, no deps. Register with:
  uv run /opt/agent-tools/swarm.py   (env SWARM_GATEWAY, SWARM_IDENTITY)
"""

import json
import os
import sys
import urllib.error
import urllib.request

PROTOCOL_VERSION = "2024-11-05"
GATEWAY = os.environ.get("SWARM_GATEWAY", "http://dashboard:8080").rstrip("/")
IDENTITY_FILE = os.environ.get(
    "SWARM_IDENTITY", os.path.expanduser("~/.swarm/identity.json")
)
# Shared token the gateway writes to our disk, presented so our machine-to-machine
# calls pass the operator-login gate. Read fresh each call (it can rotate).
TOKEN_FILE = os.environ.get(
    "SWARM_TOKEN_FILE", os.path.expanduser("~/.swarm/gateway-token")
)


def _token() -> str:
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except Exception:
        return ""


def _identity() -> dict:
    try:
        with open(IDENTITY_FILE) as f:
            d = json.load(f)
        return {
            "id": d.get("id"),
            "name": d.get("name") or d.get("id"),
            "groups": d.get("groups") or [],
        }
    except Exception:
        return {"id": None, "name": None, "groups": []}


def _shares_group(mine: list, theirs: list) -> bool:
    # Mirrors the gateway: share a group, or both ungrouped.
    if not mine and not theirs:
        return True
    return any(g in theirs for g in mine)


def _http(method: str, path: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"content-type": "application/json"}
    token = _token()
    if token:
        headers["x-swarm-token"] = token
    req = urllib.request.Request(GATEWAY + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as r:
        raw = r.read().decode()
    return json.loads(raw) if raw else None


def _ok(data) -> dict:
    text = data if isinstance(data, str) else json.dumps(data, indent=2)
    return {"content": [{"type": "text", "text": text}]}


def _err(msg: str) -> dict:
    return {"content": [{"type": "text", "text": f"Error: {msg}"}], "isError": True}


def whoami(_args: dict) -> dict:
    return _ok(_identity())


def list_agents(_args: dict) -> dict:
    me = _identity()
    try:
        agents = _http("GET", "/api/agents") or []
    except Exception as e:  # noqa: BLE001
        return _err(f"could not reach the swarm: {e}")
    # Only peers that share a group with you (or are also ungrouped) are reachable.
    out = [
        {"id": a.get("id"), "name": a.get("username") or a.get("id"), "status": a.get("status")}
        for a in agents
        if a.get("id") != me["id"] and _shares_group(me["groups"], a.get("groups") or [])
    ]
    return _ok(out)


def send(args: dict) -> dict:
    to = str(args.get("to") or "").strip()
    text = str(args.get("text") or "").strip()
    if not to or not text:
        return _err("'to' (agent id or name) and 'text' are required")
    me = _identity()
    try:
        _http(
            "POST",
            "/api/swarm/send",
            {"fromId": me["id"], "from": me["name"] or me["id"] or "agent", "to": to, "text": text},
        )
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    return _ok(f"sent to {to}")


def send_file(args: dict) -> dict:
    to = str(args.get("to") or "").strip()
    path = str(args.get("path") or "").strip()
    note = str(args.get("note") or "").strip()
    if not to or not path:
        return _err("'to' (agent id or name) and 'path' are required")
    me = _identity()
    try:
        r = _http(
            "POST",
            "/api/swarm/send-file",
            {
                "fromId": me["id"],
                "fromName": me["name"] or me["id"] or "agent",
                "to": to,
                "path": path,
                "note": note,
            },
        )
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    return _ok(f"sent file to {to} → {(r or {}).get('path', '?')}")


def list_groups(_args: dict) -> dict:
    me = _identity()
    mine = set(me.get("groups") or [])
    if not mine:
        return _ok("You're not in any group. Group chat is unavailable until you're added to one.")
    try:
        groups = _http("GET", "/api/groups") or []
    except Exception as e:  # noqa: BLE001
        return _err(f"could not reach the swarm: {e}")
    out = [
        {"id": g.get("id"), "name": g.get("name"), "description": g.get("description")}
        for g in groups
        if g.get("id") in mine
    ]
    return _ok(out)


def send_group(args: dict) -> dict:
    group = str(args.get("group") or "").strip()
    text = str(args.get("text") or "").strip()
    if not group or not text:
        return _err("'group' (id or name) and 'text' are required")
    me = _identity()
    try:
        _http(
            "POST",
            "/api/swarm/group-send",
            {
                "fromId": me["id"],
                "fromName": me["name"] or me["id"] or "agent",
                "group": group,
                "text": text,
            },
        )
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    return _ok(f"sent to group {group} (your groupmates will receive it; you won't get a copy)")


def manage_agent(args: dict) -> dict:
    to = str(args.get("to") or "").strip()
    action = str(args.get("action") or "").strip().lower()
    if not to or action not in ("start", "stop"):
        return _err("'to' (agent id or name) and 'action' ('start' or 'stop') are required")
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/manage", {"fromId": me["id"], "to": to, "action": action})
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    agent = (r or {}).get("agent") or {}
    return _ok(f"{action}ed {to} (now: {agent.get('status', '?')})")


def view_agent(args: dict) -> dict:
    to = str(args.get("to") or "").strip()
    if not to:
        return _err("'to' (agent id or name) is required")
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/view", {"fromId": me["id"], "to": to})
    except urllib.error.HTTPError as e:
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    path = (r or {}).get("path", "?")
    return _ok(f"captured {to}'s screen → {path} (use Read to view the image)")


def compact_agent(args: dict) -> dict:
    to = str(args.get("agent") or "").strip()
    if not to:
        return _err("'agent' (id or name) is required")
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/compact", {"fromId": me["id"], "to": to})
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return _err(
                "your role lacks the 'compact agents' capability (or you don't share a "
                "group with them) — ask the operator to grant it to one of your roles."
            )
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    name = (r or {}).get("name", to)
    return _ok(f"ran /compact on {name} (its context window is being compacted now)")


def toggle_desktop(args: dict) -> dict:
    raw = args.get("enabled")
    if isinstance(raw, str):
        enabled = raw.strip().lower() in ("true", "1", "yes", "on")
    elif isinstance(raw, bool):
        enabled = raw
    else:
        return _err("'enabled' (bool) is required: true to turn the desktop ON, false to turn it OFF")
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/desktop", {"fromId": me["id"], "desktop": enabled})
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return _err(
                "your role lacks the 'toggle own desktop' capability — ask the operator to grant "
                "it to one of your roles."
            )
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    state = "ON" if (r or {}).get("desktop") else "OFF"
    return _ok(
        f"desktop is now {state}. "
        + (
            "The GNOME + noVNC stack is running again."
            if enabled
            else "The GNOME + noVNC stack is stopped — saves ~2 GB RSS. Your claude TUI is unaffected."
        )
    )


def agent_stats(args: dict) -> dict:
    to = str(args.get("agent") or "").strip()
    if not to:
        return _err("'agent' (id or name) is required")
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/stats", {"fromId": me["id"], "to": to})
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return _err(
                "your role lacks the 'read agent stats' capability (or you don't share a "
                "group with them) — ask the operator to grant it to one of your roles."
            )
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    d = r or {}
    if d.get("error"):
        return _err(f"could not read {d.get('name', to)}'s stats: {d['error']}")
    ctx = d.get("context")
    limit = d.get("contextLimit")
    pct = d.get("contextPct")
    ctx_line = "context: unknown"
    if pct is not None:
        ctx_line = f"context: {pct}% ({ctx:,} / {limit:,} tokens)"
    elif ctx is not None:
        ctx_line = f"context: {ctx:,} tokens (limit unknown)"
    tokens = d.get("tokens")
    lines = [
        f"{d.get('name', to)}:",
        f"  status: {d.get('status') or 'unknown'}",
        f"  model: {d.get('model') or 'default'}",
        f"  {ctx_line}",
        f"  total tokens: {tokens:,}" if tokens is not None else "  total tokens: unknown",
    ]
    return _ok("\n".join(lines))


def _resets_in(at_ms) -> str:
    # Mirror the gateway/dashboard "resets in …" label (at_ms is epoch ms).
    try:
        import time

        ms = float(at_ms) - time.time() * 1000
    except Exception:  # noqa: BLE001
        return "?"
    if ms <= 0:
        return "imminently"
    h = ms / 3_600_000
    if h < 1:
        return f"in {round(ms / 60_000)}m"
    if h < 24:
        return f"in {round(h)}h"
    return f"in {round(h / 24)}d"


def swarm_usage(_args: dict) -> dict:
    me = _identity()
    try:
        r = _http("POST", "/api/swarm/usage", {"fromId": me["id"]})
    except urllib.error.HTTPError as e:
        if e.code == 403:
            return _err(
                "you don't have the dashboard_alerts capability — ask the operator to "
                "grant it to one of your roles to read usage."
            )
        return _err(f"HTTP {e.code}: {e.read().decode()[:200]}")
    except Exception as e:  # noqa: BLE001
        return _err(str(e))
    data = r or {}
    rl = data.get("rateLimits")
    lines = []
    if rl:
        for key, label in (("fiveHour", "5h window"), ("sevenDay", "7d window")):
            w = rl.get(key) or {}
            used = round(float(w.get("usedPercent") or 0))
            proj = round(float(w.get("projected") or 0))
            when = _resets_in(w.get("resetsAt"))
            lines.append(f"{label}: {used}% used (~{proj}% projected, resets {when})")
    else:
        lines.append("Rate-limit windows: no data yet (no recent API activity).")
    totals = data.get("totals") or {}
    hours = totals.get("windowHours", 12)
    tokens = totals.get("tokens") or 0
    cost = totals.get("cost") or 0
    lines.append(f"Last {hours}h: {tokens:,} tokens · ${cost:.2f}")
    return _ok("\n".join(lines))


TOOLS = [
    ("swarm_whoami", "Your own identity (id + name) within the swarm.", {}, [], whoami),
    (
        "swarm_list_agents",
        "List the other agents in the swarm (id, name, status) you can message.",
        {},
        [],
        list_agents,
    ),
    (
        "swarm_send",
        "Send a message to another agent in the swarm. It arrives in their terminal "
        "as [swarm://you]; they reply with their own swarm_send. Target by agent id or name.",
        {
            "to": {"type": "string", "description": "Target agent id or display name"},
            "text": {"type": "string", "description": "The message to send"},
        },
        ["to", "text"],
        send,
    ),
    (
        "swarm_send_file",
        "Send a file to another agent. The file must be under your home (~/...); it "
        "lands in their ~/.swarm/shared-inbox/ and they're notified with the path. "
        "Target by agent id or name.",
        {
            "to": {"type": "string", "description": "Target agent id or display name"},
            "path": {"type": "string", "description": "Path to a file under your home"},
            "note": {"type": "string", "description": "Optional message to send with it"},
        },
        ["to", "path"],
        send_file,
    ),
    (
        "swarm_list_groups",
        "List the groups you belong to (id, name, description). Group chat and "
        "swarm comms are scoped to these groups.",
        {},
        [],
        list_groups,
    ),
    (
        "swarm_send_group",
        "Send a message to one of your groups' chat. Every OTHER agent in the group "
        "receives it (you don't get a copy — you just sent it); the human operator "
        "sees it in the dashboard too. Messages you receive arrive as "
        "[group://<name>]. Target the group by id or name.",
        {
            "group": {"type": "string", "description": "Group id or name (must be one you're in)"},
            "text": {"type": "string", "description": "The message to broadcast to the group"},
        },
        ["group", "text"],
        send_group,
    ),
    (
        "swarm_manage_agent",
        "Start or stop another agent. Requires a role with the 'manage agents' "
        "permission, and only works on agents in your group (403 otherwise). You "
        "can never remove an agent. Target by agent id or name.",
        {
            "to": {"type": "string", "description": "Target agent id or display name"},
            "action": {"type": "string", "enum": ["start", "stop"], "description": "What to do"},
        },
        ["to", "action"],
        manage_agent,
    ),
    (
        "swarm_view_agent",
        "Capture another agent's live screen as an image saved to your "
        "~/.swarm/views/ (Read it to see what they're doing). Requires a role with "
        "the 'view screens' permission, and only works on agents in your group "
        "(403 otherwise). Target by agent id or name.",
        {
            "to": {"type": "string", "description": "Target agent id or display name"},
        },
        ["to"],
        view_agent,
    ),
    (
        "swarm_compact_agent",
        "Run Claude Code's /compact on another agent to shrink its context window "
        "when it's getting full. Requires a role with the 'compact agents' "
        "permission, and only works on agents in your group (403 otherwise). "
        "Target by agent id or name.",
        {
            "agent": {"type": "string", "description": "Target agent id or display name"},
        },
        ["agent"],
        compact_agent,
    ),
    (
        "swarm_agent_stats",
        "Read another agent's live stats: its session status, model, context-window "
        "usage (% full + tokens), and total tokens. Useful to decide whether to "
        "swarm_compact_agent them. Requires a role with the 'read agent stats' "
        "permission, and only works on agents in your group (403 otherwise). "
        "Target by agent id or name.",
        {
            "agent": {"type": "string", "description": "Target agent id or display name"},
        },
        ["agent"],
        agent_stats,
    ),
    (
        "swarm_usage",
        "Read the swarm's current usage: the 5h and 7d rate-limit windows "
        "(used % + projected % at the current burn rate + when each resets) plus "
        "the last 12h total tokens and cost. Requires a role with the 'dashboard "
        "usage alerts' permission (403 otherwise). No arguments.",
        {},
        [],
        swarm_usage,
    ),
    (
        "swarm_toggle_desktop",
        "Turn YOUR OWN GNOME + noVNC desktop on or off. Off saves ~2 GB of RSS "
        "(gnome-shell, mutter, chrome). On brings the desktop back so it's reachable "
        "via the dashboard's Desktop tab. Takes effect immediately (systemctl "
        "start|stop tigervncserver@:1 + novnc) and persists across restarts via a "
        "marker file. Your claude TUI keeps running through the toggle. "
        "Self-only — cannot toggle a peer's desktop. Requires a role with the "
        "'toggle own desktop' permission (403 otherwise).",
        {
            "enabled": {
                "type": "boolean",
                "description": "true = turn the desktop ON, false = turn the desktop OFF",
            },
        },
        ["enabled"],
        toggle_desktop,
    ),
]
HANDLERS = {name: fn for name, _d, _p, _r, fn in TOOLS}


def _specs() -> list[dict]:
    return [
        {
            "name": n,
            "description": de,
            "inputSchema": {"type": "object", "properties": p, **({"required": r} if r else {})},
        }
        for n, de, p, r, _fn in TOOLS
    ]


def _send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _handle(msg: dict) -> None:
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL_VERSION
        _send(
            {
                "jsonrpc": "2.0",
                "id": mid,
                "result": {
                    "protocolVersion": ver,
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "swarm", "version": "0.1.0"},
                },
            }
        )
    elif method == "ping":
        _send({"jsonrpc": "2.0", "id": mid, "result": {}})
    elif method == "tools/list":
        _send({"jsonrpc": "2.0", "id": mid, "result": {"tools": _specs()}})
    elif method == "tools/call":
        params = msg.get("params") or {}
        fn = HANDLERS.get(params.get("name"))
        if not fn:
            _send(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "error": {"code": -32602, "message": f"unknown tool {params.get('name')}"},
                }
            )
            return
        try:
            result = fn(params.get("arguments") or {})
        except Exception as e:  # noqa: BLE001
            result = _err(f"{type(e).__name__}: {e}")
        _send({"jsonrpc": "2.0", "id": mid, "result": result})
    elif method and method.startswith("notifications/"):
        pass
    elif mid is not None:
        _send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"method not found: {method}"}})


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            _handle(json.loads(line))
        except json.JSONDecodeError:
            continue
        except Exception:  # noqa: BLE001 — never let one bad message kill the server
            pass


if __name__ == "__main__":
    main()
